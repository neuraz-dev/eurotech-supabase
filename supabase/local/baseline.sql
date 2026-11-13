-- Local-only baseline: table DDL only. No cron, Vault secrets, or remote calls.
-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- MercadoLibre token storage (persists refresh_token entre reinicios)
create table if not exists public.ml_tokens (
  id           serial primary key,
  access_token text not null,
  refresh_token text,
  expires_at   timestamptz not null,
  user_id      bigint not null,
  updated_at   timestamptz default now()
);

-- ⚠️ Insertar el token manualmente desde el SQL Editor después del deploy:
-- insert into public.ml_tokens (access_token, refresh_token, expires_at, user_id)
-- values ('TU_ACCESS_TOKEN', 'TU_REFRESH_TOKEN', now() + interval '6 hours', 92078889);

-- Tabla principal de productos MercadoLibre con todas las columnas disponibles
create table if not exists public.ml_products (
  -- Identificadores
  id                          varchar(50) primary key,
  site_id                     varchar(10),
  catalog_product_id          varchar(50),
  parent_item_id              varchar(50),
  seller_custom_field         varchar(255),
  domain_id                   varchar(100),

  -- Información básica
  title                       text,
  subtitle                    text,
  condition                   varchar(20),
  listing_type_id             varchar(50),
  buying_mode                 varchar(50),
  status                      varchar(30),
  sub_status                  jsonb,
  tags                        jsonb,
  listing_source              varchar(100),
  international_delivery_mode varchar(50),

  -- Precios
  price                       numeric(18, 2),
  base_price                  numeric(18, 2),
  original_price              numeric(18, 2),
  currency_id                 varchar(10),

  -- Stock
  initial_quantity            integer,
  available_quantity          integer,
  sold_quantity               integer,

  -- Seller & Store
  seller_id                   bigint,
  official_store_id           integer,

  -- Categoría
  category_id                 varchar(50),

  -- URLs y media
  permalink                   text,
  thumbnail                   text,
  thumbnail_id                varchar(100),
  video_id                    varchar(100),
  pictures                    jsonb,

  -- Fechas
  start_time                  timestamptz,
  stop_time                   timestamptz,
  end_time                    timestamptz,
  expiration_time             timestamptz,
  date_created                timestamptz,
  last_updated                timestamptz,

  -- Pagos y envíos
  accepts_mercadopago         boolean,
  non_mercado_pago_payment_methods jsonb,
  shipping                    jsonb,

  -- Atributos y variaciones
  attributes                  jsonb,
  variations                  jsonb,
  sale_terms                  jsonb,
  descriptions                jsonb,

  -- Garantía
  warranty                    text,

  -- Ubicación
  seller_address              jsonb,
  location                    jsonb,
  geolocation                 jsonb,
  coverage_areas              jsonb,

  -- Métricas
  health                      numeric(5, 4),
  catalog_listing             boolean,
  automatic_relist            boolean,
  differential_pricing        jsonb,
  deal_ids                    jsonb,

  -- Sync metadata
  synced_at                   timestamptz default now(),
  raw_data                    jsonb
);

-- Índices para búsquedas frecuentes
create index if not exists idx_ml_products_seller_id    on public.ml_products (seller_id);
create index if not exists idx_ml_products_category_id  on public.ml_products (category_id);
create index if not exists idx_ml_products_status       on public.ml_products (status);
create index if not exists idx_ml_products_last_updated on public.ml_products (last_updated desc);
create index if not exists idx_ml_products_price        on public.ml_products (price);
create index if not exists idx_ml_products_synced_at    on public.ml_products (synced_at desc);

-- RLS
alter table public.ml_products enable row level security;
alter table public.ml_tokens   enable row level security;

-- Solo service_role puede acceder
create policy "service_role only" on public.ml_products
  for all using (auth.role() = 'service_role');

create policy "service_role only" on public.ml_tokens
  for all using (auth.role() = 'service_role');


