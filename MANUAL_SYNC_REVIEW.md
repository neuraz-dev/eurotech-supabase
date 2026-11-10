# Revisión: historial de sincronizaciones manuales

## Alcance

La sección `/dashboard/sincronizaciones` conserva ejecuciones manuales compartidas del Monitor. Cada ejecución tiene una página permanente, usuario, alcance, fechas, etapas y resultados por publicación. Las actualizaciones programadas siguen entrando directamente a sus funciones actuales y no crean ejecuciones manuales.

El botón general agrupa Propios → Catálogo → Rivales. También registran ejecuciones los botones del panel de producto, actualización de rivales y Seguimiento. Los endpoints manuales anteriores ahora devuelven HTTP 202 con `{ accepted, runId, url, run }`; sus consumidores internos observan el resultado persistido. `GET /api/sync-product?id=...` recupera los campos del producto después de la actualización.

No se reconstruyen logs de sincronizaciones anteriores. Las omisiones justificadas se separan de fallos. Un nombre de categoría, una conversión o evidencia de adjudicación que no se pueden actualizar pueden dejar advertencias; el precio confirmado no se oculta por ello.

## Cola y recuperación

- Migración aditiva `20261110002906_manual_sync_history.sql`: `ml_sync_runs`, `ml_sync_tasks`, `ml_sync_results`, índices, RLS y RPC restringidas a `service_role`.
- El dispatcher es la única función nueva con privilegios de definidor; no admite URL ni claves del solicitante, usa `search_path` vacío y obtiene exclusivamente sus dos secretos dedicados de Vault. El acceso anónimo/autenticado directo está revocado.
- El servidor registra la petición autenticada antes de encolar. La clave de solicitud se conserva para reintentar un inicio cuya respuesta se perdió; una restricción impide dos ejecuciones activas del mismo alcance.
- Tareas por lotes: 10 propios o 4 destinos de catálogo/rivales/Seguimiento. Cada trabajador procesa durante unos 20 segundos entre tareas y luego solicita otra invocación. Cron recupera trabajo pendiente cada minuto.
- Una tarea recibe un token de arrendamiento por 150 segundos. Su resultado y tareas hijas se confirman juntos en una transacción; un token anterior no puede confirmar resultados después de recuperarse la tarea. Se permiten tres reclamaciones tras interrupción; las consultas fallidas transitorias tienen hasta dos intentos dentro de una reclamación.
- Una ejecución sin progreso durante 20 minutos se cierra con fallos explícitos para sus destinos pendientes. Los resultados ya registrados se conservan. No hay eliminación automática del historial.
- La cola no cambia la semántica de precios, reglas, snapshots o archivo de alertas. La escritura rival conserva la operación atómica y revisiones existentes, por lo que reconsultar tras una interrupción no inventa otro evento.
- No se guardan tokens, cabeceras ni cuerpos externos completos. Los diagnósticos tienen redacción defensiva y tamaño limitado.

## Actualización coordinada posterior

Producción no se ha modificado. Merge y despliegue serán manuales.

1. Suspender temporalmente escrituras y botones de sincronización durante el cambio de versión. Esperar a que terminen los escritores anteriores.
2. Respaldar la base y aplicar la migración aditiva. No requiere modificar columnas de `ml_products` ni reescribir alertas.
3. Desplegar `ml-manual-sync` y las versiones coordinadas de `ml-sync`, `ml-sync-competitor` y `ml-scrape-tracked`, incluyendo `_shared` y el nuevo `ml-sync/service.ts`.
4. Configurar en Vault **monitor_manual_worker_url** con la URL de esta instancia terminada en `/functions/v1/ml-manual-sync`, y **monitor_manual_worker_key** con su credencial interna autorizada. No reutilizar URLs de otra instancia. La función valida su credencial interna; su configuración declara `verify_jwt = false` para permitir credenciales opacas además de JWT.
5. Desplegar el frontend. Un inicio sin configuración del dispatcher devuelve error; no presenta la operación como iniciada correctamente.
6. Reanudar escrituras y probar una sola publicación: HTTP 202, resultado persistido, enlace accesible y finalización sin depender del navegador. Revisar luego una ejecución general.

En revisión local los secretos apuntan únicamente a `http://kong:8000/functions/v1/ml-manual-sync` de `eurotech-monitor-improvements`. No se inició otra instancia ni se habilitaron cron históricos con destinos externos.

Para recuperar un despliegue fallido: suspender nuevos inicios, desactivar temporalmente `monitor-manual-sync-worker`, esperar a las invocaciones activas y conservar las tablas y resultados. Volver coordinadamente a funciones/frontend anteriores; no borrar ni resetear la copia real. Si se retoma la versión nueva, reactivar el dispatcher: las tareas pendientes se recuperarán o cerrarán con el motivo de interrupción. Después de 20 minutos sin progreso se requiere una nueva ejecución para volver a consultar los destinos pendientes.

## Evidencia local

- Respaldo privado: `.local-review/before-manual-sync-history.dmp` (ignorado, permisos 0600).
- Migración validada primero con rollback y aplicada únicamente en la instancia local existente.
- SQL de aceptación: `supabase/tests/manual_sync_history.sql`. Usa sólo tablas nuevas dentro de una transacción revertida: orden de etapas, exclusión de trabajadores simultáneos, idempotencia, arrendamiento vencido, interrupción y 20.050 resultados con 49 fallos conservados.
- Comprobación real normal: publicación propia MLU615514684, SKU 7270. La API negó acceso sin sesión (401), aceptó el inicio (202), conservó `runId` ante reenvío y el worker terminó sin ayuda del navegador: 1 actualizado, 0 fallidos. Identificador guardado privadamente en `.local-review/manual-sync-live-run.json`.
- No se ejecutaron fixtures destructivos sobre los productos, rivales o alertas restaurados. Las pruebas de interfaz usan API simulada y Auth local.

