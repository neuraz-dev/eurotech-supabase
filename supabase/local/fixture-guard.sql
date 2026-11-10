-- Local fixtures only; this file is never a production migration.
create table if not exists ml.monitor_local_fixture_guard (id text primary key);
alter table ml.monitor_local_fixture_guard enable row level security;
revoke all on ml.monitor_local_fixture_guard from public,anon,authenticated;
grant select on ml.monitor_local_fixture_guard to service_role;
insert into ml.monitor_local_fixture_guard values ('eurotech-monitor-improvements') on conflict do nothing;
