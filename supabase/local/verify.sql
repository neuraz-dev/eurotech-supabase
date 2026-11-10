\set ON_ERROR_STOP on
begin;
do $$
declare result jsonb; before_count integer; old_sku text; link_id uuid;
begin
  if exists(select 1 from cron.job) then raise exception 'Local cron must be empty'; end if;
  select count(*) into before_count from ml.ml_competitor_links where competitor_item_id='MLU200';
  if before_count<>1 or not exists(select 1 from ml.ml_competitor_links where competitor_item_id='MLU200' and equivalence='pending') then
    raise exception 'Legacy association did not migrate pending';
  end if;
  select our_sku into old_sku from ml.ml_competitor_items where id='MLU200';
  result:=ml.link_competitor('{"id":"MLU200","target_kind":"item"}','publication','MLU100');
  link_id:=(result->'association'->>'id')::uuid;
  perform ml.link_competitor('{"id":"MLU200","target_kind":"item"}','publication','MLU100');
  perform ml.link_competitor('{"id":"MLU200","target_kind":"item"}','publication','MLU102');
  if (select count(*) from ml.ml_competitor_links where competitor_item_id='MLU200')<>3 then raise exception 'Lost or duplicated link'; end if;
  if (select our_sku from ml.ml_competitor_items where id='MLU200') is distinct from old_sku then raise exception 'Legacy owner reassigned'; end if;
  update ml.ml_competitor_links set removed_at=now() where id=link_id;
  perform ml.link_competitor('{"id":"MLU200","target_kind":"item"}','publication','MLU100');
  if (select removed_at from ml.ml_competitor_links where id=link_id) is not null then raise exception 'Association was not restored'; end if;
  begin
    perform ml.link_competitor('{"id":"MLU200","target_kind":"item"}','sku','   ');
    raise exception 'Blank SKU accepted';
  exception when others then if sqlerrm='Blank SKU accepted' then raise; end if; end;
  begin
    delete from ml.ml_competitor_items where id='MLU200';
    raise exception 'Shared rival deleted';
  exception when foreign_key_violation then null; end;
  if has_table_privilege('anon','ml.ml_competitor_links','select') or has_function_privilege('anon','ml.link_competitor(jsonb,text,text)','execute') then raise exception 'Privileged API exposed'; end if;
end $$;
rollback;
