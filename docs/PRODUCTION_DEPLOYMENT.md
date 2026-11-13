# Despliegue coordinado del Monitor y continuidad del Gestor

Este procedimiento se ejecuta **durante una ventana de mantenimiento**. El merge
local no publica cambios. Un push a main puede desplegar automáticamente tanto
las migraciones/funciones (GitHub Actions) como el frontend (Coolify).
No publicar antes de preparar esa ventana.

## 1. Aplicaciones y revisión previa

Configuración consultada en Coolify al preparar esta entrega:

| Recurso | Identidad / configuración |
|---|---|
| Supabase compartido | `bbbxl4gqwtuiu30nj1khefau` |
| Monitor | `eurotech-monitor`, UUID `l82tvwejlwm1ihx0hq6rlr0s` |
| Frontend Monitor | `https://monitor.eurotech.uy`, rama `main`, Nixpacks |
| Repositorio de Coolify | `neuraz-dev/eurotech-supabase.git` |
| Gestor | `eurotech-gestor`, UUID `ejcwkv6zj1d8ytm6e2asqw1v` |
| Frontend Gestor | `https://gestor.eurotech.uy` |

El origin de este checkout es `emilrichardo/eurotech-supabase`. En la comprobación,
ambos repositorios tenían main en `a92ce138d68ceb2c8ecdb4a2c009491ffd22677e`.
Publicar explícitamente al repositorio observado por Coolify; no asumir que
`git push origin main` actualiza la aplicación. No usar force-push.

1. Guardar SHA de esta entrega (`git rev-parse main`), SHA anterior, imagen actual
   del Monitor y configuración de ambas aplicaciones.
2. Suspender temporalmente el Auto Deploy del Monitor en Coolify y deshabilitar
   **Deploy Monitor Supabase to self-hosted Coolify** en GitHub Actions en los
   repositorios que reciban el push. Suspender también temporalmente el workflow
   **Deploy self-hosted Supabase Edge Functions via Coolify** del Gestor y esperar
   a que no haya despliegues en curso: ambos comparten runtime. Registrar qué
   disparadores estaban habilitados para restaurar únicamente esos al finalizar.
3. Comprobar que Gestor y sus integraciones funcionan antes de comenzar. Coolify
   reportaba Gestor como `running:unknown`: ese estado no acredita por sí solo
   la salud. Verificar login, productos y una lectura de fuentes.
4. Confirmar un token ML válido con duración suficiente. No copiar el token,
   usuarios, Vault ni URLs del entorno local a producción.

## 2. Publicar sin iniciar despliegues descoordinados

Después de suspender los disparadores anteriores, desde el checkout local:

```bash
git switch main
git status --short
git ls-remote git@github.com-personal:neuraz-dev/eurotech-supabase.git refs/heads/main
# Si main remoto avanzó, integrar y revisar primero; no forzar su sustitución.
git push git@github.com-personal:neuraz-dev/eurotech-supabase.git main:main
```

El alias SSH `github.com-personal` es el de este computador. En otro equipo usar
la identidad SSH autorizada equivalente. No cambiar el remoto del Gestor ni
publicar sus adaptaciones locales como parte de este despliegue.

En Oracle preparar un checkout del **mismo SHA** (sin secretos en su URL Git).
Los pasos siguientes se realizan allí, nunca desde la base local de revisión.

## 3. Detener escritores y respaldar

En Oracle, establecer y verificar los nombres exactos del servicio:

```bash
set -Eeuo pipefail
umask 077
SERVICE_UUID=bbbxl4gqwtuiu30nj1khefau
DB_CONTAINER="supabase-db-$SERVICE_UUID"
FUNCTIONS_CONTAINER="supabase-edge-functions-$SERVICE_UUID"
VOLUME_ROOT="/data/coolify/services/$SERVICE_UUID/volumes"
BACKUP_DIR="$HOME/monitor-release-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$BACKUP_DIR"
sudo -n docker inspect --format '{{.Name}} {{.State.Running}}' "$DB_CONTAINER" "$FUNCTIONS_CONTAINER"
psql_monitor() {
  sudo -n docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
```

