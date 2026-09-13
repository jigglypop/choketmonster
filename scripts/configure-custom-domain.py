#!/usr/bin/env python3
"""Resumable, scoped chocketmon.com registration and HTTPS configuration.

Registration is one year, without auto-renewal. Contact data stays in memory.
An uncertain paid submission is never retried automatically.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = 'chocketmon.com'
ACCOUNT = '960243570517'
REGION = 'ap-northeast-2'
STACK = 'choketmonster-web'
INSTANCE = 'i-0edb04b57d4e1361b'
DISTRIBUTION = 'E1P12YSCXY1AKT'
LEGACY = 'd3b0jo8g1tseoa.cloudfront.net'
RECEIPT = ROOT / 'artifacts/custom-domain-chocketmon.json'


def aws(*args):
    result = subprocess.run(['aws', *args, '--output', 'json'], capture_output=True,
                            env=dict(os.environ, AWS_PAGER=''))
    if result.returncode:
        # In particular, never echo the contact payload in a registration error.
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed (exit {result.returncode}); no automatic retry')
    try:
        body = result.stdout.decode('utf-8')
    except UnicodeDecodeError:
        body = result.stdout.decode('cp949')
    return json.loads(body) if body.strip() else {}


def remember(state, **updates):
    state.update(updates)
    RECEIPT.parent.mkdir(exist_ok=True)
    temporary = RECEIPT.with_suffix('.part')
    temporary.write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')
    temporary.replace(RECEIPT)


def zone():
    zones = aws('route53', 'list-hosted-zones-by-name', '--dns-name', DOMAIN)['HostedZones']
    matches = [z for z in zones if z['Name'] == DOMAIN + '.' and not z['Config']['PrivateZone']]
    if len(matches) != 1:
        raise RuntimeError('Exactly one public domain hosted zone is required; registration may still be pending')
    return matches[0]['Id']


def change_records(zone_id, records):
    return aws('route53', 'change-resource-record-sets', '--hosted-zone-id', zone_id,
               '--change-batch', json.dumps({'Changes': [{'Action': 'UPSERT', 'ResourceRecordSet': r} for r in records]}))


def certificate(state):
    if state.get('certificateArn'):
        return state['certificateArn']
    matches = [c for c in aws('acm', 'list-certificates', '--region', 'us-east-1')['CertificateSummaryList']
               if c['DomainName'] == DOMAIN and c['Status'] in ('PENDING_VALIDATION', 'ISSUED')]
    if len(matches) > 1:
        raise RuntimeError('Multiple certificates found; select one in the receipt before continuing')
    arn = matches[0]['CertificateArn'] if matches else aws(
        'acm', 'request-certificate', '--region', 'us-east-1', '--domain-name', DOMAIN,
        '--validation-method', 'DNS', '--idempotency-token', 'chocketmon20260913',
        '--tags', 'Key=application,Value=choketmonster')['CertificateArn']
    remember(state, certificateArn=arn)
    return arn


def register(state, contact_domain):
    if state.get('registrationAttemptedAt'):
        raise RuntimeError('A registration was already submitted or became uncertain; inspect its operation instead of buying again')
    owned = aws('route53domains', 'list-domains', '--region', 'us-east-1')['Domains']
    if any(d['DomainName'] == DOMAIN for d in owned):
        raise RuntimeError('Domain is already registered in this account')
    if not any(d['DomainName'] == contact_domain for d in owned):
        raise RuntimeError('Contact source must be an existing domain in this account')
    price = aws('route53domains', 'list-prices', '--region', 'us-east-1', '--tld', 'com')['Prices'][0]['RegistrationPrice']
    if price['Currency'] != 'USD' or price['Price'] > 16:
        raise RuntimeError('Registration price exceeds the reviewed USD 16 annual price')
    availability = aws('route53domains', 'check-domain-availability', '--region', 'us-east-1', '--domain-name', DOMAIN)
    if availability['Availability'] != 'AVAILABLE':
        raise RuntimeError('Domain is no longer available')
    contacts = aws('route53domains', 'get-domain-detail', '--region', 'us-east-1', '--domain-name', contact_domain)
    payload = {'DomainName': DOMAIN, 'DurationInYears': 1, 'AutoRenew': False}
    for name in ('Admin', 'Registrant', 'Tech'):
        payload[f'{name}Contact'] = contacts[f'{name}Contact']
        payload[f'PrivacyProtect{name}Contact'] = True
    remember(state, registrationAttemptedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
             contactSourceDomain=contact_domain, durationInYears=1, autoRenew=False, registrationPrice=price)
    result = aws('route53domains', 'register-domain', '--region', 'us-east-1', '--cli-input-json', json.dumps(payload))
    remember(state, registrationOperationId=result['OperationId'])
    print(json.dumps({'domain': DOMAIN, 'operationId': result['OperationId'], 'state': 'submitted'}))


def status(state):
    result = {'domain': DOMAIN}
    if state.get('registrationOperationId'):
        operation = aws('route53domains', 'get-operation-detail', '--region', 'us-east-1', '--operation-id', state['registrationOperationId'])
        result['registration'] = {k: operation.get(k) for k in ('Status', 'StatusFlag', 'Message')}
        remember(state, registrationStatus=operation['Status'])
    arn = certificate(state)
    result['certificate'] = aws('acm', 'describe-certificate', '--region', 'us-east-1', '--certificate-arn', arn)['Certificate']['Status']
    print(json.dumps(result))


def dns(state):
    zone_id = zone()
    cert = aws('acm', 'describe-certificate', '--region', 'us-east-1', '--certificate-arn', certificate(state))['Certificate']
    records = [dict(option['ResourceRecord'], TTL=300) for option in cert['DomainValidationOptions'] if 'ResourceRecord' in option]
    # ACM ResourceRecord uses Value; Route 53 uses ResourceRecords.
    for record in records:
        record['ResourceRecords'] = [{'Value': record.pop('Value')}]
    if not records:
        raise RuntimeError('Certificate validation record is not available yet')
    result = change_records(zone_id, records)
    remember(state, hostedZoneId=zone_id, validationDnsChangeId=result['ChangeInfo']['Id'])
    print(json.dumps({'validationDns': result['ChangeInfo']['Status'], 'zoneId': zone_id}))


def attach(state):
    arn = certificate(state)
    cert = aws('acm', 'describe-certificate', '--region', 'us-east-1', '--certificate-arn', arn)['Certificate']
    if cert['Status'] != 'ISSUED':
        raise RuntimeError('Wait for the DNS-validated certificate to be ISSUED before changing CloudFront')
    stack = aws('cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', STACK)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
        raise RuntimeError('Stack has an ongoing operation; inspect it before submitting another update')
    parameters = {p['ParameterKey']: p['ParameterValue'] for p in stack.get('Parameters', [])}
    parameters.update(CustomDomainName=DOMAIN, CustomCertificateArn=arn)
    command = ['aws', 'cloudformation', 'deploy', '--region', REGION, '--stack-name', STACK,
               '--template-file', str(ROOT / 'infra/aws-static.yaml'), '--parameter-overrides',
               *[f'{k}={v}' for k, v in parameters.items()], '--no-fail-on-empty-changeset']
    subprocess.run(command, check=True, env=dict(os.environ, AWS_PAGER=''))
    distribution = aws('cloudfront', 'get-distribution', '--id', DISTRIBUTION)['Distribution']
    if distribution['Status'] != 'Deployed' or DOMAIN not in distribution['DistributionConfig']['Aliases'].get('Items', []):
        raise RuntimeError('CloudFront alias has not finished deploying')
    records = [{'Name': DOMAIN + '.', 'Type': kind, 'AliasTarget': {'HostedZoneId': 'Z2FDTNDATAQYW2',
                'DNSName': LEGACY + '.', 'EvaluateTargetHealth': False}} for kind in ('A', 'AAAA')]
    result = change_records(zone(), records)
    remember(state, aliasDnsChangeId=result['ChangeInfo']['Id'], cloudFrontAttached=True)
    print(json.dumps({'domain': DOMAIN, 'cloudFront': 'Deployed', 'dns': result['ChangeInfo']['Status']}))


def allow_origin(state):
    if state.get('originCommandId'):
        result = aws('ssm', 'get-command-invocation', '--region', REGION, '--command-id', state['originCommandId'], '--instance-id', INSTANCE)
        remember(state, originCommandStatus=result['Status'])
        print(json.dumps({'commandId': state['originCommandId'], 'status': result['Status'],
                          'output': result.get('StandardOutputContent', '')}))
        return
    # Change only the allowed origins; keep credentials and all database data.
    code = """from pathlib import Path
