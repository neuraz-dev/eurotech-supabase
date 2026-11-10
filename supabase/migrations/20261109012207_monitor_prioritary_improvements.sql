-- Additive Monitor cutover. Historical amounts and associations remain untouched.
create function ml.normalize_monitor_sku(value text) returns text
language sql immutable strict parallel safe security invoker set search_path='' as $$
  select nullif(lower(btrim(value, E' \t\n\r\f\013' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), '');
$$;
revoke all on function ml.normalize_monitor_sku(text) from public,anon,authenticated;
grant execute on function ml.normalize_monitor_sku(text) to service_role;
create table ml.ml_monitoring_settings (
  singleton boolean primary key default true check(singleton),
  max_age_hours numeric not null default 4 check(max_age_hours > 0 and max_age_hours <= 168)
);
insert into ml.ml_monitoring_settings default values;

alter table ml.ml_competitor_items alter column our_sku drop not null;
alter table ml.ml_competitor_items
  add column target_kind text not null default 'item' check(target_kind in ('item','catalog')),
  add column attributes jsonb,
  add column observation jsonb,
  add column last_attempt_at timestamptz,
  add column last_error text;
update ml.ml_competitor_items set target_kind = 'catalog'
where permalink ~ '/(p|up)/ML[A-Z]+[0-9]+';

create table ml.ml_competitor_links (
  id uuid primary key default gen_random_uuid(),
  competitor_item_id varchar(50) not null references ml.ml_competitor_items(id) on delete restrict,
  scope text not null check(scope in ('publication','sku')),
  our_product_id varchar(50),
  our_sku text,
  paused boolean not null default false,
  equivalence text not null default 'pending' check(equivalence in ('pending','accepted','rejected')),
  reviewed_at timestamptz,
  reviewed_by uuid,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'publication' and nullif(our_product_id,'') is not null and our_sku is null)
    or (scope = 'sku' and our_product_id is null and ml.normalize_monitor_sku(our_sku) is not null and our_sku = ml.normalize_monitor_sku(our_sku)))
);
create unique index ml_competitor_link_publication on ml.ml_competitor_links(competitor_item_id,our_product_id) where scope='publication';
create unique index ml_competitor_link_sku on ml.ml_competitor_links(competitor_item_id,our_sku) where scope='sku';
create index ml_competitor_links_target on ml.ml_competitor_links(our_product_id,our_sku);
create index if not exists ml_products_normalized_sku on ml.ml_products(ml.normalize_monitor_sku(sku));

insert into ml.ml_competitor_links(competitor_item_id,scope,our_product_id,our_sku,paused)
select id, case when nullif(our_product_id,'') is not null then 'publication' else 'sku' end,
  nullif(our_product_id,''), case when nullif(our_product_id,'') is null then ml.normalize_monitor_sku(our_sku) end, paused
from ml.ml_competitor_items
where nullif(our_product_id,'') is not null or ml.normalize_monitor_sku(our_sku) is not null;

alter table ml.ml_products
  add column catalog_item_id varchar(50),
  add column catalog_currency_id varchar(10),
  add column catalog_observed_at timestamptz,
  add column catalog_observation jsonb,
  add column catalog_competition jsonb,
  add column fx_quote jsonb;
alter table ml.ml_price_alerts
  add column our_product_id varchar(50),
  add column comparison_snapshot jsonb;

-- The original deployment had these tables in its initial dump, not its migrations.
create table if not exists ml.ml_tracked_items (
  id uuid primary key default gen_random_uuid(), ml_item_id varchar(50) not null unique,
  url text, title text, thumbnail text, seller_name text, seller_id bigint, our_sku text,
  active boolean not null default true, created_at timestamptz not null default now(), last_scraped_at timestamptz
);
create table if not exists ml.ml_tracked_snapshots (
  id uuid primary key default gen_random_uuid(),
  tracked_item_id uuid not null references ml.ml_tracked_items(id) on delete cascade,
  price numeric, original_price numeric, sale_price numeric, available_quantity integer,
  sold_quantity integer, status text, health numeric, scraped_at timestamptz not null default now()
);
alter table ml.ml_tracked_items
  add column target_kind text not null default 'item' check(target_kind in ('item','catalog')),
  add column target_review_required boolean not null default false,
  add column target_id varchar(50),
  add column last_error text,
  add column last_attempt_at timestamptz;
