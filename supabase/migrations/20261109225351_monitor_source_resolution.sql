-- Source identity is independent from fixed/dynamic mode and internal object ID.
create function ml.monitor_source_url(p_kind text,p_id text,p_url text) returns text
language sql immutable security invoker set search_path='' as $$
 select case when p_kind='user_product' then regexp_replace(coalesce(nullif(p_url,''),'https://www.mercadolibre.com.uy/up/'||p_id),'/p/(ML[AU]U[0-9]+)','/up/\1','i')
 else nullif(p_url,'') end;
$$;
alter table ml.ml_competitor_items add column source_kind text,add column source_id text,add column source_url text;
alter table ml.ml_tracked_items add column source_kind text,add column source_id text,add column source_url text;
create table ml.ml_monitor_repairs (
 key text primary key,kind text not null check(kind in ('source_url','recover_fixed','archive_correction')),
 status text not null default 'pending' check(status in ('pending','resolved')),
 sku text,rival_id text,alert_id uuid,expected_seller_id bigint,catalog_id text,
 candidates jsonb not null default '[]',evidence jsonb not null default '{}',
 last_error text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),actor uuid
);
alter table ml.ml_monitor_repairs enable row level security;
revoke all on ml.ml_monitor_repairs from public,anon,authenticated;
grant all on ml.ml_monitor_repairs to service_role;
insert into ml.ml_monitor_repairs(key,kind,status,rival_id,evidence)
select 'source-url:'||id,'source_url','resolved',id,jsonb_build_object('before',permalink,'after',ml.monitor_source_url('user_product',id,permalink))
from ml.ml_competitor_items where permalink ~* '/p/ML[AU]U[0-9]+';
insert into ml.ml_monitor_repairs(key,kind,sku,rival_id,expected_seller_id,catalog_id,evidence)
select 'legacy-fixed:7270:255754420','recover_fixed','7270',id,255754420,'MLU2081534097',
 jsonb_build_object('origin','Operator assignment in pg-dump-postgres-nov8_test-monitor.dmp','sellerName','FERROFERTASIMP','originalUrl','https://www.mercadolibre.com.uy/kit-extractor-de-rulemanes-cepo-30-50mm-50-75mm/p/MLU2081534097')
from ml.ml_competitor_items where id='MLU2081534097';
insert into ml.ml_monitor_repairs(key,kind,sku,rival_id,alert_id,evidence)
select 'archive-source:'||a.id,'archive_correction',a.our_sku,c.id,a.id,
 jsonb_build_object('before',jsonb_build_object('archived_at',a.archived_at,'archive_reason',a.archive_reason),'cause','404 from /products with a User Product identifier; availability requires revalidation')
from ml.ml_price_alerts a join ml.ml_competitor_items c on c.id=a.competitor_item_id
where a.archive_reason='rival_unavailable' and c.id ~ '^ML[AU]U[0-9]+$' and c.last_error like '%HTTP 404%';
update ml.ml_competitor_items set source_kind=case when target_kind='catalog' and id ~ '^ML[AU]U[0-9]+$' then 'user_product' else target_kind end,source_id=id;
update ml.ml_competitor_items set source_url=ml.monitor_source_url(source_kind,source_id,permalink),
 permalink=ml.monitor_source_url(source_kind,source_id,permalink),
 availability=case when source_kind='user_product' and last_error like '%HTTP 404%' then 'unknown' else availability end;
update ml.ml_tracked_items set source_kind=case when target_kind='catalog' and target_id ~ '^ML[AU]U[0-9]+$' then 'user_product' else target_kind end,source_id=target_id;
update ml.ml_tracked_items set source_url=ml.monitor_source_url(source_kind,source_id,url),url=ml.monitor_source_url(source_kind,source_id,url);
create function ml.monitor_source_defaults() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 new.source_id:=coalesce(nullif(new.source_id,''),case when tg_table_name='ml_competitor_items' then new.id::text else to_jsonb(new)->>'target_id' end);
 new.source_kind:=coalesce(new.source_kind,case when new.target_kind='catalog' and new.source_id ~ '^ML[AU]U[0-9]+$' then 'user_product' else new.target_kind end);
 new.source_url:=ml.monitor_source_url(new.source_kind,new.source_id,coalesce(new.source_url,case when tg_table_name='ml_competitor_items' then to_jsonb(new)->>'permalink' else to_jsonb(new)->>'url' end));
 return new;
end $$;
create trigger monitor_rival_source_defaults before insert on ml.ml_competitor_items for each row execute function ml.monitor_source_defaults();
create trigger monitor_tracking_source_defaults before insert on ml.ml_tracked_items for each row execute function ml.monitor_source_defaults();
alter table ml.ml_competitor_items alter column source_kind set not null,alter column source_id set not null,
 add check(source_kind in ('item','catalog','user_product')),add check(source_id<>'');
