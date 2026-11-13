#!/usr/bin/env python3
"""Run Monitor against the existing Gestor Supabase; never starts a Docker stack."""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT.parent / 'eurotech-gestor/eurotech-gestor/local-dev/.private'
API = 'http://127.0.0.1:54321'


def main():
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python3 scripts/with-gestor-local.py npm --prefix frontend run dev')
    with urllib.request.urlopen(API + '/auth/v1/health', timeout=5) as response:
        if response.status != 200:
            raise SystemExit('The existing Gestor Supabase is not healthy; no stack was started.')
    values = json.loads((PRIVATE / 'integrations.json').read_text())
    env = os.environ.copy()
    for name in list(env):
        if name.startswith(('SUPABASE_', 'MONITOR_TEST_', 'NEXT_PUBLIC_SUPABASE_', 'ML_CLIENT_')):
            env.pop(name)
    env.update(
        NEXT_PUBLIC_SUPABASE_URL=API,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=values['anon'],
        SUPABASE_SECRET_KEY=values['service'],
        ML_API_BASE_URL='https://api.mercadolibre.com',
        MONITOR_FX_URL='https://open.er-api.com/v6/latest/USD',
        NEXT_PUBLIC_SITE_URL='http://localhost:' + env.get('PORT', '3000'),
        NEXT_TELEMETRY_DISABLED='1',
    )
    os.chdir(ROOT)
    os.execvpe(sys.argv[1], sys.argv[1:], env)


if __name__ == '__main__':
    main()
