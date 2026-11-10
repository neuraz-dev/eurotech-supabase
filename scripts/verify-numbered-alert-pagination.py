#!/usr/bin/env python3
"""Compare numbered pages to cursor pagination in the isolated DB, rolling back all changes."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
migration = next((root/'supabase/migrations').glob('*_numbered_alert_pagination.sql')).read_text()
checks = r'''
do $$ declare scope text; state text; filters jsonb; old jsonb; numbered jsonb; second jsonb; boundary jsonb; begin
 for scope in select unnest(array['inbox','history']) loop
  for state in select unnest(array['all','read','unread']) loop
   filters := jsonb_build_object('scope',scope,'read',state);
   old := ml.list_monitor_alerts(filters);
   numbered := ml.list_monitor_alerts_page(filters,1);
   if old is distinct from numbered then raise exception 'First numbered page differs from existing cursor API: % %',scope,state; end if;
   if jsonb_array_length(old->'items')>50 then
    boundary := old->'items'->49;
    second := ml.list_monitor_alerts(filters,(boundary->>'fired_at')::timestamptz,(boundary->>'id')::uuid);
    if second is distinct from ml.list_monitor_alerts_page(filters,2) then raise exception 'Second numbered page differs from cursor API'; end if;
   elsif jsonb_array_length(ml.list_monitor_alerts_page(filters,2)->'items')<>0 then
    raise exception 'A page beyond the end must be empty';
   end if;
  end loop;
 end loop;
 if has_function_privilege('anon','ml.list_monitor_alerts_page(jsonb,integer)','EXECUTE')
  or has_function_privilege('authenticated','ml.list_monitor_alerts_page(jsonb,integer)','EXECUTE') then
  raise exception 'Numbered alert queries must remain server-only';
 end if;
end $$;
'''
subprocess.run(['docker','exec','-i','supabase_db_eurotech-monitor-improvements','psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],
 input='begin;\ndrop function if exists ml.list_monitor_alerts_page(jsonb,integer);\n'+migration+checks+'\nrollback;\n',text=True,check=True)
print('Numbered alert pages preserve cursor order, filters, counts and server-only access.')