alter table ml.ml_tracked_items alter column source_kind set not null,alter column source_id set not null,
 add check(source_kind in ('item','catalog','user_product')),add check(source_id<>'');
create unique index ml_rival_source_identity on ml.ml_competitor_items(source_kind,source_id);
create unique index ml_tracking_source_identity on ml.ml_tracked_items(source_kind,source_id);
-- Canonical price revisions deduplicate a physical item seen through two origins.
create table ml.ml_item_observations(item_id text primary key,amount numeric not null,currency text not null,revision bigint not null,observed_at timestamptz not null);
create table ml.ml_price_event_claims(own_id text not null,item_id text not null,revision bigint not null,alert_id uuid not null references ml.ml_price_alerts(id) on delete restrict,primary key(own_id,item_id,revision));
create table ml.ml_price_event_origins(alert_id uuid not null references ml.ml_price_alerts(id) on delete restrict,rival_id text not null,association_ids jsonb not null default '[]',detected_at timestamptz not null,primary key(alert_id,rival_id));
alter table ml.ml_item_observations enable row level security;
alter table ml.ml_price_event_claims enable row level security;
alter table ml.ml_price_event_origins enable row level security;
revoke all on ml.ml_item_observations,ml.ml_price_event_claims,ml.ml_price_event_origins from public,anon,authenticated;
grant all on ml.ml_item_observations,ml.ml_price_event_claims,ml.ml_price_event_origins to service_role;