-- Columnas adicionales descubiertas en la respuesta real de la API de MercadoLibre
alter table public.ml_products
  add column if not exists family_name       text,
  add column if not exists family_id         varchar(50),
  add column if not exists user_product_id   varchar(100),
  add column if not exists inventory_id      varchar(100),
  add column if not exists seller_contact    jsonb,
  add column if not exists warnings          jsonb,
  add column if not exists item_relations    jsonb,
  add column if not exists channels          jsonb;

-- ─── Preguntas y respuestas ────────────────────────────────────────────────
create table if not exists public.ml_questions (
  id                    bigint primary key,
  item_id               varchar(50) not null,
  seller_id             bigint,
  from_user_id          bigint,
  status                varchar(30),
  text                  text,
  tags                  jsonb,
  hold                  boolean,
  deleted_from_listing  boolean,
  date_created          timestamptz,

  -- Respuesta
  answer_text           text,
  answer_status         varchar(30),
  answer_date_created   timestamptz,

  synced_at             timestamptz default now()
);

create index if not exists idx_ml_questions_item_id   on public.ml_questions (item_id);
create index if not exists idx_ml_questions_seller_id on public.ml_questions (seller_id);
create index if not exists idx_ml_questions_status    on public.ml_questions (status);
create index if not exists idx_ml_questions_created   on public.ml_questions (date_created desc);

-- ─── Reputación e info del vendedor ────────────────────────────────────────
create table if not exists public.ml_seller (
  id                        bigint primary key,
  nickname                  varchar(100),
  first_name                varchar(100),
  last_name                 varchar(100),
  email                     text,
  contact_email             text,
  registration_date         timestamptz,
  country_id                varchar(10),
  site_id                   varchar(10),
  user_type                 varchar(50),
  seller_experience         varchar(50),
  points                    integer,
  permalink                 text,
  tags                      jsonb,
  logo                      text,
  address                   jsonb,
  phone                     jsonb,
  identification            jsonb,

  -- Reputación
  reputation_level          varchar(20),
  power_seller_status       varchar(30),
  sales_period              varchar(30),
  sales_completed           integer,
  claims_rate               numeric(8,6),
  claims_value              integer,
  delayed_handling_rate     numeric(8,6),
  delayed_handling_value    integer,
  cancellations_rate        numeric(8,6),
  cancellations_value       integer,
  transactions_total        integer,
  transactions_completed    integer,
  transactions_canceled     integer,
  ratings_positive          numeric(5,4),
  ratings_neutral           numeric(5,4),
  ratings_negative          numeric(5,4),

  synced_at                 timestamptz default now()
);

-- ─── Visitas diarias (nivel cuenta) ────────────────────────────────────────
create table if not exists public.ml_seller_visits (
  id          serial primary key,
  date        date not null,
  total       integer not null,
  synced_at   timestamptz default now(),
  unique (date)
);

create index if not exists idx_ml_seller_visits_date on public.ml_seller_visits (date desc);

-- ─── Visitas por item ───────────────────────────────────────────────────────
create table if not exists public.ml_item_visits (
  item_id     varchar(50) not null,
  date        date not null,
  visits      integer not null default 0,
  synced_at   timestamptz default now(),
  primary key (item_id, date)
);

create index if not exists idx_ml_item_visits_item on public.ml_item_visits (item_id);
create index if not exists idx_ml_item_visits_date on public.ml_item_visits (date desc);

-- ─── RLS ───────────────────────────────────────────────────────────────────
alter table public.ml_questions      enable row level security;
alter table public.ml_seller         enable row level security;
alter table public.ml_seller_visits  enable row level security;
alter table public.ml_item_visits    enable row level security;

create policy "service_role only" on public.ml_questions
  for all using (auth.role() = 'service_role');
create policy "service_role only" on public.ml_seller
  for all using (auth.role() = 'service_role');
create policy "service_role only" on public.ml_seller_visits
  for all using (auth.role() = 'service_role');
create policy "service_role only" on public.ml_item_visits
  for all using (auth.role() = 'service_role');