- Poner Monitor y Gestor en mantenimiento, impidiendo nuevas escrituras de los
  operadores. Guardar el nombre exacto de su gateway Kong en `KONG_CONTAINER`
  a partir de los contenedores de **este** servicio; no detener otros Supabase.
- Capturar los estados originales antes de pausarlos:

```bash
psql_monitor -Atc 'SELECT coalesce(json_agg(j), '\''[]'\'') FROM cron.job j;' > "$BACKUP_DIR/cron-before.json"
psql_monitor -Atc 'SELECT json_agg(s) FROM web.sync_runtime_settings s;' > "$BACKUP_DIR/runtime-before.json"
psql_monitor -Atc "SELECT json_agg(x) FROM (
 SELECT n.nspname,c.relname,t.tgname,t.tgenabled FROM pg_trigger t
 JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('ml','web','agents') AND NOT t.tgisinternal
 ORDER BY 1,2,3)x;" > "$BACKUP_DIR/triggers-before.json"
psql_monitor -c "SELECT cron.alter_job(jobid,active:=false) FROM cron.job;
 UPDATE web.sync_runtime_settings SET enabled=false;"
```

- Pausar también los escritores externos al cron (webhooks, workers y acciones
  en ejecución). Para esta ventana puede detenerse sólo el Kong de este servicio
  después de pausar los jobs: bloquea temporalmente el acceso a la API compartida.
  No detener PostgreSQL ni el runtime, que necesita estar activo para el instalador.
  Esperar a que terminen los trabajos en curso; comprobar sesiones/transacciones.
- Respaldar la base **completa**, el código montado y la configuración del runtime:

```bash
sudo -n docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres -Fc > "$BACKUP_DIR/postgres.dump"
sudo -n docker exec "$DB_CONTAINER" pg_dumpall -U postgres --globals-only --no-role-passwords > "$BACKUP_DIR/roles.sql"
sudo -n tar -C "$VOLUME_ROOT" -czf "$BACKUP_DIR/functions-and-src.tar.gz" functions src
sudo -n docker inspect "$FUNCTIONS_CONTAINER" > "$BACKUP_DIR/runtime-inspect.json"
sha256sum "$BACKUP_DIR/postgres.dump" > "$BACKUP_DIR/postgres.dump.sha256"
sudo -n docker exec -i "$DB_CONTAINER" pg_restore --list < "$BACKUP_DIR/postgres.dump" > "$BACKUP_DIR/archive-list.txt"
```

Estos respaldos contienen información privada. No subirlos a GitHub ni adjuntar
runtime-inspect.json a los logs públicos. Conservar también el Compose/secrets de
Coolify y un respaldo o recuperación operativa de roles/credenciales del servidor.

Guardar conteos y columnas originales de productos, rivales, reglas, seguimientos,
alertas y asociaciones antes del cambio. El total de alertas debe conservarse;
el número de activas cambiará al pasar los registros anteriores a Historial.

## 4. Preparar Vault y actualizar esquema y funciones

En Supabase Studio o mediante una conexión administrativa privada, provisionar:

- `monitor_manual_worker_url`: URL **interna del mismo Supabase**, terminada en
  `/functions/v1/ml-manual-sync`. Se obtiene del `SUPABASE_URL` del runtime,
  añadiendo ese sufijo; no usar localhost ni la URL del Gestor local.
- `monitor_manual_worker_key`: una credencial que acepte `isAuthorized` en
  `ml-sync/service.ts` y que también acepte el gateway. Puede reutilizarse la
  credencial de `sync_ml_competitor_apikey` **después de verificar** que coincide
  con una de las admitidas por el runtime. Nunca imprimir su valor.

Conservar `sync_ml_competitor_url`, `sync_ml_competitor_apikey`, los secretos del
Gestor y las credenciales OAuth existentes. No reemplazar todo Vault ni el entorno.
En instalaciones autoalojadas, supabase/config.toml no configura por sí solo el
router de funciones: comprobar que permite llegar a los handlers con estos headers.
No desactivar autenticación globalmente para resolver un 401.

