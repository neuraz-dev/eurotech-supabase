"""Exercise rollout safety without Docker, network access, or real credentials."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
FAKE_SUDO = r'''#!/usr/bin/python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
command = ' '.join(args)
log = Path(os.environ['ROLLOUT_TEST_LOG'])
with log.open('a') as stream: stream.write(command + '\n')
if 'inspect --format' in command: print('true')
elif 'printenv SUPABASE_URL' in command: print('http://supabase-kong:8000')
elif '-Atc' in args:
    if os.environ.get('EMULATE_DOCKER_STDIN') and '-i' in args:
        sys.stdin.read()
    query = args[args.index('-Atc') + 1]
    if 'select coalesce(' in query:
        print('https://wrong.test/ml-sync-competitor' if os.environ.get('FAIL_URL') else 'http://supabase-kong:8000/functions/v1/ml-sync-competitor')
    elif 'select md5(' in query: print('fixture-fingerprint')
    elif 'to_regclass' in query: print('t')
    elif 'select checksum' in query: print('wrong-checksum' if os.environ.get('FAIL_CHECKSUM') else '')
    elif 'select count(*) from cron.job' in query: print('1')
    elif 'select ml.invoke_competitor_sync()' in query: print('123')
    elif 'select count(*) from net._http_response' in query: print('1')
    elif 'coalesce(content::jsonb' in query: print('0' if os.environ.get('FAIL_SYNC') else '48')
    else: sys.exit('Unexpected SQL query: ' + query)
elif 'md5sum' in command: print('different-fingerprint' if os.environ.get('FAIL_KEY') else 'fixture-fingerprint')
elif 'mktemp -d' in command: print('/tmp/fake-backup')
elif '-c' in args and 'psql' in args: print('500 | updated=48 | failed=27')
elif 'psql' in args:
    sql = sys.stdin.read()
    assert sql.startswith('BEGIN;') and sql.endswith('COMMIT;\n')
    assert 'INSERT INTO deployment.monitor_migrations' in sql
    with log.open('a') as stream: stream.write('APPLY_MIGRATION\n')
'''


class CompetitorDeployTest(unittest.TestCase):
    def run_rollout(self, mode, pasted=False, **flags):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            sudo = work / 'sudo'
            sudo.write_text(FAKE_SUDO)
            sudo.chmod(0o755)
            sleep = work / 'sleep'
            sleep.write_text('#!/bin/sh\nexit 0\n')
            sleep.chmod(0o755)
            log = work / 'commands.log'
            env = dict(os.environ, PATH=directory + ':' + os.environ['PATH'], ROLLOUT_TEST_LOG=str(log), **flags)
            script = ROOT / 'scripts/deploy-competitor-sync.sh'
            if pasted:
                commands = f"bash '{script}' --check\nbash '{script}' --apply\nprintf 'INSTALLER_FINISHED\\n'\n"
                result = subprocess.run(['bash'], input=commands, capture_output=True, text=True, env=env)
            else:
                result = subprocess.run(['bash', str(script), mode], capture_output=True, text=True, env=env)
            return result, log.read_text()

    def test_check_is_read_only(self):
        result, commands = self.run_rollout('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('install -m', commands)
        self.assertNotIn('restart', commands)
        self.assertNotIn('APPLY_MIGRATION', commands)

    def test_pasted_installer_preserves_following_commands(self):
        result, commands = self.run_rollout('--apply', pasted=True, EMULATE_DOCKER_STDIN='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('APPLY_MIGRATION', commands)
        self.assertIn('INSTALLER_FINISHED', result.stdout)

    def test_bad_configuration_aborts_before_any_change(self):
        for flag in ['FAIL_URL', 'FAIL_KEY', 'FAIL_CHECKSUM']:
            with self.subTest(flag=flag):
                result, commands = self.run_rollout('--apply', **{flag: '1'})
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('install -m', commands)
                self.assertNotIn('restart', commands)
                self.assertNotIn('APPLY_MIGRATION', commands)

    def test_deploys_code_before_schedule_and_checks_the_actual_http_response(self):
        result, commands = self.run_rollout('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(commands.index('install -m'), commands.index('APPLY_MIGRATION'))
        self.assertLess(commands.index('restart'), commands.index('APPLY_MIGRATION'))
        self.assertLess(commands.index('APPLY_MIGRATION'), commands.index('select ml.invoke_competitor_sync()'))
        self.assertIn('from net._http_response where id=123', commands)
        self.assertIn('fallos parciales', result.stdout)

    def test_no_data_updated_does_not_report_a_validated_deployment(self):
        result, _ = self.run_rollout('--apply', FAIL_SYNC='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no actualizó rivales', result.stderr)


if __name__ == '__main__':
    unittest.main()