-- ─── Crons adicionales ─────────────────────────────────────────────────────
-- Preguntas: cada 2 horas
-- ─── SKU en ml_products ────────────────────────────────────────────────────
-- El SKU viene del atributo SELLER_SKU en la API de ML
alter table public.ml_products
  add column if not exists sku varchar(255);

create index if not exists idx_ml_products_sku on public.ml_products (sku);

-- ─── Tabla de productos de la competencia ──────────────────────────────────
create table if not exists public.ml_competitor_items (
  id            varchar(50)   primary key,          -- MLU/MLA... del competidor
  our_sku       varchar(255)  not null,              -- SKU de nuestro producto relacionado
  title         text,
  price         numeric(18,2),
  original_price numeric(18,2),
  currency_id   varchar(10),
  available_quantity integer,
  sold_quantity  integer,
  status        varchar(30),
  condition     varchar(20),
  listing_type_id varchar(50),
  category_id   varchar(50),
  permalink     text,
  thumbnail     text,
  seller_id     bigint,
  health        numeric(5,4),
  synced_at     timestamptz   default now(),
  created_at    timestamptz   default now()
);

create index if not exists idx_ml_competitor_items_sku    on public.ml_competitor_items (our_sku);
create index if not exists idx_ml_competitor_items_status on public.ml_competitor_items (status);

-- ─── RLS ───────────────────────────────────────────────────────────────────
alter table public.ml_competitor_items enable row level security;

