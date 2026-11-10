-- Additive event history. Existing IDs, amounts and fired_at are preserved.
alter table ml.ml_competitor_items
  add column observation_revision bigint not null default 0,
  add column availability text not null default 'unknown'
    check (availability in ('available','unavailable','unknown'));
alter table ml.ml_price_alerts
  add column archived_at timestamptz,
  add column archive_reason text,
  add column archived_by uuid,
  add column archive_batch_id uuid,
  add column event_snapshot jsonb,
  add column matched_rules jsonb not null default '[]',
  add column event_revision bigint,
  add column event_target_id text,
  add column is_legacy boolean not null default true;
alter table ml.ml_price_alerts alter column rule_id drop not null;
alter table ml.ml_price_alerts alter column competitor_item_id drop not null;
alter table ml.ml_price_alerts drop constraint if exists ml_price_alerts_rule_id_fkey;
alter table ml.ml_price_alerts drop constraint if exists fk_price_alerts_competitor_item;
alter table ml.ml_price_alerts add constraint ml_alert_rule_history_fk foreign key(rule_id)
  references ml.ml_price_alert_rules(id) on delete set null;
alter table ml.ml_price_alerts add constraint ml_alert_rival_history_fk foreign key(competitor_item_id)
  references ml.ml_competitor_items(id) on delete set null;

-- Only infer a legacy destination when exactly one current MLU can own it.
with owners as (
  select a.id,min(p.id) owner_id,count(distinct p.id) candidates
  from ml.ml_price_alerts a
  left join ml.ml_competitor_links l on l.competitor_item_id=a.competitor_item_id and l.removed_at is null
  left join ml.ml_products p on (l.scope='publication' and p.id=l.our_product_id)
    or (l.scope='sku' and ml.normalize_monitor_sku(p.sku)=l.our_sku)
  where a.our_product_id is null group by a.id
)
update ml.ml_price_alerts a set our_product_id=o.owner_id
from owners o where o.id=a.id and o.candidates=1;

update ml.ml_price_alerts a set
  event_target_id=a.competitor_item_id,
  matched_rules=case when r.id is not null then jsonb_build_array(to_jsonb(r)) else '[]'::jsonb end,
  event_snapshot=jsonb_build_object(
    'version',1,'legacy',true,'metadataOrigin','migration_current',
    'detectedAt',a.fired_at,'rows','[]'::jsonb,
    'own',jsonb_build_object('id',a.our_product_id,'sku',a.our_sku,'title',p.title,
      'thumbnail',p.thumbnail,'permalink',p.permalink,'catalog_listing',p.catalog_listing),
    'rival',jsonb_build_object('id',a.competitor_item_id,'title',c.title,
      'sellerName',c.seller_name,'permalink',c.permalink,'thumbnail',c.thumbnail),
    'storedPrices',jsonb_build_object('own',a.our_price,'rivalBefore',a.competitor_price_before,
      'rivalAfter',a.competitor_price_after,'diffPct',a.diff_pct),
    'relativePct',-a.diff_pct,
    'note','Registro legado con información incompleta. Metadatos identificativos obtenidos al migrar; importes y fecha originales sin cambios.'),
  archived_at=now(),archive_reason='legacy_superseded'
from ml.ml_price_alerts source
left join ml.ml_products p on p.id=source.our_product_id
left join ml.ml_competitor_items c on c.id=source.competitor_item_id
left join ml.ml_price_alert_rules r on r.id=source.rule_id
where a.id=source.id;