-- A catalog URL that resolved to a concrete MLU stays FIXED to that stored MLU.
update ml.ml_tracked_items set target_id=ml_item_id;
update ml.ml_tracked_items set target_review_required=true where target_kind='item' and url ~ ('/(p|up)/'||ml_item_id||'([/?#]|$)');
alter table ml.ml_tracked_items alter column target_id set not null;
create unique index ml_tracked_target on ml.ml_tracked_items(target_kind,target_id);
alter table ml.ml_tracked_snapshots
  add column if not exists sale_price numeric;
alter table ml.ml_tracked_snapshots
  add column observation jsonb,
  add column currency_id varchar(10),
  add column selected_item_id varchar(50),
  add column seller_id bigint,
  add column seller_name text;
create index if not exists ml_tracked_history on ml.ml_tracked_snapshots(tracked_item_id,scraped_at desc,id desc);

alter table ml.ml_monitoring_settings enable row level security;
alter table ml.ml_competitor_links enable row level security;
alter table ml.ml_tracked_items enable row level security;
alter table ml.ml_tracked_snapshots enable row level security;
revoke all on ml.ml_monitoring_settings, ml.ml_competitor_links from public,anon,authenticated;
grant all on ml.ml_monitoring_settings, ml.ml_competitor_links, ml.ml_tracked_items, ml.ml_tracked_snapshots to service_role;

-- Atomic, repeatable insert of object + association. The object's old owner is never reassigned.
create function ml.link_competitor(p_item jsonb,p_scope text,p_target text)
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
  on conflict(id) do update set
    title=coalesce(excluded.title,ml.ml_competitor_items.title),
    thumbnail=coalesce(excluded.thumbnail,ml.ml_competitor_items.thumbnail),
    observation=coalesce(excluded.observation,ml.ml_competitor_items.observation),
    price=case when excluded.observation is not null then excluded.price else ml.ml_competitor_items.price end,
    currency_id=case when excluded.observation is not null then excluded.currency_id else ml.ml_competitor_items.currency_id end,
    synced_at=coalesce(excluded.synced_at,ml.ml_competitor_items.synced_at),
    status=case when excluded.observation is not null then excluded.status else ml.ml_competitor_items.status end,
    seller_id=coalesce(excluded.seller_id,ml.ml_competitor_items.seller_id),
    seller_name=coalesce(excluded.seller_name,ml.ml_competitor_items.seller_name),
    condition=coalesce(excluded.condition,ml.ml_competitor_items.condition),
    attributes=coalesce(excluded.attributes,ml.ml_competitor_items.attributes)
  returning * into rival;
  if rival.target_kind<>p_item->>'target_kind' then raise exception 'This ID already has another target type'; end if;
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
revoke all on function ml.link_competitor(jsonb,text,text) from public,anon,authenticated;
grant execute on function ml.link_competitor(jsonb,text,text) to service_role;

create function ml.save_tracking(p_item jsonb,p_snapshot jsonb)
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
  if p_snapshot is not null then
    insert into ml.ml_tracked_snapshots(tracked_item_id,price,original_price,sale_price,available_quantity,sold_quantity,status,health,observation,currency_id,selected_item_id,seller_id,seller_name)
    select item.id,price,original_price,sale_price,available_quantity,sold_quantity,status,health,observation,currency_id,selected_item_id,seller_id,seller_name
    from jsonb_populate_record(null::ml.ml_tracked_snapshots,p_snapshot);
    update ml.ml_tracked_items set last_scraped_at=now() where id=item.id returning * into item;
  end if;
  return jsonb_build_object('id',item.id,'reactivated',reactivated);
end $$;
revoke all on function ml.save_tracking(jsonb,jsonb) from public,anon,authenticated;
grant execute on function ml.save_tracking(jsonb,jsonb) to service_role;
