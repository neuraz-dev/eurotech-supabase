# Sincronización de competidores

## Resultado local — 5 de noviembre de 2026

- El perfil compartido registra `ml-sync-competitor` y crea una única tarea
  `local-ml-sync-competitor`, con horario `5 */2 * * *` (UTC).
- Detener el perfil elimina las tareas locales; volver a iniciarlo las recrea.
- El token debe estar vigente y no tener `refresh_token`. Se mantiene bloqueado
  OAuth y cualquier acceso al Supabase de producción.
- Se verificaron una llamada directa y una ejecución de pg_cron con el mismo
  comando mediante una tarea temporal. Esta tarea temporal ya fue eliminada.
- Ambas ejecuciones actualizaron 48 de 75 rivales. Los otros 27 produjeron
  26 respuestas 404 del catálogo y una respuesta 403 de una publicación directa.
  No se alteraron sus precios ni se adelantaron sus fechas para ocultar el fallo.
- El dashboard mostró la actualización de competidores del 05/11/2026 a las
  12:04 p. m. de Bogotá, bajo “Última actualización de datos”. Esta fecha es el
  mayor `synced_at`, no una garantía de que todos los rivales se actualizaron.

## Contrato y comprobaciones

La función conserva GET/POST y las reglas de alertas. Requiere una credencial
interna válida en `apikey`, Bearer o `x-sync-secret`. La respuesta mantiene
`success`, `items_processed`, `items_updated`, `alerts_fired` y `synced_at`;
añade `items_failed`, `items_skipped` y `alert_errors`. Los fallos parciales o
totales responden HTTP 500 con estadísticas; un catálogo válido sin ofertas se
cuenta como omitido. No se emiten alertas si no se pudo guardar el precio.

El `synced_at` de la respuesta indica cuándo terminó la ejecución; el de cada
producto solo avanza tras una actualización persistida. `cron.job_run_details`
confirma el envío SQL; para comprobar el resultado hay que revisar también
`net._http_response` y los registros de la función.

Validaciones ejecutadas: 15 pruebas del handler, 10 pruebas de aislamiento local,
11 pruebas existentes de alertas, 5 pruebas del despliegue y TypeScript del frontend.
También pasó la comprobación de tipos de Deno en el runtime local. La migración nueva
se probó dos veces dentro de una transacción local revertida, incluyendo la
ausencia de permisos para `anon`, `authenticated` y `service_role`, y el rechazo
de configuración faltante en Vault.

## Producción — despliegue aplicado; ejecución automática pendiente de confirmar

El acceso SSH configurado agotó el tiempo de espera; el conector de Coolify es
de solo lectura. El diagnóstico ejecutado por el usuario a las 17:06 UTC confirmó
que no existía cron de competidores y que la última actualización seguía en
12:54 UTC. La URL interna es `http://supabase-kong:8000`; las entradas de Vault
de `sync-ml-to-web` y las credenciales del runtime están configuradas.
El usuario ejecutó el despliegue revisado desde la terminal general del servidor
`localhost`, sin acceso SSH desde este entorno. El resultado reportado confirmó:

- La migración `20261105165701` se aplicó y quedó registrada con checksum en
  `deployment.monitor_migrations`; no se modificó ninguna migración histórica.
- La tarea `ml-sync-competitor-2h` quedó activa con job ID **27**, horario
  `5 */2 * * *` (UTC): cada dos horas al minuto 5.
- La solicitud controlada **174607** terminó sin timeout: HTTP **500**,
  `success=false`, **49** rivales actualizados, **26** fallidos y **0** errores
  de alertas. Esto valida el transporte, la autenticación y las actualizaciones;
  no significa que todos los rivales hayan podido sincronizarse.
- Se respaldó la función anterior en
  `/tmp/ml-sync-competitor-backup.zeJL4d2s` antes de reemplazar su código.
- Sigue pendiente comprobar la siguiente ejecución automática en producción y
  revisar individualmente los 26 rivales que fallan. Los códigos concretos
  de cada fallo de producción deben confirmarse en los registros del runtime;
  las respuestas 404/403 documentadas arriba corresponden a las pruebas locales.

La primera ejecución del instalador pegado como heredoc llegó solo a `--check`:
`docker exec -i` consumía las líneas restantes del bloque durante las consultas
SQL con `-c`. La función `psql` del script ahora conecta stdin únicamente para
las migraciones transmitidas por pipe. Una prueba de regresión reproduce un
instalador pegado y comprueba que `--apply` y el comando final sí se ejecutan.
El usuario continuó el despliegue desde los archivos ya extraídos utilizando
`--apply </dev/null`.

Al hacer push a `main`, GitHub Actions ejecuta el despliegue habitual del monitor.
El checksum de la migración permanece idéntico al del paquete aplicado: el
proceso existente reconocerá su registro y no volverá a aplicarla. El código
actualizado debe versionarse junto con este documento y los scripts.

El paquete incluye `scripts/deploy-competitor-sync.sh`. Primero puede ejecutarse
con `--check` para verificar sin cambios la URL, la igualdad entre credenciales
(sin mostrarlas) y el historial de migraciones. Con `--apply`, respalda la función,
instala únicamente sus dos archivos, reinicia el runtime, aplica la migración en
una transacción y verifica una actualización real. El instalador autocontenido
ejecuta ambas fases; su contenido completo puede pegarse en la terminal del
servidor sin subir archivos por SSH. Imprime el directorio de trabajo para poder
repetir el diagnóstico después de la próxima ejecución programada.

1. Ejecutar `bash scripts/diagnose-competitor-sync.sh` en el checkout del servidor
   y revisar el resultado antes de cambiar el cron. No imprime claves ni tokens.
2. Confirmar que `sync_ml_to_web_url` apunta al runtime autoalojado y que
   `sync_ml_to_web_apikey` coincide con una credencial que acepta el handler.
   La migración deriva de esos valores las entradas específicas de competidores
   si todavía no existen; no reemplaza entradas específicas existentes.
3. Desplegar juntos `index.ts` y `handler.ts` de `ml-sync-competitor` mediante el
   proceso existente del runtime, antes de habilitar la tarea. En despliegues
   administrados por la CLI, `config.toml` desactiva el chequeo JWT del gateway:
   la validación de credenciales permanece dentro del handler. El runtime
   autoalojado debe aceptar el mismo transporte que usa `sync-ml-to-web`.
4. Aplicar la migración nueva a través del registro existente de despliegues del
   monitor. No editar ni reejecutar las migraciones históricas del cron.
   La migración falla si falta configuración y programa una sola tarea
   `ml-sync-competitor-2h` cada dos horas, al minuto 5.
5. Ejecutar `select ml.invoke_competitor_sync();` como propietario del cron y
   comprobar su respuesta HTTP por el ID devuelto; luego comprobar la siguiente
   ejecución programada. Revisar también los registros 404/403: restaurar el cron
   no corrige identificadores inexistentes ni restricciones de Mercado Libre.

Si es necesario detener únicamente este flujo, ejecutar
`select cron.alter_job(jobid, active => false) from cron.job where
jobname = 'ml-sync-competitor-2h';`. Corregir configuración o función y reactivar
la tarea después de una ejecución controlada; conservar las migraciones aplicadas.