-- Some records from the previous release already contain exact price evidence.
-- Reuse only that frozen evidence, never today's prices or a fabricated currency.
with evidence as (
 select id,
 case when jsonb_typeof(comparison_snapshot->'own'->'normalizedAmount')='number'
   then (comparison_snapshot->'own'->>'normalizedAmount')::numeric end own_amount,
 case when jsonb_typeof(comparison_snapshot->'rival'->'normalizedAmount')='number'
   then (comparison_snapshot->'rival'->>'normalizedAmount')::numeric end rival_amount
 from ml.ml_price_alerts where is_legacy and our_product_id is not null
 and comparison_snapshot->'own'->>'normalizedCurrency'='UYU'
 and comparison_snapshot->'rival'->>'normalizedCurrency'='UYU'
)
update ml.ml_price_alerts a set event_snapshot=a.event_snapshot || jsonb_build_object(
 'rows',jsonb_build_array(
   jsonb_build_object('id',a.our_product_id,'isOwn',true,'title',coalesce(a.event_snapshot->'own'->>'title',a.our_product_id),
     'mlu',a.our_product_id,'price',e.own_amount,'relativePct',0,'permalink',a.event_snapshot->'own'->>'permalink',
     'observation',a.comparison_snapshot->'own','position',case when e.own_amount>e.rival_amount then 2 else 1 end,'reasons','[]'::jsonb),
   jsonb_build_object('id',a.event_target_id,'isOwn',false,'title',coalesce(a.event_snapshot->'rival'->>'title',a.event_target_id),
     'mlu',a.comparison_snapshot->'rival'->>'itemId','price',e.rival_amount,'relativePct',-a.diff_pct,
     'sellerName',a.comparison_snapshot->'rival'->>'sellerName','permalink',a.event_snapshot->'rival'->>'permalink',
     'observation',a.comparison_snapshot->'rival','position',case when e.rival_amount>e.own_amount then 2 else 1 end,'reasons','[]'::jsonb)),
 'details',jsonb_build_object('reference',a.comparison_snapshot->>'reference','ownObservation',a.comparison_snapshot->'own',
   'previousRival',a.comparison_snapshot->'previousRival','currentRival',a.comparison_snapshot->'rival'),
 'note','Registro legado: precios de la comparación original; solo consta esta pareja, no la lista completa de ofertas. Metadatos identificativos obtenidos al migrar.')
from evidence e where a.id=e.id and e.own_amount>0 and e.rival_amount>0;

create function ml.monitor_alert_archive_reason(p_own text,p_rival text) returns text
language sql stable security invoker set search_path='' as $$
select case
 when p_own is null then 'unidentified'
 when not exists(select 1 from ml.ml_products where id=p_own) then 'own_missing'
 when exists(select 1 from ml.ml_products where id=p_own and status is distinct from 'active') then 'own_inactive'
 when not exists(select 1 from ml.ml_competitor_items where id=p_rival) then 'rival_missing'
 when exists(select 1 from ml.ml_competitor_items where id=p_rival and
   (availability='unavailable' or available_quantity=0 or status in ('paused','closed','inactive','under_review')
    or (observation is not null and ((observation->>'state')='no_external_offers'
      or coalesce((observation->>'amount')::numeric,0)<=0)))) then 'rival_unavailable'
 when not exists(select 1 from ml.ml_competitor_links l join ml.ml_products p on p.id=p_own
   where l.competitor_item_id=p_rival and l.removed_at is null and not l.paused and l.equivalence='accepted'
   and ((l.scope='publication' and l.our_product_id=p.id)
     or (l.scope='sku' and l.our_sku=ml.normalize_monitor_sku(p.sku)))) then 'association_disabled'
 else null end;
$$;

with ranked as (
 select id,row_number() over(partition by our_product_id,competitor_item_id order by fired_at desc,id desc) position,
 ml.monitor_alert_archive_reason(our_product_id,competitor_item_id) reason from ml.ml_price_alerts
)
update ml.ml_price_alerts a set archived_at=case when r.position=1 and r.reason is null then null else a.archived_at end,
 archive_reason=case when r.reason is not null then r.reason when r.position=1 then null else 'legacy_superseded' end
from ranked r where r.id=a.id;

create unique index ml_alert_event_once on ml.ml_price_alerts(event_target_id,our_product_id,event_revision)
where event_revision is not null;
create index ml_alert_scope_date on ml.ml_price_alerts((archived_at is null),fired_at desc,id desc);
create index ml_alert_own_target on ml.ml_price_alerts(our_product_id,competitor_item_id) where archived_at is null;
create index ml_alert_rules_snapshot on ml.ml_price_alerts using gin(matched_rules jsonb_path_ops);
create index ml_alert_seller_date on ml.ml_price_alerts((event_snapshot->'rival'->>'sellerName'),fired_at desc,id desc);
alter table ml.ml_price_alerts alter column is_legacy set default false;
alter table ml.ml_price_alerts alter column event_snapshot set not null;

