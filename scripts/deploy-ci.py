#!/usr/bin/env python3
"""Deploy one verified CI release. This script never provisions infrastructure or uploads graph data."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

REGION = "ap-northeast-2"
STATIC_BUCKET = "choketmonster-960243570517-apne2"
RUNTIME_BUCKET = "choketmon-runtime-960243570517-ap-northeast-2"
DISTRIBUTION = "E1P12YSCXY1AKT"
SITE_URL = "https://d3b0jo8g1tseoa.cloudfront.net"
INSTANCE = "i-0edb04b57d4e1361b"
DOCUMENT = "ChoketmonDeployRelease"
EXCLUDED = re.compile(r"^(?:models/pokemon/\d+\.glb|pokemon/(?:back/)?[^/]+\.png)$|(?:^|/)[^/]+\.(?:gb|gbc|gba|rom)$", re.I)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def aws(*args: str) -> str:
    environment = dict(os.environ, AWS_PAGER="")
    result = subprocess.run(["aws", *args], check=True, capture_output=True, env=environment)
    return result.stdout.decode('utf-8', errors='replace')


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_receipt(path: Path, commit: str) -> tuple[dict, Path]:
    receipt = json.loads(path.read_text(encoding="utf-8-sig"))
    payload = Path(receipt["directory"]).resolve()
    if not payload.is_dir() or receipt.get("source", {}).get("gitCommit") != commit:
        raise RuntimeError("Deployment receipt does not belong to this git commit")
    files = receipt.get("files")
    if not isinstance(files, list) or not files or not any(row.get("path") == "index.html" for row in files) or not any(row.get("path") == "version.json" for row in files):
        raise RuntimeError("Deployment receipt is incomplete")
    expected_paths = [row.get('path', '') for row in files]
    actual_paths = [str(file.relative_to(payload)).replace('\\', '/') for file in payload.rglob('*') if file.is_file()]
    if len(set(expected_paths)) != len(expected_paths) or set(actual_paths) != set(expected_paths):
        raise RuntimeError('Deployment payload contains missing or unlisted files')
    for row in files:
        relative = row.get("path", "")
        if EXCLUDED.search(relative):
            raise RuntimeError(f"Excluded binary entered deployment payload: {relative}")
        candidate = (payload / relative).resolve()
        if payload not in candidate.parents or not candidate.is_file() or sha256(candidate) != row.get("sha256"):
            raise RuntimeError(f"Deployment payload checksum mismatch: {relative}")
    manifest = hashlib.sha256(json.dumps(files, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    # TypeScript JSON.stringify has no spaces after separators.
    if manifest != receipt.get("manifestSha256"):
        raise RuntimeError("Deployment manifest checksum mismatch")
    version = json.loads((payload / "version.json").read_text(encoding="utf-8"))
    if version.get("gitCommit") != commit:
        raise RuntimeError("version.json does not identify this commit")
    return receipt, payload


def deploy_server(binary: Path, commit: str, output_dir: Path) -> dict:
    digest = sha256(binary)
    key = f"ci/{commit}/choketmon-server"
    aws("s3", "cp", str(binary), f"s3://{RUNTIME_BUCKET}/{key}", "--region", REGION, "--no-progress", "--metadata", f"sha256={digest}")
    response = json.loads(aws(
        "ssm", "send-command", "--region", REGION, "--document-name", DOCUMENT,
        "--instance-ids", INSTANCE, "--parameters", json.dumps({"Release": [commit], "Sha256": [digest]}), "--output", "json",
    ))
    command_id = response["Command"]["CommandId"]
    receipt = {"schema": 1, "release": commit, "sha256": digest, "runtimeKey": key, "commandId": command_id, "status": "Submitted", "submittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    command_receipt = output_dir / "server-command.json"
    write_json(command_receipt, receipt)
    deadline = time.monotonic() + 20 * 60
    while time.monotonic() < deadline:
        try:
            invocation = json.loads(aws("ssm", "get-command-invocation", "--region", REGION, "--command-id", command_id, "--instance-id", INSTANCE, "--output", "json"))
        except Exception as error:
            if isinstance(error, subprocess.CalledProcessError) and b'InvocationDoesNotExist' in (error.stderr or b''):
                time.sleep(3)
                continue
            write_json(output_dir / "pending-ssm.json", {**receipt, "status": "PollingUncertain", "errorType": type(error).__name__})
            raise RuntimeError(f"SSM command {command_id} was submitted; polling became uncertain and must not be resubmitted") from error
        status = invocation.get("Status")
        if status == "Success":
            receipt.update({"status": status, "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            write_json(command_receipt, receipt)
            return receipt
        if status not in {"Pending", "InProgress", "Delayed"}:
            receipt.update({"status": status, "statusDetails": invocation.get("StatusDetails")})
            write_json(command_receipt, receipt)
            raise RuntimeError(f"SSM deployment failed with status {status}; command {command_id} will not be repeated")
        time.sleep(5)
    write_json(output_dir / "pending-ssm.json", {**receipt, "status": "PollingTimedOut"})
    raise RuntimeError(f"SSM command {command_id} is still pending; do not resubmit it")


def deploy_static(payload: Path, receipt: dict) -> str:
    base = ["--region", REGION, "--no-progress"]
    aws("s3", "sync", str(payload), f"s3://{STATIC_BUCKET}", *base,
        "--exclude", "index.html", "--exclude", "version.json", "--exclude", "assets/*", "--cache-control", "public,max-age=300")
    assets = payload / "assets"
    if assets.is_dir():
        aws("s3", "cp", str(assets), f"s3://{STATIC_BUCKET}/assets", "--recursive", *base, "--cache-control", "public,max-age=31536000,immutable")
    aws("s3", "cp", str(payload / "version.json"), f"s3://{STATIC_BUCKET}/version.json", *base,
        "--cache-control", "no-cache,max-age=0,must-revalidate", "--content-type", "application/json")
    # index.html is deliberately the final upload.
    aws("s3", "cp", str(payload / "index.html"), f"s3://{STATIC_BUCKET}/index.html", *base,
        "--cache-control", "no-cache,max-age=0,must-revalidate", "--content-type", "text/html; charset=utf-8")
    invalidation = json.loads(aws("cloudfront", "create-invalidation", "--distribution-id", DISTRIBUTION, "--paths", "/*", "--output", "json"))
    invalidation_id = invalidation["Invalidation"]["Id"]
    aws("cloudfront", "wait", "invalidation-completed", "--distribution-id", DISTRIBUTION, "--id", invalidation_id)
    return invalidation_id


def download_hash(relative: str) -> tuple[str, str]:
    url = f"{SITE_URL}/{quote(relative, safe='/')}"
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={"User-Agent": "choketmon-ci-verifier", "Cache-Control": "no-cache"}), timeout=30) as response:
                return relative, hashlib.sha256(response.read()).hexdigest()
        except Exception as error:
            last_error = error
            if attempt < 3:
                time.sleep(3)
    raise RuntimeError(f"Unable to verify {relative}: {type(last_error).__name__}")


def verify_production(receipt: dict, commit: str) -> dict:
    expected = {row["path"]: row["sha256"] for row in receipt["files"]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        actual = dict(pool.map(download_hash, expected))
    mismatches = [path for path in expected if actual[path] != expected[path]]
    if mismatches:
        raise RuntimeError(f"HTTPS checksum mismatch: {mismatches[:5]}")
    with urlopen(Request(f"{SITE_URL}/api/health", headers={"User-Agent": "choketmon-ci-verifier"}), timeout=30) as response:
        health = json.load(response)
    with urlopen(Request(f"{SITE_URL}/version.json", headers={"User-Agent": "choketmon-ci-verifier", "Cache-Control": "no-cache"}), timeout=30) as response:
        version = json.load(response)
    if health.get("status") != "ok" or health.get("server") != "rust" or health.get('database') != 'postgresql' or health.get('connectome') is not True or version.get("gitCommit") != commit:
        raise RuntimeError("Production health or version commit verification failed")
    return {"filesVerified": len(actual), "health": {"status": health.get("status"), "server": health.get("server"), "database": health.get("database"), "connectome": health.get("connectome")}, "version": version}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", default="artifacts/deploy-latest.json")
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument("--binary")
    parser.add_argument("--check", action="store_true", help="validate inputs without contacting AWS")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise RuntimeError("--commit must be the exact 40-character lowercase git commit")
    receipt, payload = load_receipt(Path(args.receipt).resolve(), args.commit)
    if args.binary and (not Path(args.binary).is_file() or Path(args.binary).read_bytes()[:4] != b'\x7fELF'):
        raise RuntimeError("Rust release binary is missing or empty")
    if args.check:
        print(json.dumps({"checked": True, "files": len(receipt["files"]), "commit": args.commit}))
        return 0
    account = json.loads(aws('sts', 'get-caller-identity', '--output', 'json'))['Account']
    if account != '960243570517':
        raise RuntimeError('Unexpected AWS account')
    with urlopen(Request('https://api.github.com/repos/jigglypop/choketmonster/git/ref/heads/main', headers={'User-Agent': 'choketmon-ci-deployer'}), timeout=30) as response:
        latest = json.load(response)['object']['sha']
    if latest != args.commit:
        print(json.dumps({'skipped': 'superseded main commit', 'latest': latest, 'commit': args.commit}))
        return 0
    output_dir = Path("artifacts") / f"ci-deploy-{args.commit}"
    server = deploy_server(Path(args.binary), args.commit, output_dir) if args.binary else None
    invalidation_id = deploy_static(payload, receipt)
    verification = verify_production(receipt, args.commit)
    deployment = {
        "schema": 1, "gitCommit": args.commit, "deployedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "region": REGION, "staticBucket": STATIC_BUCKET, "distributionId": DISTRIBUTION, "siteUrl": SITE_URL,
        "manifestSha256": receipt["manifestSha256"], "invalidationId": invalidation_id, "server": server, "verification": verification,
    }
    write_json(output_dir / "receipt.json", deployment)
    print(json.dumps({"deployed": True, "gitCommit": args.commit, "filesVerified": verification["filesVerified"], "receipt": str(output_dir / "receipt.json")}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"deploy-ci failed: {error}", file=sys.stderr)
        sys.exit(1)