import os, subprocess, urllib.request
p=Path('/etc/choketmon/server.env')
original=p.read_bytes()
lines=original.decode().splitlines()
origins=[]
for line in lines:
    if line.startswith('APP_ORIGIN='): origins.extend(line.split('=',1)[1].split(','))
for origin in ['https://d3b0jo8g1tseoa.cloudfront.net','https://chocketmon.com']:
    if origin not in origins: origins.append(origin)
lines=[line for line in lines if not line.startswith('APP_ORIGIN=')]
lines.append('APP_ORIGIN='+','.join(origins))
backup=p.with_name('server.env.before-chocketmon-domain')
if not backup.exists():
    backup.write_bytes(original); backup.chmod(0o600)
replacement=p.with_name('server.env.domain-part')
replacement.write_text('\\n'.join(lines)+'\\n'); replacement.chmod(0o600)
os.replace(replacement,p)
try:
    subprocess.run(['systemctl','restart','choketmon'],check=True)
    import time
    for attempt in range(30):
        try:
            print(urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=3).read().decode()); break
        except Exception:
            if attempt==29: raise
            time.sleep(2)
except Exception:
    p.write_bytes(original); p.chmod(0o600)
    subprocess.run(['systemctl','restart','choketmon'],check=True)
    raise
print('Both HTTPS origins enabled; existing credentials and saves retained.')
"""
    result = aws('ssm', 'send-command', '--region', REGION, '--document-name', 'AWS-RunShellScript',
                 '--instance-ids', INSTANCE, '--comment', 'Enable chocketmon.com without removing existing origin or saves',
                 '--parameters', json.dumps({'commands': ["python3 - <<'PY'\n" + code + '\nPY']}))
    remember(state, originCommandId=result['Command']['CommandId'])
    print(json.dumps({'originCommandId': state['originCommandId'], 'status': 'submitted'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'register', 'dns', 'attach', 'allow-origin'))
    parser.add_argument('--contact-domain')
    args = parser.parse_args()
    if aws('sts', 'get-caller-identity')['Account'] != ACCOUNT:
        raise RuntimeError('Refusing to operate in a different AWS account')
    RECEIPT.parent.mkdir(exist_ok=True)
    lock_path = RECEIPT.with_suffix('.lock')
    try:
        lock = lock_path.open('x')
    except FileExistsError:
        raise RuntimeError('Another domain command is running. If it crashed, inspect AWS operations and the receipt before removing the lock.')
    try:
        with lock:
            lock.write(str(os.getpid()))
        state = json.loads(RECEIPT.read_text(encoding='utf-8')) if RECEIPT.exists() else {'domain': DOMAIN, 'account': ACCOUNT}
        if args.action == 'register':
            if not args.contact_domain:
                parser.error('register requires the selected --contact-domain')
            register(state, args.contact_domain)
        else:
            {'status': status, 'dns': dns, 'attach': attach, 'allow-origin': allow_origin}[args.action](state)
    finally:
        lock_path.unlink()


if __name__ == '__main__':
    main()