create or replace function ml.link_competitor(p_item jsonb,p_scope text,p_target text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rival ml.ml_competitor_items; link ml.ml_competitor_links; object_id text; v_source_id text; v_source_kind text;
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
  v_source_id:=coalesce(p_item->>'source_id',p_item->>'id');
  v_source_kind:=coalesce(p_item->>'source_kind',case when p_item->>'target_kind'='catalog' and v_source_id ~ '^ML[AU]U[0-9]+$' then 'user_product' else p_item->>'target_kind' end);
  perform pg_advisory_xact_lock(hashtextextended(v_source_id,0));
  object_id:=case when exists(select 1 from ml.ml_competitor_items where id=p_item->>'id' and (ml_competitor_items.source_kind,ml_competitor_items.source_id)<>(v_source_kind,v_source_id)) then gen_random_uuid()::text else p_item->>'id' end;
  insert into ml.ml_competitor_items(id,source_kind,source_id,source_url,target_kind,title,price,currency_id,thumbnail,permalink,seller_id,seller_name,status,condition,attributes,observation,synced_at)
  values(object_id,v_source_kind,v_source_id,p_item->>'source_url',p_item->>'target_kind',p_item->>'title',(p_item->>'price')::numeric,p_item->>'currency_id',p_item->>'thumbnail',
    p_item->>'permalink',(p_item->>'seller_id')::bigint,p_item->>'seller_name',p_item->>'status',p_item->>'condition',p_item->'attributes',nullif(p_item->'observation','null'::jsonb),(p_item->>'synced_at')::timestamptz)
  on conflict(source_kind,source_id) do nothing;
  select * into rival from ml.ml_competitor_items where ml_competitor_items.source_kind=v_source_kind and ml_competitor_items.source_id=v_source_id for update;
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

create or replace function ml.save_tracking(p_item jsonb,p_snapshot jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item ml.ml_tracked_items; reactivated boolean:=false;
begin
  -- Transaction-level lock serializes the same target, including first insert.
  perform pg_advisory_xact_lock(hashtextextended((p_item->>'target_kind')||':'||(p_item->>'target_id'),0));
  if p_item ? 'resolve_id' then
    select * into item from ml.ml_tracked_items where id=(p_item->>'resolve_id')::uuid for update;
    if not found or not item.target_review_required then raise exception 'This tracking identity does not need review'; end if;
    update ml.ml_tracked_items set target_kind=p_item->>'target_kind',target_id=p_item->>'target_id',ml_item_id=p_item->>'target_id',
      target_review_required=false,url=p_item->>'url',title=coalesce(p_item->>'title',title),thumbnail=coalesce(p_item->>'thumbnail',thumbnail),
      seller_id=(p_item->>'seller_id')::bigint,seller_name=p_item->>'seller_name',last_error=null
      where id=item.id returning * into item;
  else
    select * into item from ml.ml_tracked_items where target_kind=p_item->>'target_kind' and target_id=p_item->>'target_id' for update;
    if found then
      if item.active then raise exception 'Target is already tracked' using errcode='23505'; end if;
      update ml.ml_tracked_items set active=true,our_sku=p_item->>'our_sku',title=coalesce(p_item->>'title',title),
        thumbnail=coalesce(p_item->>'thumbnail',thumbnail),seller_id=coalesce((p_item->>'seller_id')::bigint,seller_id),
        seller_name=coalesce(p_item->>'seller_name',seller_name) where id=item.id returning * into item;
      reactivated:=true;
    else
      insert into ml.ml_tracked_items(ml_item_id,target_kind,target_id,url,title,thumbnail,seller_id,seller_name,our_sku)
      values(p_item->>'target_id',p_item->>'target_kind',p_item->>'target_id',p_item->>'url',p_item->>'title',p_item->>'thumbnail',
        (p_item->>'seller_id')::bigint,p_item->>'seller_name',p_item->>'our_sku') returning * into item;
    end if;
  end if;
  update ml.ml_tracked_items set source_kind=coalesce(p_item->>'source_kind',source_kind),source_id=coalesce(p_item->>'source_id',target_id),
    source_url=ml.monitor_source_url(coalesce(p_item->>'source_kind',source_kind),coalesce(p_item->>'source_id',target_id),coalesce(p_item->>'source_url',url)) where id=item.id;
  if p_snapshot is not null then
    insert into ml.ml_tracked_snapshots(tracked_item_id,price,original_price,sale_price,available_quantity,sold_quantity,status,health,observation,currency_id,selected_item_id,seller_id,seller_name)
    select item.id,price,original_price,sale_price,available_quantity,sold_quantity,status,health,observation,currency_id,selected_item_id,seller_id,seller_name
    from jsonb_populate_record(null::ml.ml_tracked_snapshots,p_snapshot);
    update ml.ml_tracked_items set last_scraped_at=now() where id=item.id returning * into item;
  end if;
  return jsonb_build_object('id',item.id,'reactivated',reactivated);
end $$;

create or replace function ml.record_monitor_observation(p_id text,p_expected bigint,p_update jsonb,p_events jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_row ml.ml_competitor_items; incoming ml.ml_competitor_items; e jsonb; inserted integer:=0; canonical ml.ml_item_observations; physical text; event_id uuid; origin jsonb;
begin
 select * into current_row from ml.ml_competitor_items where id=p_id for update;
 if not found then raise exception 'Rival inexistente'; end if;
 if current_row.observation_revision<>p_expected then return jsonb_build_object('conflict',true); end if;
 if (p_update->'observation'->>'observedAt')::timestamptz <= (current_row.observation->>'observedAt')::timestamptz
 then return jsonb_build_object('obsolete',true,'alerts',0); end if;
 physical:=coalesce(p_update->'observation'->>'itemId',current_row.source_id,p_id);
 if coalesce((p_update->'observation'->>'amount')::numeric,0)>0 and p_update->'observation'->>'currency' is not null then
   perform pg_advisory_xact_lock(hashtextextended('price:'||physical,0));
   select * into canonical from ml.ml_item_observations where item_id=physical for update;
   if found and canonical.observed_at>(p_update->'observation'->>'observedAt')::timestamptz and
     (canonical.amount,canonical.currency)<>((p_update->'observation'->>'amount')::numeric,p_update->'observation'->>'currency')
   then return jsonb_build_object('obsolete',true,'alerts',0); end if;
   insert into ml.ml_item_observations(item_id,amount,currency,revision,observed_at)
   values(physical,(p_update->'observation'->>'amount')::numeric,p_update->'observation'->>'currency',1,(p_update->'observation'->>'observedAt')::timestamptz)
   on conflict(item_id) do update set revision=ml_item_observations.revision+case when (ml_item_observations.amount,ml_item_observations.currency)<>(excluded.amount,excluded.currency) then 1 else 0 end,
     amount=excluded.amount,currency=excluded.currency,observed_at=greatest(ml_item_observations.observed_at,excluded.observed_at)
   returning * into canonical;
 end if;
 incoming:=jsonb_populate_record(current_row,p_update);
 update ml.ml_competitor_items set title=incoming.title,thumbnail=incoming.thumbnail,permalink=incoming.permalink,
 source_kind=incoming.source_kind,source_id=incoming.source_id,source_url=incoming.source_url,price=incoming.price,currency_id=incoming.currency_id,usd_price=incoming.usd_price,seller_id=incoming.seller_id,
 seller_name=incoming.seller_name,status=incoming.status,condition=incoming.condition,attributes=incoming.attributes,
 available_quantity=incoming.available_quantity,sold_quantity=incoming.sold_quantity,observation=incoming.observation,
 synced_at=incoming.synced_at,last_error=null,last_attempt_at=incoming.last_attempt_at,
 previous_price=incoming.previous_price,availability=incoming.availability,observation_revision=p_expected+1
 where id=p_id;
 for e in select value from jsonb_array_elements(p_events) loop
   if ml.monitor_alert_archive_reason(e->>'our_product_id',p_id) is not null then continue; end if;
   select alert_id into event_id from ml.ml_price_event_claims where own_id=e->>'our_product_id' and item_id=physical and revision=canonical.revision;
   if event_id is null then
   event_id:=gen_random_uuid();
   insert into ml.ml_price_alerts(id,rule_id,our_sku,our_product_id,competitor_item_id,our_price,catalog_price,
     competitor_price_before,competitor_price_after,diff_pct,fired_at,comparison_snapshot,event_snapshot,
     matched_rules,event_revision,event_target_id,is_legacy)
   values(event_id,(e->>'rule_id')::uuid,e->>'our_sku',e->>'our_product_id',p_id,(e->>'our_price')::numeric,
     (e->>'catalog_price')::numeric,(e->>'competitor_price_before')::numeric,(e->>'competitor_price_after')::numeric,
     (e->>'diff_pct')::numeric,(e->>'fired_at')::timestamptz,e->'comparison_snapshot',e->'event_snapshot',
     e->'matched_rules',p_expected+1,p_id,false);
   insert into ml.ml_price_event_claims values(e->>'our_product_id',physical,canonical.revision,event_id);
   inserted:=inserted+1;
   end if;
   insert into ml.ml_price_event_origins(alert_id,rival_id,association_ids,detected_at)
   values(event_id,p_id,coalesce(e->'comparison_snapshot'->'associationIds','[]'::jsonb),(e->>'fired_at')::timestamptz)
   on conflict do nothing;
   for origin in select src from jsonb_array_elements(coalesce(e->'event_snapshot'->'rows','[]')) r
     cross join lateral jsonb_array_elements(coalesce(r->'sources','[]')) src
     where r->>'mlu'=physical loop
     insert into ml.ml_price_event_origins(alert_id,rival_id,association_ids,detected_at)
     values(event_id,origin->>'rivalId',coalesce(origin->'associationIds','[]'),(e->>'fired_at')::timestamptz) on conflict do nothing;
   end loop;
 end loop;
 return jsonb_build_object('alerts',inserted,'revision',p_expected+1);
end $$;


create function ml.monitor_event_archive_reason(p_alert uuid) returns text
language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from ml.ml_price_event_origins o where o.alert_id=a.id and ml.monitor_alert_archive_reason(a.our_product_id,o.rival_id) is null)
 then null else ml.monitor_alert_archive_reason(a.our_product_id,a.competitor_item_id) end
 from ml.ml_price_alerts a where a.id=p_alert;
$$;
create or replace function ml.reconcile_monitor_alerts(p_own text default null,p_rival text default null) returns integer
language plpgsql security invoker set search_path='' as $$
declare affected integer;
begin
 with invalid as (
 select a.id,ml.monitor_event_archive_reason(a.id) reason from ml.ml_price_alerts a where a.archived_at is null
 and (p_own is null or a.our_product_id=p_own)
 and (p_rival is null or a.competitor_item_id=p_rival or exists(select 1 from ml.ml_price_event_origins o where o.alert_id=a.id and o.rival_id=p_rival))
 ) update ml.ml_price_alerts a set archived_at=now(),archive_reason=i.reason,archived_by=null
 from invalid i where a.id=i.id and i.reason is not null;
 get diagnostics affected=row_count;return affected;
end $$;

create function ml.complete_monitor_fixed_recovery(p_key text,p_item jsonb,p_actor uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare repair ml.ml_monitor_repairs; result jsonb; link_id uuid;
begin
 select * into repair from ml.ml_monitor_repairs where key=p_key and kind='recover_fixed' for update;
 if not found then raise exception 'Recuperación inexistente'; end if;
 if repair.status='resolved' then return repair.evidence; end if;
 if p_item->>'source_kind'<>'item' or (p_item->'observation'->>'sellerId')::bigint is distinct from repair.expected_seller_id
 or p_item->'observation'->>'catalogProductId' is distinct from repair.catalog_id
 or p_item->'observation'->'resolution'->>'sourceId' is distinct from p_item->>'source_id'
 or p_item->'observation'->>'itemId' is distinct from p_item->>'source_id'
 or p_item->'observation'->'resolution'->>'sourceKind' is distinct from 'item'
 or nullif(p_item->'observation'->'resolution'->>'validatedAt','') is null
 then raise exception 'La publicación no acredita el vendedor y catálogo originales'; end if;
 if exists(select 1 from ml.ml_competitor_items c join ml.ml_competitor_links l on l.competitor_item_id=c.id
 where c.source_kind='item' and c.source_id=p_item->>'source_id' and l.scope='sku' and l.our_sku=repair.sku and (l.removed_at is not null or l.equivalence='rejected'))
 then raise exception 'Se conserva la decisión posterior del operador sobre esta asociación'; end if;
 result:=ml.link_competitor(p_item,'sku',repair.sku);
 link_id:=(result->'association'->>'id')::uuid;
 update ml.ml_competitor_links set equivalence='accepted',review_source='legacy_manual_assignment',reviewed_at=coalesce(reviewed_at,now()),updated_at=now()
 where id=link_id and equivalence='pending';
 update ml.ml_monitor_repairs set status='resolved',last_error=null,actor=p_actor,updated_at=now(),
 evidence=evidence||jsonb_build_object('resolvedRivalId',result->'item'->>'id','associationId',link_id,'itemId',p_item->>'source_id','resolution',p_item->'observation'->'resolution') where key=p_key;
 return result;
end $$;

create function ml.repair_verified_source_archives(p_rival text) returns integer
language plpgsql security invoker set search_path='' as $$
declare c ml.ml_competitor_items; repair ml.ml_monitor_repairs; affected integer:=0;
begin
 select * into c from ml.ml_competitor_items where id=p_rival for update;
 if c.availability<>'available' or c.status<>'active'
 or c.observation->'resolution'->>'sourceId' is distinct from c.source_id
 or c.observation->'resolution'->>'sourceKind' is distinct from c.source_kind
 or nullif(c.observation->'resolution'->>'validatedAt','') is null
 or coalesce((c.observation->>'normalizedAmount')::numeric,0)<=0 then return 0; end if;
 for repair in select * from ml.ml_monitor_repairs where kind='archive_correction' and rival_id=p_rival and status='pending' for update loop
   if ml.monitor_event_archive_reason(repair.alert_id) is null then
     update ml.ml_price_alerts set archived_at=null,archive_reason=null,archived_by=null,archive_batch_id=null
     where id=repair.alert_id and archive_reason='rival_unavailable';
     if found then
       update ml.ml_monitor_repairs set status='resolved',updated_at=now(),evidence=evidence||jsonb_build_object('resolution',c.observation->'resolution','after',jsonb_build_object('archived_at',null,'archive_reason',null)) where key=repair.key;
       affected:=affected+1;
     end if;
   end if;
 end loop;
 return affected;
end $$;

revoke all on function ml.monitor_source_url(text,text,text),ml.monitor_source_defaults(),ml.monitor_event_archive_reason(uuid),
 ml.complete_monitor_fixed_recovery(text,jsonb,uuid),ml.repair_verified_source_archives(text) from public,anon,authenticated;
grant execute on function ml.monitor_source_url(text,text,text),ml.monitor_source_defaults(),ml.monitor_event_archive_reason(uuid),
 ml.complete_monitor_fixed_recovery(text,jsonb,uuid),ml.repair_verified_source_archives(text) to service_role;

create or replace function ml.restore_monitor_alert(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a ml.ml_price_alerts; reason text;
begin
 select * into a from ml.ml_price_alerts where id=p_id for update;
 if not found then raise exception 'Alerta inexistente'; end if;
 if a.archived_at is null then return to_jsonb(a); end if;
 if a.archive_reason<>'manual' then raise exception 'Solo se puede deshacer un archivo manual'; end if;
 reason:=ml.monitor_event_archive_reason(a.id);
 if reason is not null then raise exception 'La publicación ya no está disponible: %',reason; end if;
 update ml.ml_price_alerts set archived_at=null,archive_reason=null,archived_by=null,archive_batch_id=null where id=p_id returning * into a;
 return to_jsonb(a);
end $$;


create or replace function ml.restore_monitor_alert_batch(p_batch uuid,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare restored integer; pending integer;
begin
 select count(*) into pending from ml.ml_price_alerts where archive_batch_id=p_batch and archived_by=p_actor and archive_reason='manual';
 update ml.ml_price_alerts set archived_at=null,archive_reason=null,archived_by=null,archive_batch_id=null
 where archive_batch_id=p_batch and archived_by=p_actor and archive_reason='manual'
 and ml.monitor_event_archive_reason(id) is null;
 get diagnostics restored=row_count;
 return jsonb_build_object('ok',true,'count',restored,'blocked',pending-restored);
end $$;