do $$ begin
  create policy "service_role only" on public.ml_competitor_items
    for all using (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;


-- ─── Columna previous_price en ml_competitor_items ────────────────────────
alter table public.ml_competitor_items
  add column if not exists previous_price numeric(18,2);

-- ─── Enum de tipos de regla ────────────────────────────────────────────────
do $$ begin
  create type public.alert_rule_type as enum (
    'price_changed',
    'competitor_cheaper',
    'competitor_pricier',
    'price_diff_pct_above',
    'price_diff_pct_below'
  );
exception when duplicate_object then null; end $$;

-- ─── Tabla de reglas de alerta ─────────────────────────────────────────────
create table if not exists public.ml_price_alert_rules (
  id            uuid          primary key default gen_random_uuid(),
  name          text          not null,
  sku           varchar(255),                         -- NULL = global
  rule_type     alert_rule_type not null,
  threshold_pct numeric(8,2),                         -- solo para diff_pct_*
  enabled       boolean       not null default true,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index if not exists idx_ml_price_alert_rules_sku     on public.ml_price_alert_rules (sku);
create index if not exists idx_ml_price_alert_rules_enabled on public.ml_price_alert_rules (enabled);

alter table public.ml_price_alert_rules enable row level security;

create policy "service_role only" on public.ml_price_alert_rules
  for all using (auth.role() = 'service_role');

-- ─── Tabla de alertas disparadas ───────────────────────────────────────────
create table if not exists public.ml_price_alerts (
  id                    uuid          primary key default gen_random_uuid(),
  rule_id               uuid          not null references public.ml_price_alert_rules(id) on delete cascade,
  our_sku               varchar(255)  not null,
  competitor_item_id    varchar(50)   not null,
  our_price             numeric(18,2),
  competitor_price_before numeric(18,2),
  competitor_price_after  numeric(18,2),
  diff_pct              numeric(8,2),                 -- (our - competitor) / our * 100
  fired_at              timestamptz   not null default now()
);

create index if not exists idx_ml_price_alerts_rule_id  on public.ml_price_alerts (rule_id);
create index if not exists idx_ml_price_alerts_sku      on public.ml_price_alerts (our_sku);
create index if not exists idx_ml_price_alerts_fired_at on public.ml_price_alerts (fired_at desc);

alter table public.ml_price_alerts enable row level security;

create policy "service_role only" on public.ml_price_alerts
  for all using (auth.role() = 'service_role');


-- Precio que ML muestra en el catálogo (puede diferir del precio de publicación)
alter table public.ml_products
  add column if not exists catalog_price numeric(18,2);

-- Tabla de nombres de categorías ML
create table if not exists public.ml_categories (
  id         varchar(50) primary key,
  name       text        not null,
  updated_at timestamptz default now()
);

alter table public.ml_categories enable row level security;

create policy "service_role only" on public.ml_categories
  for all using (auth.role() = 'service_role');

alter table public.ml_categories
  add column if not exists full_path text;

alter table public.ml_categories
  add column if not exists full_path text;

alter table public.ml_products
  add column if not exists user_product_id varchar(100);

create index if not exists ml_products_user_product_id_idx
  on public.ml_products (user_product_id)
  where user_product_id is not null;

alter table public.ml_competitor_items
  add column if not exists paused boolean not null default false;

alter table public.ml_products
  add column if not exists buybox_price numeric(12, 2),
  add column if not exists buybox_seller_id bigint;

alter table public.ml_competitor_items
  add column if not exists seller_name varchar(255);

alter table public.ml_price_alerts
  add column if not exists read_at timestamptz;

create index if not exists idx_ml_price_alerts_unread
  on public.ml_price_alerts (fired_at desc)
  where read_at is null;

-- FK from ml_price_alerts.competitor_item_id → ml_competitor_items.id
-- Needed for PostgREST to resolve the join in the history query
alter table public.ml_price_alerts
  add constraint fk_price_alerts_competitor_item
  foreign key (competitor_item_id)
  references public.ml_competitor_items(id)
  on delete cascade;

create index if not exists idx_ml_price_alerts_competitor_item_id
  on public.ml_price_alerts (competitor_item_id);

-- Original USD price when the competitor item's price comes from ML in USD
-- price is always stored in UYU (converted); usd_price preserves the original
alter table public.ml_competitor_items
  add column if not exists usd_price numeric(18,2);

-- Precio promocional aplicado por ML (deals/campañas) — el que el cliente ve en la publicación
-- cuando hay una oferta activa. Distinto de `original_price` (descuento del vendedor).
alter table public.ml_products
  add column if not exists sale_price numeric(18,2);

-- Move MercadoLibre objects out of public into their own schema.
create schema if not exists ml;

grant usage on schema ml to anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  for table_name in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like 'ml\_%' escape '\'
  loop
    execute format('alter table public.%I set schema ml', table_name);
  end loop;
end $$;

do $$
begin
  alter type public.alert_rule_type set schema ml;
exception
  when undefined_object then null;
  when duplicate_object then null;
end $$;

grant all privileges on all tables in schema ml to service_role;
grant all privileges on all sequences in schema ml to service_role;
grant execute on all functions in schema ml to service_role;

alter default privileges in schema ml grant all on tables to service_role;
alter default privileges in schema ml grant all on sequences to service_role;
alter default privileges in schema ml grant execute on functions to service_role;

alter table ml.ml_competitor_items
  add column if not exists our_product_id varchar(50);

create index if not exists idx_ml_competitor_items_our_product_id
  on ml.ml_competitor_items (our_product_id);

-- Columns already used by the monitor UI and both competitor sync paths.
alter table ml.ml_price_alert_rules
  add column if not exists compare_catalog_price boolean not null default true;

alter table ml.ml_price_alerts
  add column if not exists catalog_price numeric(18,2);

-- Historical catalog prices are unknown and deliberately remain NULL.
notify pgrst, 'reload schema';

insert into ml.ml_products(id,title,sku,price,currency_id,status,seller_id,synced_at,catalog_listing) values
('MLU100','Producto de prueba',' SKU-TEST ',1000,'UYU','active',1,now(),false),
('MLU101','Producto de prueba catálogo','sku-test',1100,'UYU','active',1,now(),true),
('MLU102','Producto sin SKU',null,500,'UYU','active',1,now(),false);
insert into ml.ml_competitor_items(id,our_sku,our_product_id,title,price,currency_id,status,synced_at)
values('MLU200','sku-test',null,'Rival legado',900,'UYU','active',now());