En el checkout revisado del Monitor en Oracle:

```bash
# Confirmar que este HEAD es el SHA aprobado.
git rev-parse HEAD
COOLIFY_RUN_LOCAL=1 bash scripts/deploy-self-hosted-monitor.sh
```

El instalador registra la base histórica comprobada, aplica únicamente migraciones
pendientes con checksums/transacción por archivo y sincroniza funciones. Conserva
los helpers del Gestor en `_shared`; sólo elimina archivos obsoletos dentro de
funciones propias del Monitor. **No usar rsync --delete sobre el directorio global
functions ni sobre _shared.** No ejecutar en su lugar un db reset o db push ciego.

El reinicio del runtime compartido produce una interrupción breve de las funciones
del Gestor. No sustituir su `main`, `src`, import map, secretos ni router.

Las migraciones pueden crear/reactivar jobs: volver a pausarlos inmediatamente
antes de abrir tráfico, mientras se hacen las comprobaciones:

```bash
psql_monitor -c 'SELECT cron.alter_job(jobid,active:=false) FROM cron.job;'
psql_monitor -c 'SELECT version,filename,deployed_at FROM deployment.monitor_migrations ORDER BY version;'
```

Si se elige ejecutar el workflow de GitHub en vez del comando en Oracle, hacerlo
manualmente sobre el mismo SHA y esperar a que termine; no ejecutar ambos caminos.

## 5. Compilar y desplegar el frontend del Monitor

**Cambiar sólo la aplicación eurotech-monitor** en Coolify:

| Parámetro | Valor de esta entrega |
|---|---|
| Build Pack | Nixpacks |
| Base Directory | `/` (raíz completa del repositorio) |
| Install Command | `npm --prefix frontend ci` |
| Build Command | `npm run build` |
| Start Command | `npm run start` |
| Puerto | `3000` |
| Publish Directory | vacío; aplicación dinámica |
| Versión Node | `NIXPACKS_NODE_VERSION=22` |

