#!/usr/bin/env python3
"""Run a command against the isolated local stack and its current data profile."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

values = {}
for line in Path('/tmp/monitor-local.env').read_text().splitlines():
    if '=' in line:
        name, value = line.split('=', 1)
        values[name] = shlex.split(value)[0] if value else ''
if values.get('API_URL') != 'http://127.0.0.1:55421':
    raise SystemExit('Se requiere la instancia aislada en 127.0.0.1:55421')
env = os.environ.copy()
for name in ('SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF'):
    env.pop(name, None)
env.update(
    NEXT_PUBLIC_SUPABASE_URL=values['API_URL'],
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=values['ANON_KEY'],
    SUPABASE_SECRET_KEY=values['SERVICE_ROLE_KEY'],
    MONITOR_TEST_SUPABASE_URL=values['API_URL'],
    MONITOR_TEST_SECRET_KEY=values['SERVICE_ROLE_KEY'],
    ML_API_BASE_URL='http://127.0.0.1:55430',
    MONITOR_FX_URL='http://127.0.0.1:55430/fx',
    NEXT_TELEMETRY_DISABLED='1',
)
profile = Path('/tmp/eurotech-monitor-local/data-mode')
data_mode = profile.read_text().strip() if profile.exists() else 'synthetic'
if data_mode in ('real', 'real-live'):
    # Never send restored real identities to the synthetic upstream or allow
    # fixture tests to overwrite the restored dataset.
    for name in ('MONITOR_TEST_SUPABASE_URL', 'MONITOR_TEST_SECRET_KEY'):
        env.pop(name, None)
    env['ML_API_BASE_URL'] = (
        'https://api.mercadolibre.com' if data_mode == 'real-live'
        else 'http://127.0.0.1:55431'
    )
    env['MONITOR_FX_URL'] = (
        'https://open.er-api.com/v6/latest/USD' if data_mode == 'real-live'
        else 'http://127.0.0.1:55431/fx'
    )
if len(sys.argv) < 2:
    raise SystemExit('Uso: python3 scripts/with-monitor-local.py npm --prefix frontend run test:e2e')
raise SystemExit(subprocess.call(sys.argv[1:], env=env))