create function ml.reconcile_monitor_alerts(p_own text default null,p_rival text default null) returns integer
language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
 with invalid as (
 select a.id,ml.monitor_alert_archive_reason(a.our_product_id,a.competitor_item_id) reason
 from ml.ml_price_alerts a where a.archived_at is null
 and (p_own is null or a.our_product_id=p_own) and (p_rival is null or a.competitor_item_id=p_rival)
 ) update ml.ml_price_alerts a set archived_at=now(),archive_reason=i.reason,archived_by=null
 from invalid i where a.id=i.id and i.reason is not null;
 get diagnostics affected=row_count;
 return affected;
end $$;

create function ml.monitor_alert_reconcile_trigger() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='ml_products' then
   perform ml.reconcile_monitor_alerts(coalesce(new.id,old.id),null);
 elsif tg_table_name='ml_competitor_items' then
   perform ml.reconcile_monitor_alerts(null,coalesce(new.id,old.id));
 else
   perform ml.reconcile_monitor_alerts(null,coalesce(new.competitor_item_id,old.competitor_item_id));
 end if;
 return null;
end $$;
create trigger monitor_own_alert_state after update of status on ml.ml_products
for each row execute function ml.monitor_alert_reconcile_trigger();
create trigger monitor_own_alert_delete after delete on ml.ml_products
for each row execute function ml.monitor_alert_reconcile_trigger();
create trigger monitor_rival_alert_state after update of status,availability,observation on ml.ml_competitor_items
for each row execute function ml.monitor_alert_reconcile_trigger();
create trigger monitor_rival_alert_delete after delete on ml.ml_competitor_items
for each row execute function ml.monitor_alert_reconcile_trigger();
create trigger monitor_link_alert_state after insert or update or delete on ml.ml_competitor_links
for each row execute function ml.monitor_alert_reconcile_trigger();

create function ml.protect_monitor_event() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if (to_jsonb(new)-array['read_at','archived_at','archive_reason','archived_by','archive_batch_id','rule_id','competitor_item_id'])
   is distinct from (to_jsonb(old)-array['read_at','archived_at','archive_reason','archived_by','archive_batch_id','rule_id','competitor_item_id'])
 or (new.rule_id is distinct from old.rule_id and new.rule_id is not null)
 or (new.competitor_item_id is distinct from old.competitor_item_id and new.competitor_item_id is not null)
 then raise exception 'Los datos del evento son inmutables'; end if;
 return new;
end $$;
create trigger monitor_event_immutable before update on ml.ml_price_alerts
for each row execute function ml.protect_monitor_event();

