\set ON_ERROR_STOP on
begin;
do $$
declare own_id text:='MLU900090'; dynamic_id text:='MLU900099'; fixed_id text:='MLU900091'; rule_id uuid:=gen_random_uuid();
 event_id uuid; e jsonb; snapshot jsonb; body jsonb; result jsonb; recovered jsonb; n integer;
 repair_event uuid:=gen_random_uuid(); up_id text:='MLUU900200'; original_snapshot jsonb;
begin
 insert into ml.ml_products(id,sku,title,price,currency_id,status) values(own_id,'source-test','Own',100,'UYU','active');
 insert into ml.ml_competitor_items(id,target_kind,title,status,price,currency_id,observation)
 values(dynamic_id,'catalog','Dynamic','active',90,'UYU','{"amount":90,"currency":"UYU","observedAt":"2026-01-01T00:00:00Z"}'),
 (fixed_id,'item','Fixed','active',90,'UYU','{"amount":90,"currency":"UYU","observedAt":"2026-01-01T00:00:00Z"}');
 insert into ml.ml_competitor_links(competitor_item_id,scope,our_sku,equivalence) values(dynamic_id,'sku','source-test','accepted'),(fixed_id,'sku','source-test','accepted');
 insert into ml.ml_price_alert_rules(id,name,rule_type,enabled) values(rule_id,'Source test','competitor_cheaper',true);
 snapshot:=jsonb_build_object('version',2,'relativePct',-20,'own',jsonb_build_object('id',own_id),'rival',jsonb_build_object('id',dynamic_id),'rows','[]'::jsonb);
 e:=jsonb_build_object('rule_id',rule_id,'our_product_id',own_id,'our_sku','source-test','our_price',100,'competitor_price_after',80,'diff_pct',20,'fired_at','2026-01-02T00:00:00Z','event_snapshot',snapshot,'matched_rules','[]'::jsonb);
 body:=jsonb_build_object('status','active','availability','available','price',80,'observation',jsonb_build_object('amount',80,'currency','UYU','normalizedAmount',80,'itemId',fixed_id,'observedAt','2026-01-02T00:00:00Z'));
 result:=ml.record_monitor_observation(dynamic_id,0,body,jsonb_build_array(e));
 if result->>'alerts'<>'1' then raise exception 'Dynamic event missing'; end if;
 result:=ml.record_monitor_observation(fixed_id,0,jsonb_set(body,'{observation,observedAt}','"2026-01-02T00:00:01Z"'),jsonb_build_array(e));
 if result->>'alerts'<>'0' then raise exception 'Duplicate physical price event'; end if;
 select a.id,a.event_snapshot into event_id,original_snapshot from ml.ml_price_alerts a where a.event_target_id=dynamic_id;
 if (select count(*) from ml.ml_price_event_origins where alert_id=event_id)<>2 then raise exception 'Origins lost'; end if;
 update ml.ml_competitor_links set paused=true where competitor_item_id=dynamic_id;
 if (select archived_at from ml.ml_price_alerts where id=event_id) is not null then raise exception 'Other origin should keep comparison active'; end if;
 update ml.ml_competitor_links set paused=true where competitor_item_id=fixed_id;
 if (select archive_reason from ml.ml_price_alerts where id=event_id)<>'association_disabled' then raise exception 'All disabled origins did not archive'; end if;
 update ml.ml_competitor_links set paused=false where competitor_item_id in (fixed_id,dynamic_id);
 if (select archived_at from ml.ml_price_alerts where id=event_id) is null then raise exception 'Reactivation restored a normal historical event'; end if;
 -- An intervening change outside the rules must advance the canonical revision.
 perform ml.record_monitor_observation(fixed_id,1,jsonb_set(jsonb_set(body,'{observation,amount}','90'),'{observation,observedAt}','"2026-01-03T00:00:00Z"'),'[]');
 result:=ml.record_monitor_observation(dynamic_id,1,jsonb_set(body,'{observation,observedAt}','"2026-01-04T00:00:00Z"'),jsonb_build_array(e||'{"fired_at":"2026-01-04T00:00:00Z"}'));
 if result->>'alerts'<>'1' then raise exception 'Repeated later price cycle was lost'; end if;
 if (select event_snapshot from ml.ml_price_alerts where id=event_id) is distinct from original_snapshot then raise exception 'Immutable snapshot changed'; end if;
 -- Recovery of an operator's prior vendor assignment is explicit and idempotent.
 insert into ml.ml_monitor_repairs(key,kind,sku,catalog_id,expected_seller_id) values('source-test-fixed','recover_fixed','source-test',dynamic_id,2);
 recovered:=jsonb_build_object('id','MLU900092','source_id','MLU900092','source_kind','item','target_kind','item','title','Original vendor','seller_id',2,'observation',jsonb_build_object('itemId','MLU900092','sellerId',2,'catalogProductId',dynamic_id,'resolution',jsonb_build_object('sourceKind','item','sourceId','MLU900092','validatedAt',now())));
 begin
  perform ml.complete_monitor_fixed_recovery('source-test-fixed',jsonb_set(recovered,'{observation,sellerId}','3'));
  raise exception 'Wrong seller accepted';
 exception when others then if sqlerrm='Wrong seller accepted' then raise; end if; end;
 perform ml.complete_monitor_fixed_recovery('source-test-fixed',recovered);
 select count(*) into n from ml.ml_competitor_links;
 perform ml.complete_monitor_fixed_recovery('source-test-fixed',recovered);
 if (select count(*) from ml.ml_competitor_links)<>n then raise exception 'Recovery duplicated association'; end if;
 if not exists(select 1 from ml.ml_competitor_links where competitor_item_id='MLU900092' and equivalence='accepted' and review_source='legacy_manual_assignment') then raise exception 'Operator equivalence lost'; end if;
 -- Internal object ID and actual source can differ without losing either origin.
 result:=ml.link_competitor(jsonb_build_object('id',dynamic_id,'source_kind','item','source_id',dynamic_id,'target_kind','item'),'sku','source-test');
 if result->'item'->>'id'=dynamic_id then raise exception 'Source-kind collision reassigned existing rival'; end if;
 if (select count(*) from ml.ml_competitor_items where source_id=dynamic_id)<>2 then raise exception 'Source identities not independent'; end if;
 -- Only an explicitly queued faulty archive can be restored after proof.
 insert into ml.ml_competitor_items(id,target_kind,status,availability,permalink) values(up_id,'catalog','active','unavailable','https://www.mercadolibre.com.uy/p/'||up_id);
 if (select source_kind from ml.ml_competitor_items where id=up_id)<>'user_product' or (select source_url from ml.ml_competitor_items where id=up_id) not like '%/up/%' then raise exception 'User Product route lost'; end if;
 insert into ml.ml_competitor_links(competitor_item_id,scope,our_sku,equivalence) values(up_id,'sku','source-test','accepted');
 insert into ml.ml_price_alerts(id,our_product_id,our_sku,competitor_item_id,event_target_id,event_snapshot,archived_at,archive_reason,read_at)
 values(repair_event,own_id,'source-test',up_id,up_id,snapshot,now(),'rival_unavailable','2026-01-01');
 insert into ml.ml_monitor_repairs(key,kind,alert_id,rival_id) values('source-test-archive','archive_correction',repair_event,up_id);
 if ml.repair_verified_source_archives(up_id)<>0 then raise exception 'Unverified archive restored'; end if;
 update ml.ml_competitor_items set availability='available',observation=jsonb_build_object('amount',20,'normalizedAmount',20,'resolution',jsonb_build_object('sourceKind','user_product','sourceId',up_id,'validatedAt',now(),'resource','/items/MLU900201')) where id=up_id;
 if ml.repair_verified_source_archives(up_id)<>1 then raise exception 'Verified correction not restored'; end if;
 if ml.repair_verified_source_archives(up_id)<>0 then raise exception 'Correction not idempotent'; end if;
 if (select read_at from ml.ml_price_alerts where id=repair_event) is distinct from '2026-01-01'::timestamptz then raise exception 'Read state lost'; end if;
 if has_table_privilege('anon','ml.ml_monitor_repairs','select') or has_function_privilege('authenticated','ml.complete_monitor_fixed_recovery(text,jsonb,uuid)','execute') then raise exception 'Privileged repair exposed'; end if;
 raise notice 'Source identity, origin deduplication, independent pause, later cycles and audited recovery verified';
end $$;
rollback;
