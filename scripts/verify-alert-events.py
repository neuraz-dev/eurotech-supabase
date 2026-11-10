#!/usr/bin/env python3
"""Rollback-only checks. No fixture resets, no external API, no extra database."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
subprocess.run(
    ['docker', 'exec', '-i', 'supabase_db_eurotech-monitor-improvements',
     'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    input=(root / 'supabase/local/verify-alert-events.sql').read_text(),
    text=True, check=True,
)
