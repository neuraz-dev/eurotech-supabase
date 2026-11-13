"""Run the real rsync step on temporary files; never contact Docker or a server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SharedRuntimeDeployTest(unittest.TestCase):
    def test_monitor_deploy_preserves_gestor_sources(self):
        source = (ROOT / 'scripts/deploy-self-hosted-monitor.sh').read_text()
        function = source[source.index('sync_functions() {'):source.index('\nensure_runtime\ninit_migration_tracking')]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / 'repo'
            volume = base / 'volume'
            binary = base / 'bin'
            binary.mkdir()
            (binary / 'sudo').write_text('#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n')
            (binary / 'sudo').chmod(0o755)
            for path, value in {
                repo / 'supabase/functions/_shared/monitoring.ts': 'new Monitor helper',
                repo / 'supabase/functions/ml-manual-sync/index.ts': 'new worker',
                volume / 'functions/_shared/monitoring.ts': 'old Monitor helper',
                volume / 'functions/_shared/self-hosted-auth.ts': 'Gestor authentication',
                volume / 'functions/sync-ml-to-web/index.ts': 'Gestor source sync',
                volume / 'functions/ml-manual-sync/obsolete.ts': 'obsolete owned file',
            }.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            script = '\n'.join([
                'set -Eeuo pipefail',
                'run_docker() { :; }',
                'ensure_runtime() { :; }',
                function,
                'sync_functions',
            ])
            env = dict(os.environ, ROOT_DIR=str(repo), VOLUME_ROOT=str(volume),
                       FUNCTIONS_CONTAINER='fixture-runtime', PATH=str(binary) + ':' + os.environ['PATH'])
            subprocess.run(['bash', '-c', script], env=env, check=True, capture_output=True)
            self.assertEqual((volume / 'functions/_shared/self-hosted-auth.ts').read_text(), 'Gestor authentication')
            self.assertEqual((volume / 'functions/sync-ml-to-web/index.ts').read_text(), 'Gestor source sync')
            self.assertEqual((volume / 'functions/_shared/monitoring.ts').read_text(), 'new Monitor helper')
            self.assertEqual((volume / 'functions/ml-manual-sync/index.ts').read_text(), 'new worker')
            self.assertFalse((volume / 'functions/ml-manual-sync/obsolete.ts').exists())
            # Applying the same release a second time preserves both applications.
            subprocess.run(['bash', '-c', script], env=env, check=True, capture_output=True)
            self.assertEqual((volume / 'functions/_shared/self-hosted-auth.ts').read_text(), 'Gestor authentication')


if __name__ == '__main__':
    unittest.main()