### Comandos de validación

```bash
npm --prefix frontend run test:manual-sync
npm --prefix frontend run test:sync-flow
npm --prefix frontend run test:sync
npm --prefix frontend run test:alerts
npm --prefix frontend run test:monitor
npm --prefix frontend run test:sources
python3 scripts/with-monitor-local.py npm --prefix frontend run test:events-ui
python3 scripts/with-monitor-local.py npm --prefix frontend run build
```

También se verifican TypeScript, Deno check/lint y ESLint de los archivos modificados. Las pruebas SQL deben ejecutarse con `ON_ERROR_STOP=1` y conservar su `ROLLBACK` final. No usar resets ni scripts de fixtures sobre la copia real.

### Resultado de la validación

- 8 casos nuevos de servicios en Node, 2 casos de inicio/mensajes, 4 casos Deno del sincronizador propio y 17 casos Playwright (8 nuevos + 9 existentes) aprobados.
- Regresión: 30 pruebas de sincronización rival, 16 de alertas, 13 del evaluador y 16 de resolución de fuentes aprobadas; consulta de catálogo y flujo manual también aprobados.
- Comparación del respaldo con las 20.831 alertas: todas las columnas de todas las filas iguales después del cambio.
- Conteos locales: 1.866 productos, 75 rivales, 75 asociaciones, 20.831 alertas. Tablas nuevas: 1 ejecución real, 2 tareas, 1 resultado y 0 ejecuciones pendientes. Los fixtures revertidos no dejaron filas.
- La migración queda registrada como aplicada en el historial de la instancia local. El número de secuencia de resultados puede tener huecos por las transacciones de prueba revertidas, sin registros sintéticos persistidos.

- ESLint de archivos modificados y Deno lint sin errores. El lint global mantiene dos errores previos de `react-hooks/set-state-in-effect`, ajenos a esta tarea: `frontend/src/app/auth/callback/page.tsx:17` y `frontend/src/app/login/page.tsx:25`.
- Supabase Database Advisors (seguridad, instancia local): sin incidencias.

- La navegación lateral limita su desplazamiento a su propia área para que el enlace nuevo no se superponga con los controles de sesión en pantallas de escritorio de poca altura.

## Corrección del recurso de productos propios (403)

El servicio propio ahora utiliza `/items/bulk?ids=…` en la actualización general, individual y programada. Lee `id`, `status_code` y `body`; mantiene lotes de hasta 20 destinos y la consulta autoritativa `/items/{id}/prices`. Un HTTP 200 general no convierte errores individuales en actualizaciones exitosas.

Las respuestas ausentes, duplicadas, con identidades inconsistentes o cuerpos inválidos dejan fallos por destino y no sobrescriben precios anteriores. Sólo se cuentan escrituras confirmadas por la base. Los errores `ResourceDeprecated` se guardan como categoría `resource_deprecated` y se muestran como «Recurso deprecado», separada de «Permisos», sin conservar cuerpos externos completos ni credenciales. No se modificaron contratos públicos, esquema, rivales ni catálogo.

Validación previa en lectura: los siete lotes propios que fallaron en la ejecución `7e7b048f-404c-4c03-b528-fc2f61aefd3e` devolvieron 70/70 entradas con `status_code = 200` e identidad raíz/cuerpo correcta mediante el recurso nuevo. Se conservó una copia privada de esa ejecución y sus resultados en `.local-review/own-bulk-previous-run.json` para comprobar su integridad.

Las pruebas Deno del sincronizador propio pasan 20 casos, incluidos lotes mixtos/desordenados, entradas ausentes/duplicadas/inconsistentes, HTTP 200 con fallo individual, deprecación, precios inválidos, fallo de conversión, guardado rechazado y lotes de 20/20/1 para 41 destinos. Los servicios rivales y el historial conservan sus pruebas de regresión. TypeScript, compilación y lint de los archivos afectados también se verifican.

Validación completa después de que el operador renovó el token local ID 2: ejecución `581d89e6-e7e6-4418-bc5d-75c562cd738e`, acción `own`, finalizada con **1.814 actualizados, 0 fallidos y 0 advertencias**. Las **70 publicaciones propias que antes habían fallado se actualizaron correctamente**. Las únicas tareas de esta ejecución fueron de la etapa `own`: no se lanzaron catálogo ni rivales. La cola recuperó automáticamente una interrupción por límite de CPU del runtime local y terminó sin destinos pendientes.

Resultado revisable: `http://localhost:3000/dashboard/sincronizaciones/581d89e6-e7e6-4418-bc5d-75c562cd738e`. Evidencia privada con conteos, etapas y comparación con los fallos anteriores: `.local-review/own-bulk-validation-evidence.json`. La ejecución anterior y todos sus resultados permanecen exactamente iguales (SHA-256 `aa3983d3a34ff5b00f4a27e999f909c5d065f7fe66780b626424817ada34ea5a`). Producción permanece sin cambios.

Validación de esta corrección: 20 pruebas Deno del servicio propio, 18 pruebas Playwright del historial/alertas, regresión rival y manual, TypeScript, build y lint de archivos afectados aprobados.
