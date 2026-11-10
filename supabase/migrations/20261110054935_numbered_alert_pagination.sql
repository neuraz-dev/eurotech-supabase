-- Direct page navigation preserves the existing cursor API for older callers.
create function ml.list_monitor_alerts_page(p_filters jsonb,p_page integer default 1)
returns jsonb language sql stable security invoker set search_path='' as $$
with base as (
 select a.id,a.fired_at,a.read_at,(a.event_snapshot->>'relativePct')::numeric relative_pct
 from ml.ml_price_alerts a join ml.filter_monitor_alert_ids(p_filters||'{"read":"all"}'::jsonb) f on f=a.id
), filtered as (
 select * from base where coalesce(p_filters->>'read','all')='all'
 or (p_filters->>'read'='read' and read_at is not null)
 or (p_filters->>'read'='unread' and read_at is null)
), page as (
 select a.* from ml.ml_price_alerts a join filtered f on f.id=a.id
 order by a.fired_at desc,a.id desc limit 51 offset ((greatest(1,p_page)::bigint-1)*50)
)
select jsonb_build_object(
 'items',coalesce((select jsonb_agg((to_jsonb(p)-'comparison_snapshot'-'event_snapshot') ||
   jsonb_build_object('event_snapshot',(p.event_snapshot-'details'-'rows')||'{"rows":[]}'::jsonb)
   order by fired_at desc,id desc) from page p),'[]'::jsonb),
 'counts',jsonb_build_object('all',(select count(*) from base),'read',(select count(*) from base where read_at is not null),
 'unread',(select count(*) from base where read_at is null),'total',(select count(*) from filtered),
 'advantage',(select count(*) from filtered where relative_pct>0),
 'disadvantage',(select count(*) from filtered where relative_pct<0),
 'tie',(select count(*) from filtered where relative_pct=0)));
$$;

revoke all on function ml.list_monitor_alerts_page(jsonb,integer) from public,anon,authenticated;
grant execute on function ml.list_monitor_alerts_page(jsonb,integer) to service_role;
