#!/usr/bin/env python3
"""Deploy verified Linux Rust artifact + curated graph via private S3 and SSM.

Existing AWS CLI credentials only. Never fetch a secret to the developer machine.
"""
import argparse
import hashlib
import json
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGION = 'ap-northeast-2'
ACCOUNT = '960243570517'
STACK = 'choketmon-server'

def aws(*args):
    process = subprocess.run(['aws', *args, '--no-cli-pager', '--output', 'json'], capture_output=True)
    # AWS CLI on Windows may encode embedded SSM logs in the console codepage.
    stdout = process.stdout.decode('utf-8', errors='replace')
    stderr = process.stderr.decode('utf-8', errors='replace')
    if process.returncode:
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed: {stderr.strip()}')
    return json.loads(stdout) if stdout.strip() else {}

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(8*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', default='artifacts/rust-release/choketmon-server')
    parser.add_argument('--graph', default='data/local/malecns-neurons166k')
    parser.add_argument('--skip-provision', action='store_true')
    parser.add_argument('--resume', help='Resume an existing release directory after inspecting its receipt and failed stage')
    parser.add_argument('--skip-install', action='store_true', help='Resume after the existing SSM command succeeded, without resubmitting installation')
    args = parser.parse_args()
    identity = aws('sts','get-caller-identity')
    if identity['Account'] != ACCOUNT: raise RuntimeError('Unexpected AWS account')
    graph = ROOT / args.graph
    manifest = json.loads((graph / 'manifest.json').read_text(encoding='utf-8'))
    binary = ROOT / args.binary
    if not binary.is_file() or binary.read_bytes()[:4] != b'\x7fELF': raise RuntimeError('Linux ELF release binary is required')
    if sha(graph/'graph.bin') != manifest['graph']['graphSha256']: raise RuntimeError('Graph checksum mismatch')
    if sha(graph/'node_ids.txt') != manifest['graph']['nodeIdsSha256']: raise RuntimeError('Node ID checksum mismatch')
    if not args.skip_provision:
        subprocess.run(['aws','cloudformation','deploy','--region',REGION,'--stack-name',STACK,'--template-file',str(ROOT/'infra/aws-server.yaml'),
            '--parameter-overrides','VpcId=vpc-01dc516a','SubnetA=subnet-4a9f2021','SubnetB=subnet-436a0238',
            '--capabilities','CAPABILITY_IAM','--tags','application=choketmonster','--no-fail-on-empty-changeset'],check=True)
    deadline = time.monotonic() + 1800
    while True:
        stack = aws('cloudformation','describe-stacks','--region',REGION,'--stack-name',STACK)['Stacks'][0]
        if stack['StackStatus'] in ('CREATE_COMPLETE','UPDATE_COMPLETE'): break
        if 'FAILED' in stack['StackStatus'] or 'ROLLBACK' in stack['StackStatus']: raise RuntimeError(stack['StackStatus'])
        if time.monotonic() > deadline: raise RuntimeError('Provisioning still pending; inspect existing stack before retrying')
        print(f"Infrastructure {stack['StackStatus']}", flush=True); time.sleep(20)
    outputs = {item['OutputKey']:item['OutputValue'] for item in stack['Outputs']}
    instance, bucket = outputs['InstanceId'], outputs['RuntimeBucket']
    release = args.resume or datetime.now(timezone.utc).strftime('release-%Y%m%dT%H%M%SZ')
    if not release.startswith('release-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in release): raise RuntimeError('Invalid release identifier')
    receipt_dir = ROOT/'artifacts'/release; receipt_dir.mkdir(exist_ok=bool(args.resume))
    previous = json.loads((receipt_dir/'receipt.json').read_text()) if args.resume else {}
    files = {'choketmon-server':binary, 'bootstrap.py':ROOT/'scripts/bootstrap-rust-server.py',
        'connectome/manifest.json':graph/'manifest.json','connectome/graph.bin':graph/'graph.bin','connectome/node_ids.txt':graph/'node_ids.txt'}
    checksums = '\n'.join(f'{sha(path)}  {name}' for name,path in files.items())+'\n'
    (receipt_dir/'SHA256SUMS').write_text(checksums,encoding='ascii',newline='\n')
    files['SHA256SUMS'] = receipt_dir/'SHA256SUMS'
    if args.skip_install and (not args.resume or any(previous.get('files',{}).get(name)!=sha(path) for name,path in files.items())):
        raise RuntimeError('Skipping installation requires an unchanged, previously uploaded release receipt')
    for name,path in files.items():
        if previous.get('files',{}).get(name)==sha(path):
            remote=aws('s3api','head-object','--bucket',bucket,'--key',f'{release}/{name}','--region',REGION)
            if remote['ContentLength']==path.stat().st_size: continue
        subprocess.run(['aws','s3','cp',str(path),f's3://{bucket}/{release}/{name}','--region',REGION,'--no-progress','--only-show-errors'],check=True)
    site = aws('cloudformation','describe-stacks','--region',REGION,'--stack-name','choketmonster-web')['Stacks'][0]
    site_outputs={item['OutputKey']:item['OutputValue'] for item in site['Outputs']}
    commands = [
        'set -eu', 'dnf install -y postgresql17 > /var/log/choketmon-packages.log',
        f'install -d -m 750 /opt/choketmon/releases/{release}',
        f'aws s3 cp s3://{bucket}/{release}/ /opt/choketmon/releases/{release}/ --recursive --region {REGION} --no-progress --only-show-errors',
        f'cd /opt/choketmon/releases/{release}', 'sha256sum -c SHA256SUMS',
        'curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/choketmon/global-bundle.pem',
        'systemctl stop choketmon.service 2>/dev/null || true',
        f'install -m 755 choketmon-server /opt/choketmon/choketmon-server',
        f'ln -sfn /opt/choketmon/releases/{release}/connectome /opt/choketmon/connectome',
        'chown -R root:choketmon /opt/choketmon', 'chmod -R g+rX /opt/choketmon/releases',
        'python3 bootstrap.py --secret '+shlex.quote(outputs['DatabaseSecretArn'])+' --endpoint '+shlex.quote(outputs['DatabaseEndpoint'])+' --origin '+shlex.quote(site_outputs['SiteUrl']),
        'for attempt in $(seq 1 30); do if curl -fsS http://127.0.0.1:8080/api/health; then break; fi; sleep 2; done',
        'systemctl is-active choketmon', 'curl -fsS http://127.0.0.1:8080/api/connectome',
    ]
    parameters = receipt_dir/'ssm-parameters.json';parameters.write_text(json.dumps({'commands':commands,'executionTimeout':['600']}),encoding='utf-8')
    cmd = previous['commandId'] if args.skip_install else aws('ssm','send-command','--region',REGION,'--instance-ids',instance,'--document-name','AWS-RunShellScript','--parameters',f'file://{parameters.as_posix()}','--comment',f'Choketmon verified {release}')['Command']['CommandId']
    receipt={'release':release,'instanceId':instance,'bucket':bucket,'graphId':manifest['id'],'files':{name:sha(path) for name,path in files.items()},'commandId':cmd,'outputs':outputs}
    (receipt_dir/'receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    time.sleep(3)
    for _ in range(80):
        result=aws('ssm','get-command-invocation','--region',REGION,'--command-id',cmd,'--instance-id',instance)
        if result['Status'] not in ('Pending','InProgress','Delayed'): break
        print('Installing verified runtime via SSM',flush=True);time.sleep(10)
    (receipt_dir/'ssm-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    if result['Status']!='Success': raise RuntimeError(f"SSM {result['Status']}; inspect {receipt_dir/'ssm-result.json'}")
    # Only the CloudFront VPC service SG can reach the origin, including its private ENI.
    groups=aws('ec2','describe-security-groups','--region',REGION,'--filters','Name=vpc-id,Values=vpc-01dc516a','Name=group-name,Values=CloudFront-VPCOrigins-Service-SG')['SecurityGroups']
    if len(groups)==1:
        subprocess.run(['aws','cloudformation','deploy','--region',REGION,'--stack-name',STACK,'--template-file',str(ROOT/'infra/aws-server.yaml'),
            '--parameter-overrides','VpcId=vpc-01dc516a','SubnetA=subnet-4a9f2021','SubnetB=subnet-436a0238',f"CloudFrontServiceGroup={groups[0]['GroupId']}",
            '--capabilities','CAPABILITY_IAM','--no-fail-on-empty-changeset'],check=True)
    params={item['ParameterKey']:item['ParameterValue'] for item in site.get('Parameters',[])}
    # FREE flat-rate plans exclude VPC origins. Cancel only this project's FREE subscription;
    # pay-as-you-go avoids a Business plan's fixed cost. The original ACL has no blocking rules.
    plan = aws('cloudformation','describe-stacks','--region','us-east-1','--stack-name','choketmonster-free-plan')['Stacks'][0]
    plan_params={item['ParameterKey']:item['ParameterValue'] for item in plan.get('Parameters',[])}
    if plan_params.get('ActivateSubscription')=='true':
        subprocess.run(['aws','cloudformation','deploy','--region','us-east-1','--stack-name','choketmonster-free-plan','--template-file',str(ROOT/'infra/aws-free-plan.yaml'),
            '--parameter-overrides',f"DistributionArn={site_outputs['DistributionArn']}",'ActivateSubscription=false','KeepWebAcl=true','--no-fail-on-empty-changeset'],check=True)
    overrides=[f"BucketName={site_outputs['BucketName']}",'WebAclArn=',f"ApiVpcOriginId={outputs['VpcOriginId']}",f"ApiPrivateDns={outputs['ApiPrivateDns']}"]
    subprocess.run(['aws','cloudformation','deploy','--region',REGION,'--stack-name','choketmonster-web','--template-file',str(ROOT/'infra/aws-static.yaml'),'--parameter-overrides',*overrides,'--no-fail-on-empty-changeset'],check=True)
    if plan_params.get('KeepWebAcl','true')=='true':
        subprocess.run(['aws','cloudformation','deploy','--region','us-east-1','--stack-name','choketmonster-free-plan','--template-file',str(ROOT/'infra/aws-free-plan.yaml'),
            '--parameter-overrides',f"DistributionArn={site_outputs['DistributionArn']}",'ActivateSubscription=false','KeepWebAcl=false','--no-fail-on-empty-changeset'],check=True)
    receipt['siteUrl']=site_outputs['SiteUrl'];receipt['status']='api-deployed'
    (receipt_dir/'receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    print(json.dumps({'receipt':str(receipt_dir/'receipt.json'),'siteUrl':receipt['siteUrl'],'status':receipt['status']}),flush=True)

if __name__=='__main__': main()
