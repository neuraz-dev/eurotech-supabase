-- Restore competitor monitoring removed by the catalog project's historical cron cleanup.
-- Reuse the working internal ML invocation configuration without embedding credentials.
select vault.create_secret(
  regexp_replace(decrypted_secret, '/sync-ml-to-web$', '/ml-sync-competitor'),
  'sync_ml_competitor_url'
)
from vault.decrypted_secrets
where name = 'sync_ml_to_web_url'
  and decrypted_secret ~ '/sync-ml-to-web$'
  and not exists (select 1 from vault.secrets where name = 'sync_ml_competitor_url');

select vault.create_secret(decrypted_secret, 'sync_ml_competitor_apikey')
from vault.decrypted_secrets
where name = 'sync_ml_to_web_apikey'
  and not exists (select 1 from vault.secrets where name = 'sync_ml_competitor_apikey');

-- Invoker-only: only the cron owner can read Vault and dispatch this request.
create or replace function ml.invoke_competitor_sync()
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  function_url text;
  function_key text;
  request_headers jsonb;
  request_id bigint;
begin
  select decrypted_secret into function_url
  from vault.decrypted_secrets where name = 'sync_ml_competitor_url';
  select decrypted_secret into function_key
  from vault.decrypted_secrets where name = 'sync_ml_competitor_apikey';
  if function_url is null or function_url !~ '/ml-sync-competitor$'
     or nullif(btrim(function_key), '') is null then
    raise exception 'Configure sync_ml_competitor_url and sync_ml_competitor_apikey in Vault';
  end if;
  request_headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', function_key);
  -- Legacy self-hosted JWT gateways still require the Bearer header. Opaque
  -- internal secrets use apikey only and are authenticated by the function.
  if function_key ~ '^eyJ[^.]+\.[^.]+\.[^.]+$' then
    request_headers := request_headers || jsonb_build_object('Authorization', 'Bearer ' || function_key);
  end if;
  select net.http_post(
    url := function_url,
    headers := request_headers,
    body := '{"trigger":"scheduled"}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function ml.invoke_competitor_sync() from public, anon, authenticated, service_role;
grant execute on function ml.invoke_competitor_sync() to postgres;

-- Fail the deployment rather than install a silently broken schedule.
do $$ begin
  if not exists (select 1 from vault.decrypted_secrets
    where name = 'sync_ml_competitor_url' and decrypted_secret ~ '/ml-sync-competitor$')
    or not exists (select 1 from vault.decrypted_secrets
    where name = 'sync_ml_competitor_apikey' and nullif(btrim(decrypted_secret), '') is not null) then
    raise exception 'Competitor sync Vault configuration is missing; no schedule was installed';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job
where jobname in ('ml-sync-competitor-hourly', 'ml-sync-competitor-2h');
select cron.schedule('ml-sync-competitor-2h', '5 */2 * * *',
  'select ml.invoke_competitor_sync();');
