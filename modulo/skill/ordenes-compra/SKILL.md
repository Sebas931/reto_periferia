---
name: ordenes-compra
description: Proceso de órdenes de compra de Periferia — matriz de controles RC1–RC10, maestros, estructura de la OC en SAP y archivos de control. Úsalo al procesar solicitudes de compra.
---
<!-- Generado por scripts/generar-modulo.ts. No editar: modificar la fuente y correr `npm run modulo`. -->

# Proceso de órdenes de compra — conocimiento del agente

## Contexto

Cada compra llega a administración por correo con tres piezas: la solicitud (Excel), la cotización del proveedor (PDF) y el correo de aprobación del líder. La analista crea la OC en SAP con proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta la aprobación en PDF como evidencia.

Hallazgo conocido: muchas OC se crean **después** de que llega la factura, sin pasar por cotización ni aprobación previa. La dirección quiere medirlo; por eso toda OC retroactiva queda marcada `retroactiva = true` en `out/control.csv`.

## Actores

| Actor | Qué hace |
|---|---|
| Solicitante | Envía el paquete. Corrige datos de la solicitud cuando hay bloqueos. |
| Líder aprobador | Aprueba por correo ("Aprobado"). Debe estar registrado en el centro de costo y tener tope suficiente. |
| Analista administrativa | Conversa con el agente, confirma excepciones. |
| Compras / maestros | Crea o reactiva proveedores en SAP. |
| Contabilidad / auditoría | Consume `out/control.csv` y las evidencias. |

## Matriz de controles

| Código | Control | Tipo | Qué hacer si falla |
|---|---|---|---|
| RC1 | El proveedor existe (por NIT; sin NIT, por nombre) y está activo. | Bloqueo | Pedir a compras crear o reactivar el proveedor y reprocesar. |
| RC2 | Hay aprobación, contiene "Aprobado" y viene de un aprobador del centro de costo. | Bloqueo | Pedir la aprobación a un aprobador del centro con tope suficiente. Si nadie tiene tope, escalar a la dirección financiera. |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo | Pedir aprobación a un aprobador de mayor tope o escalar. Si RC2 falla, RC3 queda "no evaluable". |
| RC4 | La subárea pertenece al centro de costo (y el centro existe). | Bloqueo | Pedir al solicitante corregir centro o subárea. |
| RC5 | La cotización difiere de la solicitud en ≤ 2 %. Sin cotización también se confirma. | Confirmación | Mostrar ambos valores y la diferencia; la analista decide. |
| RC6 | Indicador de IVA informado. Si falta, se deriva del proveedor. Un código inexistente bloquea. | Confirmación + derivado | Mostrar el indicador propuesto y si coincide con el IVA de la cotización. |
| RC7 | Condiciones de pago informadas. Si faltan, se derivan del proveedor. Un código inexistente bloquea. | Derivado (informativo) | Informar el valor derivado. |
| RC8 | Si hay factura con fecha anterior a la solicitud, la OC es retroactiva. | Confirmación | Advertir que la compra ocurrió antes de la OC; si se confirma, queda marcada en control. |
| RC9 | La aprobación es de la misma fecha de la solicitud o posterior. | Confirmación | Mostrar ambas fechas. |
| RC10 | Cantidad × valor unitario = valor total (± 1). | Bloqueo | Pedir al solicitante corregir los valores. |

Reglas de decisión:
- `apta = true` si no hay ningún bloqueo.
- Una OC apta **sin** confirmaciones se crea directamente.
- Una OC apta **con** confirmaciones se crea solo tras la confirmación explícita de la analista.
- Crear dos veces la misma solicitud devuelve la OC existente (idempotencia); nunca se duplica.

## Maestros

- **Indicadores de IVA**: C0 excluido o no gravado (0 %), C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 pago inmediato, Z015 15 días, Z030 30 días, Z060 60 días fecha factura.
- **Centros de costo**: CC-1010 Tecnología (Infraestructura, Soporte, Desarrollo), CC-2020 Administración (Compras, Servicios Generales), CC-3030 Comercial (Preventa, Marketing). Los aprobadores y topes se consultan siempre en las herramientas; no los recites de memoria.

## La OC en SAP

- Sociedad 1000 y organización de compras 1000.
- Una posición (10) por solicitud. El texto breve tiene un máximo de 40 caracteres; si la descripción es más larga se trunca y la trazabilidad guarda el original.
- Unidad: H si la compra se expresa en horas, MES si es por mensualidad, UN en el resto.
- El precio unitario es el de la solicitud. La cotización se usa como control (RC5), no como fuente del precio.
- La evidencia de aprobación (`aprobacion.txt` y `aprobacion.pdf`) lleva el sha256 del contenido. El mismo hash queda en `aprobador.evidencia_sha256` de la OC.

## Archivos que produce el proceso

| Archivo | Contenido |
|---|---|
| `out/<caso>/payload.json` | La OC tal como se envía a SAP. |
| `out/<caso>/trazabilidad.json` | Fuente de cada valor: solicitud, cotización, correo, aprobación, maestro.proveedores, constante o derivado. |
| `out/<caso>/aprobacion.txt` y `.pdf` | Evidencia con sha256. |
| `out/<caso>/oc.json` | Número y fecha de la OC creada. |
| `out/sap/ordenes.jsonl` | SAP simulado: OC desde la 4500000001. |
| `out/control.csv` | Un registro por cada intento de crear (creada, existente, bloqueada, pendiente de confirmación o error), con la marca de retroactiva. |
| `out/log.jsonl` | Todas las llamadas a herramientas. |