-- Optimistic revision + row lock: observation and events commit together.
create function ml.record_monitor_observation(p_id text,p_expected bigint,p_update jsonb,p_events jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_row ml.ml_competitor_items; incoming ml.ml_competitor_items; e jsonb; inserted integer:=0;
begin
 select * into current_row from ml.ml_competitor_items where id=p_id for update;
 if not found then raise exception 'Rival inexistente'; end if;
 if current_row.observation_revision<>p_expected then return jsonb_build_object('conflict',true); end if;
 if (p_update->'observation'->>'observedAt')::timestamptz <= (current_row.observation->>'observedAt')::timestamptz
 then return jsonb_build_object('obsolete',true,'alerts',0); end if;
 incoming:=jsonb_populate_record(current_row,p_update);
 update ml.ml_competitor_items set title=incoming.title,thumbnail=incoming.thumbnail,permalink=incoming.permalink,
 price=incoming.price,currency_id=incoming.currency_id,usd_price=incoming.usd_price,seller_id=incoming.seller_id,
 seller_name=incoming.seller_name,status=incoming.status,condition=incoming.condition,attributes=incoming.attributes,
 available_quantity=incoming.available_quantity,sold_quantity=incoming.sold_quantity,observation=incoming.observation,
 synced_at=incoming.synced_at,last_error=null,last_attempt_at=incoming.last_attempt_at,
 previous_price=incoming.previous_price,availability=incoming.availability,observation_revision=p_expected+1
 where id=p_id;
 for e in select value from jsonb_array_elements(p_events) loop
   if ml.monitor_alert_archive_reason(e->>'our_product_id',p_id) is not null then continue; end if;
   insert into ml.ml_price_alerts(rule_id,our_sku,our_product_id,competitor_item_id,our_price,catalog_price,
     competitor_price_before,competitor_price_after,diff_pct,fired_at,comparison_snapshot,event_snapshot,
     matched_rules,event_revision,event_target_id,is_legacy)
   values((e->>'rule_id')::uuid,e->>'our_sku',e->>'our_product_id',p_id,(e->>'our_price')::numeric,
     (e->>'catalog_price')::numeric,(e->>'competitor_price_before')::numeric,(e->>'competitor_price_after')::numeric,
     (e->>'diff_pct')::numeric,(e->>'fired_at')::timestamptz,e->'comparison_snapshot',e->'event_snapshot',
     e->'matched_rules',p_expected+1,p_id,false);
   inserted:=inserted+1;
 end loop;
 return jsonb_build_object('alerts',inserted,'revision',p_expected+1);
end $$;

create function ml.restore_monitor_alert(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a ml.ml_price_alerts; reason text;
begin
 select * into a from ml.ml_price_alerts where id=p_id for update;
 if not found then raise exception 'Alerta inexistente'; end if;
 if a.archived_at is null then return to_jsonb(a); end if;
 if a.archive_reason<>'manual' then raise exception 'Solo se puede deshacer un archivo manual'; end if;
 reason:=ml.monitor_alert_archive_reason(a.our_product_id,a.competitor_item_id);
 if reason is not null then raise exception 'La publicación ya no está disponible: %',reason; end if;
 update ml.ml_price_alerts set archived_at=null,archive_reason=null,archived_by=null,archive_batch_id=null where id=p_id returning * into a;
 return to_jsonb(a);
end $$;

revoke all on function ml.monitor_alert_archive_reason(text,text),ml.reconcile_monitor_alerts(text,text),
 ml.monitor_alert_reconcile_trigger(),ml.protect_monitor_event(),
 ml.record_monitor_observation(text,bigint,jsonb,jsonb),ml.restore_monitor_alert(uuid) from public,anon,authenticated;
grant execute on function ml.monitor_alert_archive_reason(text,text),ml.reconcile_monitor_alerts(text,text),
 ml.monitor_alert_reconcile_trigger(),ml.protect_monitor_event(),
 ml.record_monitor_observation(text,bigint,jsonb,jsonb),ml.restore_monitor_alert(uuid) to service_role;
comment on column ml.ml_monitoring_settings.max_age_hours is 'Legacy compatibility only. Prices and events no longer expire by age.';

create function ml.filter_monitor_alert_ids(p_filters jsonb) returns setof uuid
language sql stable security invoker set search_path='' as $$
select a.id from ml.ml_price_alerts a where
 (case when p_filters->>'scope'='history' then a.archived_at is not null else a.archived_at is null end)
 and (coalesce(p_filters->>'read','all')='all'
   or (p_filters->>'read'='read' and a.read_at is not null)
   or (p_filters->>'read'='unread' and a.read_at is null))
 and (nullif(p_filters->>'from','') is null or a.fired_at>=(p_filters->>'from')::timestamptz)
 and (nullif(p_filters->>'to','') is null or a.fired_at<(p_filters->>'to')::timestamptz)
 and (nullif(p_filters->>'sku','') is null or ml.normalize_monitor_sku(a.our_sku)=ml.normalize_monitor_sku(p_filters->>'sku'))
 and (nullif(p_filters->>'seller','') is null or coalesce(a.event_snapshot->'rival'->>'sellerName','Sin vendedor identificado')=p_filters->>'seller')
 and (nullif(p_filters->>'rule','') is null or a.matched_rules @> jsonb_build_array(jsonb_build_object('id',p_filters->>'rule')));
$$;

create function ml.list_monitor_alerts(p_filters jsonb,p_cursor_date timestamptz default null,p_cursor_id uuid default null)
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
 where p_cursor_date is null or (a.fired_at,a.id)<(p_cursor_date,p_cursor_id)
 order by a.fired_at desc,a.id desc limit 51
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

create function ml.monitor_alert_options() returns jsonb
language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
 'skus',coalesce((select jsonb_agg(sku order by sku) from (select distinct our_sku sku from ml.ml_price_alerts where our_sku<>'') s),'[]'),
 'sellers',coalesce((select jsonb_agg(seller order by seller) from
 (select distinct coalesce(event_snapshot->'rival'->>'sellerName','Sin vendedor identificado') seller from ml.ml_price_alerts) s),'[]'),
 'rules',coalesce((select jsonb_agg(r order by r->>'name',r->>'id') from
 (select distinct jsonb_build_object('id',r->>'id','name',coalesce(r->>'name','Regla anterior')) r
 from ml.ml_price_alerts a cross join lateral jsonb_array_elements(a.matched_rules) r) s),'[]'));
$$;

create function ml.mutate_monitor_alerts(p_action text,p_filters jsonb,p_actor uuid,p_batch uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
 if p_action='read' then
 update ml.ml_price_alerts set read_at=coalesce(read_at,now())
 where id in (select ml.filter_monitor_alert_ids(p_filters)) and read_at is null;
 elsif p_action='archive_read' then
 update ml.ml_price_alerts set archived_at=now(),archive_reason='manual',archived_by=p_actor,archive_batch_id=p_batch
 where id in (select ml.filter_monitor_alert_ids(p_filters||'{"read":"read","scope":"inbox"}'::jsonb)) and archived_at is null;
 else raise exception 'Acción inválida'; end if;
 get diagnostics affected=row_count;
 return jsonb_build_object('ok',true,'count',affected,'batchId',p_batch);
end $$;

create function ml.restore_monitor_alert_batch(p_batch uuid,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare restored integer; pending integer;
begin
 select count(*) into pending from ml.ml_price_alerts where archive_batch_id=p_batch and archived_by=p_actor and archive_reason='manual';
 update ml.ml_price_alerts set archived_at=null,archive_reason=null,archived_by=null,archive_batch_id=null
 where archive_batch_id=p_batch and archived_by=p_actor and archive_reason='manual'
 and ml.monitor_alert_archive_reason(our_product_id,competitor_item_id) is null;
 get diagnostics restored=row_count;
 return jsonb_build_object('ok',true,'count',restored,'blocked',pending-restored);
end $$;

revoke all on function ml.filter_monitor_alert_ids(jsonb),ml.list_monitor_alerts(jsonb,timestamptz,uuid),
 ml.monitor_alert_options(),ml.mutate_monitor_alerts(text,jsonb,uuid,uuid),ml.restore_monitor_alert_batch(uuid,uuid) from public,anon,authenticated;
grant execute on function ml.filter_monitor_alert_ids(jsonb),ml.list_monitor_alerts(jsonb,timestamptz,uuid),
 ml.monitor_alert_options(),ml.mutate_monitor_alerts(text,jsonb,uuid,uuid),ml.restore_monitor_alert_batch(uuid,uuid) to service_role;

-- Linking an existing rival must not overwrite its event baseline.
create or replace function ml.link_competitor(p_item jsonb,p_scope text,p_target text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rival ml.ml_competitor_items; link ml.ml_competitor_links;
begin
  if p_scope not in ('publication','sku') or nullif(btrim(p_target),'') is null then
    raise exception 'Invalid association target';
  end if;
  if p_scope='publication' and not exists(select 1 from ml.ml_products where id=p_target) then
    raise exception 'Publication not found';
  end if;
  if p_scope='sku' then
    p_target:=ml.normalize_monitor_sku(p_target);
    if not exists(select 1 from ml.ml_products where ml.normalize_monitor_sku(sku)=p_target) then raise exception 'SKU not found'; end if;
  end if;
  insert into ml.ml_competitor_items(id,target_kind,title,price,currency_id,thumbnail,permalink,seller_id,seller_name,status,condition,attributes,observation,synced_at)
  values(p_item->>'id',p_item->>'target_kind',p_item->>'title',(p_item->>'price')::numeric,p_item->>'currency_id',p_item->>'thumbnail',
    p_item->>'permalink',(p_item->>'seller_id')::bigint,p_item->>'seller_name',p_item->>'status',p_item->>'condition',p_item->'attributes',nullif(p_item->'observation','null'::jsonb),(p_item->>'synced_at')::timestamptz)
  on conflict(id) do nothing;
  select * into rival from ml.ml_competitor_items where id=p_item->>'id' for update;
  insert into ml.ml_competitor_links(competitor_item_id,scope,our_product_id,our_sku)
  values(rival.id,p_scope,case when p_scope='publication' then p_target end,case when p_scope='sku' then p_target end)
  on conflict do nothing;
  select * into link from ml.ml_competitor_links where competitor_item_id=rival.id and scope=p_scope
    and case when p_scope='publication' then our_product_id=p_target else our_sku=p_target end for update;
  if link.removed_at is not null then
    update ml.ml_competitor_links set removed_at=null,updated_at=now() where id=link.id returning * into link;
  end if;
  return jsonb_build_object('item',to_jsonb(rival),'association',to_jsonb(link));
end $$;
