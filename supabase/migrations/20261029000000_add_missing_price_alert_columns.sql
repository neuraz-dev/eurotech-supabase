-- Columns already used by the monitor UI and both competitor sync paths.
alter table ml.ml_price_alert_rules
  add column if not exists compare_catalog_price boolean not null default true;

alter table ml.ml_price_alerts
  add column if not exists catalog_price numeric(18,2);

-- Historical catalog prices are unknown and deliberately remain NULL.
notify pgrst, 'reload schema';