La raíz contiene package.json con comandos que delegan en frontend. Esto permite
incluir también supabase/functions/_shared, que el frontend importa directamente.
El anterior contexto /frontend no incluye esos archivos. No copiar helpers a mano
ni mantener dos versiones del evaluador. Referencia de configuración:
[Coolify Nixpacks](https://coolify.io/docs/applications/builds/nixpacks/deploy).

Mantener las variables de producción del Monitor:

- `NEXT_PUBLIC_SUPABASE_URL`: URL pública de Supabase de producción.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`: clave pública de esa instancia,
  disponible durante el build y en ejecución.
- `SUPABASE_SECRET_KEY`: credencial administrativa **sólo de servidor**. Nunca
  prefijarla con NEXT_PUBLIC_ ni cambiar la del Gestor.
- Si están configuradas, `ML_API_BASE_URL=https://api.mercadolibre.com` y
  `MONITOR_FX_URL=https://open.er-api.com/v6/latest/USD`.

Mantener dominios y red actuales. No utilizar scripts/with-gestor-local.py en
producción. Conservar el frontend del Gestor y sus variables sin cambios.

Desplegar manualmente Monitor en Coolify con el SHA aprobado después de actualizar
el esquema/funciones. Levantar de nuevo el Kong detenido para poder verificar
ambas aplicaciones con el tráfico de usuarios todavía en mantenimiento.

## 6. Verificación y reactivación

Antes de abrir el servicio:

1. Verificar checksum/presencia de los helpers de **ambas** aplicaciones, incluidos
   `_shared/self-hosted-auth.ts` y las dependencias del Monitor. Confirmar que el
   runtime está activo y sin errores de importación. Si se dispone del checkout
   desplegado del Gestor, su script `scripts/verify-self-hosted-functions.sh` permite
   comparar los archivos montados con esa misma versión; no usar otra revisión.
2. Confirmar que no se perdieron alertas, rivales, vínculos ni precios históricos.
   Las equivalencias heredadas deben quedar aceptadas. Revisar distribución de
   Historial por motivo; los destinos ambiguos no se reasignan automáticamente.
3. Comprobar las nuevas tablas con RLS y que las API sin sesión rechazan acceso.
4. Invocar ml-manual-sync sin tareas con la credencial privada del dispatcher:
   debe responder HTTP 200 con processed=0. Una respuesta 401/403/404/5xx impide
   considerar terminado el despliegue; revisar gateway, Vault y handlers.
5. Login Monitor: Productos, Alertas/Historial, Seguimiento y Sincronizaciones.
   Ejecutar una actualización individual y comprobar su resultado persistido.
6. Login Gestor: productos, fuentes y lecturas ML→web. Verificar que sigue
   disponible el trigger `ml_products_sync_trigger`, su función y la columna
   generada `sku_key`. No activar indiscriminadamente triggers previamente apagados.

Restaurar cada job previo con cron.alter_job(jobid,active:=<valor guardado>),
identificándolo por su nombre si cambió su ID. Restaurar el valor previo de
web.sync_runtime_settings.enabled y mantener exactamente los estados de triggers
que correspondían antes del mantenimiento.

Activar adicionalmente el nuevo worker:

```sql
SELECT cron.alter_job(jobid,active:=true)
FROM cron.job WHERE jobname='monitor-manual-sync-worker';
```

Debe haber **un solo** job del worker (cada minuto) y una sola programación de
rivales. Si el despliegue ya tenía el job de rivales, conservar su programación;
no instalar además una segunda copia con otro nombre.

Después de restaurar los escritores, ejecutar una sincronización manual controlada
y seguirla hasta estado terminal en Sincronizaciones. Revisar que cron/pg_net no
acumulen errores ni leases vencidos. Revisar errores de CPU/memoria del runtime:
el ensayo usó un adaptador Deno local y no prueba los límites del runtime productivo.

Verificar que una actualización propia llega a la cola/importación del Gestor y
que sus entregas normales a WooCommerce vuelven a procesarse. Revisar ambos logs.
Una ausencia de ofertas comprobada o una asociación por revisar es un resultado
de negocio, no un fallo técnico. No cerrar la ventana con fallos de autenticación,
guardado, importación de módulos, cola detenida o procesos sin terminar.

Abrir tráfico de ambas aplicaciones y reactivar los disparadores automáticos
que estaban habilitados previamente. No ejecutar el despliegue de código del
Gestor como parte de esta entrega: su versión no necesita cambiar.

## 7. Si algo falla

- Mantener las escrituras suspendidas y guardar el error y el último archivo
  registrado en deployment.monitor_migrations. Cada archivo es atómico, pero el
  conjunto de migraciones no lo es: un fallo puede dejar algunas ya aplicadas.
- Ante un fallo de frontend, conservar el esquema expandido y corregir/recompilar
  el frontend; usar la imagen previa sólo como recuperación coordinada, con
  escritores pausados, porque los escritores antiguos no conocen eventos/colas.
- Ante un fallo de funciones, recuperar functions y src desde el respaldo como un
  conjunto compatible y reiniciar el runtime. Verificar especialmente la
  autenticación del Gestor. No restaurar sólo el contenedor del Monitor si falla
  una dependencia del runtime compartido.
- Si es necesario deshacer los cambios de datos/esquema, restaurar el respaldo
  completo a un destino limpio mediante el procedimiento de recuperación probado
  por el administrador, conservando primero una copia de la base fallida. La
  restauración afecta **también al Gestor**: ambos deben permanecer detenidos y
  recuperarse al mismo punto temporal. No superponer un dump antiguo sobre la
  base nueva dejando tablas adicionales, ni ejecutar DROP CASCADE improvisados.
- Nunca editar checksums ni eliminar entradas del historial para ocultar un fallo.
  Reanudar una aplicación idempotente sólo cuando código, esquema y configuración
  vuelvan a ser compatibles. Restaurar cron/triggers/flags según el respaldo.
