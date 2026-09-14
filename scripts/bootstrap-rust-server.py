#!/usr/bin/env python3
"""Run via SSM on the scoped EC2 instance. No secrets are printed or bundled."""
import argparse
import json
import os
import secrets
import subprocess
import urllib.parse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--secret', required=True)
parser.add_argument('--ticket-secret', required=True)
parser.add_argument('--endpoint', required=True)
parser.add_argument('--origin', required=True)
parser.add_argument('--region', default='ap-northeast-2')
args = parser.parse_args()
secret = json.loads(json.loads(subprocess.check_output(['aws', 'secretsmanager', 'get-secret-value', '--secret-id', args.secret, '--region', args.region]))['SecretString'])
ticket_secret = json.loads(subprocess.check_output(['aws', 'secretsmanager', 'get-secret-value', '--secret-id', args.ticket_secret, '--region', args.region]))['SecretString']
if len(ticket_secret.encode()) < 32:
    raise RuntimeError('Realtime ticket secret is too short')
root = Path('/opt/choketmon')
config = Path('/etc/choketmon')
config.mkdir(mode=0o700, exist_ok=True)
password_file = config / 'app-password'
if not password_file.exists():
    password_file.write_text(secrets.token_hex(32))
    password_file.chmod(0o600)
password = password_file.read_text().strip()
env = os.environ.copy()
env['PGPASSWORD'] = secret['password']
env['PGSSLMODE'] = 'verify-full'
env['PGSSLROOTCERT'] = str(root / 'global-bundle.pem')
sql = """DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='choketmon_app') THEN
CREATE ROLE choketmon_app LOGIN PASSWORD '%s';
END IF; END $$;
ALTER ROLE choketmon_app LOGIN PASSWORD '%s';
GRANT CONNECT ON DATABASE choketmon TO choketmon_app;
GRANT USAGE,CREATE ON SCHEMA public TO choketmon_app;
""" % (password, password)
subprocess.run(['psql', '-h', args.endpoint, '-U', secret['username'], '-d', 'choketmon', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, env=env, check=True, stdout=subprocess.DEVNULL)
url = f"postgres://choketmon_app:{urllib.parse.quote(password, safe='')}@{args.endpoint}:5432/choketmon?sslmode=verify-full&sslrootcert={root}/global-bundle.pem"
origins = [value.strip() for value in args.origin.split(',') if value.strip()]
existing_config = config / 'server.env'
if existing_config.exists():
    for line in existing_config.read_text().splitlines():
        if line.startswith('APP_ORIGIN='):
            origins.extend(value.strip() for value in line.split('=', 1)[1].split(',') if value.strip())
allowed_origins = ','.join(dict.fromkeys(origins))
content = '\n'.join([f'DATABASE_URL={url}', 'LISTEN_ADDR=0.0.0.0:8080', f'APP_ORIGIN={allowed_origins}', 'COOKIE_SECURE=true', f'CONNECTOME_DIR={root}/connectome', f'REALTIME_TICKET_SECRET={ticket_secret}', 'RUST_LOG=info', 'RAYON_NUM_THREADS=2'])+'\n'
(config / 'server.env').write_text(content)
(config / 'server.env').chmod(0o600)
service = '''[Unit]
Description=Choketmon Rust connectome API
Wants=network-online.target
After=network-online.target
[Service]
User=choketmon
Group=choketmon
WorkingDirectory=/opt/choketmon
EnvironmentFile=/etc/choketmon/server.env
ExecStart=/opt/choketmon/choketmon-server
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=1600M
TasksMax=64
[Install]
WantedBy=multi-user.target
'''
Path('/etc/systemd/system/choketmon.service').write_text(service)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', 'choketmon'], check=True)
subprocess.run(['systemctl', 'restart', 'choketmon'], check=True)
print('Application role and service installed. Credentials retained only in root-readable configuration.')
