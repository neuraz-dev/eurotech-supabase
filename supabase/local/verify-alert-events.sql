\set ON_ERROR_STOP on
begin;
do $$
declare own_id text:='MONITOR-EVENT-TEST-OWN'; rival_id text:='MONITOR-EVENT-TEST-RIVAL';
 rule_id uuid:=gen_random_uuid(); event_id uuid; other_rule uuid:=gen_random_uuid(); result jsonb;
 update_body jsonb; event_body jsonb; snapshot jsonb; original_snapshot jsonb; batch_id uuid:=gen_random_uuid();
 actor_id uuid:=gen_random_uuid(); count_before integer; previous_revision bigint;
begin
 select count(*) into count_before from ml.ml_price_alerts;
 if exists(select 1 from ml.ml_products where id=own_id) then raise exception 'Test identity collision'; end if;
 insert into ml.ml_products(id,sku,title,status,price,currency_id,synced_at)
 values(own_id,'monitor-event-test','Prueba temporal','active',100,'UYU','2020-01-01');
 insert into ml.ml_competitor_items(id,our_sku,title,status,price,currency_id,observation)
 values(rival_id,'monitor-event-test','Rival temporal','active',90,'UYU',
 '{"amount":90,"currency":"UYU","normalizedAmount":90,"observedAt":"2020-01-01T00:00:00Z"}');
 insert into ml.ml_competitor_links(competitor_item_id,scope,our_product_id,equivalence)
 values(rival_id,'publication',own_id,'accepted');
 insert into ml.ml_price_alert_rules(id,name,rule_type,threshold_pct) values(rule_id,'Regla temporal','price_diff_pct_above',1);
 insert into ml.ml_price_alert_rules(id,name,rule_type,threshold_pct) values(other_rule,'Otra regla temporal','price_diff_pct_above',5);
 snapshot:=jsonb_build_object('version',2,'legacy',false,'relativePct',-20,'rows','[]'::jsonb,
   'own',jsonb_build_object('id',own_id,'sku','monitor-event-test','title','Prueba temporal'),
   'rival',jsonb_build_object('id',rival_id,'sellerName','Vendedor de prueba'));
 event_body:=jsonb_build_object('rule_id',rule_id,'our_sku','monitor-event-test','our_product_id',own_id,
   'our_price',100,'competitor_price_before',90,'competitor_price_after',80,'diff_pct',20,
   'fired_at','2026-01-01T00:00:00Z','event_snapshot',snapshot,
   'matched_rules',jsonb_build_array(jsonb_build_object('id',rule_id,'name','Regla temporal'),jsonb_build_object('id',other_rule,'name','Otra regla temporal')));
 update_body:='{"price":80,"availability":"available","status":"active","observation":{"amount":80,"currency":"UYU","normalizedAmount":80,"observedAt":"2026-01-01T00:00:00Z"}}';
 result:=ml.record_monitor_observation(rival_id,0,update_body,jsonb_build_array(event_body));
 if (result->>'alerts')::integer<>1 then raise exception 'Event not recorded atomically'; end if;
 result:=ml.record_monitor_observation(rival_id,0,update_body,jsonb_build_array(event_body));
 if result->>'conflict'<>'true' then raise exception 'Stale revision was accepted'; end if;
 if (select count(*) from ml.ml_price_alerts)<>count_before+1 then raise exception 'Duplicate or lost event'; end if;
 select id,event_snapshot into event_id,original_snapshot from ml.ml_price_alerts where event_target_id=rival_id;
 if (select jsonb_array_length(matched_rules) from ml.ml_price_alerts where id=event_id)<>2 then raise exception 'Matching rules lost'; end if;
 begin
   perform ml.record_monitor_observation(rival_id,1,
     '{"price":70,"observation":{"amount":70,"currency":"UYU","observedAt":"2026-01-02T00:00:00Z"}}',
     jsonb_build_array(event_body||'{"rule_id":"00000000-0000-0000-0000-000000000099"}'::jsonb));
   raise exception 'Invalid FK accepted';
 exception when foreign_key_violation then null; end;
 if (select observation_revision from ml.ml_competitor_items where id=rival_id)<>1
   or (select price from ml.ml_competitor_items where id=rival_id)<>80 then raise exception 'Observation survived failed event transaction'; end if;
 begin
   update ml.ml_price_alerts set our_price=1 where id=event_id;
   raise exception 'Immutable event changed';
 exception when others then if sqlerrm='Immutable event changed' then raise; end if; end;
 update ml.ml_products set status='paused' where id=own_id;
 if (select archive_reason from ml.ml_price_alerts where id=event_id)<>'own_inactive' then raise exception 'Own pause did not archive'; end if;
 update ml.ml_products set status='active' where id=own_id;
 if (select archived_at from ml.ml_price_alerts where id=event_id) is null then raise exception 'Reactivation restored history'; end if;
 -- New event after reactivation; the earlier event remains archived.
 event_body:=event_body||'{"fired_at":"2026-01-02T00:00:00Z","competitor_price_after":70}'::jsonb;
 perform ml.record_monitor_observation(rival_id,1,
   '{"price":70,"observation":{"amount":70,"currency":"UYU","normalizedAmount":70,"observedAt":"2026-01-02T00:00:00Z"}}',jsonb_build_array(event_body));
 select id into event_id from ml.ml_price_alerts where event_target_id=rival_id and archived_at is null;
 result:=ml.list_monitor_alerts('{"scope":"inbox","sku":"monitor-event-test"}');
 if (result->'counts'->>'total')::integer<>1 then raise exception 'Inbox count incorrect'; end if;
 update ml.ml_price_alerts set read_at=now() where id=event_id;
 result:=ml.mutate_monitor_alerts('archive_read','{"scope":"inbox","sku":"monitor-event-test"}',actor_id,batch_id);
 if (result->>'count')::integer<>1 then raise exception 'Bulk archive scope incorrect'; end if;
 result:=ml.restore_monitor_alert_batch(batch_id,actor_id);
 if (result->>'count')::integer<>1 then raise exception 'Bulk undo failed'; end if;
 update ml.ml_competitor_items set last_error='Mercado Libre HTTP 503' where id=rival_id;
 if (select archived_at from ml.ml_price_alerts where id=event_id) is not null then raise exception 'Technical error archived event'; end if;
 -- Another enabled origin keeps the comparison available.
 insert into ml.ml_competitor_links(competitor_item_id,scope,our_sku,equivalence)
 values(rival_id,'sku','monitor-event-test','accepted');
 update ml.ml_competitor_links set paused=true where competitor_item_id=rival_id and scope='publication';
 if (select archived_at from ml.ml_price_alerts where id=event_id) is not null then raise exception 'Other origin ignored'; end if;
 update ml.ml_competitor_links set paused=true where competitor_item_id=rival_id and scope='sku';
 if (select archive_reason from ml.ml_price_alerts where id=event_id)<>'association_disabled' then raise exception 'Disabled association did not archive'; end if;
 update ml.ml_competitor_links set paused=false where competitor_item_id=rival_id;
 -- Undo cannot restore an unavailable own publication.
 update ml.ml_price_alerts set archive_reason='manual',archived_by=actor_id where id=event_id;
 update ml.ml_products set status='under_review' where id=own_id;
 begin
   perform ml.restore_monitor_alert(event_id);
   raise exception 'Unavailable event restored';
 exception when others then if sqlerrm='Unavailable event restored' then raise; end if; end;
 -- Rule/rival deletion must not delete the immutable event.
 delete from ml.ml_price_alert_rules where id=rule_id;
 delete from ml.ml_competitor_links where competitor_item_id=rival_id;
 delete from ml.ml_competitor_items where id=rival_id;
 if (select count(*) from ml.ml_price_alerts where event_target_id=rival_id)<>2 then raise exception 'Cascade deleted history'; end if;
 if (select event_snapshot from ml.ml_price_alerts where id=event_id) is distinct from original_snapshot then raise exception 'Snapshot mutated'; end if;
 -- Pagination: dates may tie; stable UUID ordering must preserve every row.
 insert into ml.ml_price_alerts(our_sku,our_product_id,fired_at,event_snapshot,archived_at,archive_reason)
 select 'monitor-event-page',own_id,'2026-01-03',snapshot,now(),'manual' from generate_series(1,55);
 result:=ml.list_monitor_alerts('{"scope":"history","sku":"monitor-event-page"}');
 if (result->'counts'->>'total')::integer<>55 or jsonb_array_length(result->'items')<>51 then raise exception 'Pagination/count incorrect'; end if;
 result:=ml.list_monitor_alerts('{"scope":"history","sku":"monitor-event-page"}',
   (result->'items'->49->>'fired_at')::timestamptz,(result->'items'->49->>'id')::uuid);
 if jsonb_array_length(result->'items')<>5 then raise exception 'Cursor lost rows'; end if;
 result:=ml.list_monitor_alerts('{"scope":"history","sku":"monitor-event-page","from":"2026-01-04T00:00:00Z"}');
 if (result->'counts'->>'total')::integer<>0 then raise exception 'Date filter ignored'; end if;
 if has_function_privilege('anon','ml.record_monitor_observation(text,bigint,jsonb,jsonb)','execute') then raise exception 'Privileged mutation exposed'; end if;
 raise notice 'Event transactions, immutable snapshots, archive/undo, cascade preservation, dates and pagination verified';
end $$;
rollback;
