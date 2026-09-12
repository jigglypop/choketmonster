# GitHub 자동 배포

`main` 브랜치 push와 수동 `workflow_dispatch`는 `.github/workflows/deploy.yml`의 단일 production 배포를 실행한다. 동시 실행은 직렬화하며 시작된 production 배포를 새 push가 취소하지 않는다. 작업 시작 시 GitHub API의 현재 `main` SHA가 `GITHUB_SHA`와 다르면 오래된 실행으로 판단해 AWS 자격을 얻기 전에 종료한다.

## GitHub와 AWS 설정

워크플로에는 GitHub Environment와 장기 AWS 키를 두지 않는다. `contents: read`, `id-token: write` 권한으로 다음 역할을 OIDC로 맡는다.

```text
arn:aws:iam::960243570517:role/choketmon-github-deploy
```

역할의 trust는 저장소나 브랜치 이름만 비교하지 않고 다음 GitHub OIDC subject를 정확히 허용해야 한다.

```text
repo:jigglypop@52653682/choketmonster@1364221925:ref:refs/heads/main
```

현재 저장소 ID는 `1364221925`, 소유자 ID는 `52653682`다. 저장소의 실제 OIDC 설정에서 immutable subject 사용을 확인했다. IAM 정책은 이 저장소의 배포 작업에 필요한 정적 버킷 객체 쓰기, 런타임 버킷의 `ci/` 릴리스 쓰기, 지정한 EC2 대상의 `ChoketmonDeployRelease` 실행·상태 조회, 지정 CloudFront 배포의 무효화 권한으로 제한한다. CloudFormation, DB secret, 커넥톰 원본 업로드 권한은 이 흐름에 필요하지 않다. 이 역할과 SSM 문서는 `infra/aws-ci.yaml`, `choketmon-ci` 스택으로 관리한다.

외부 action은 태그가 아닌 커밋 SHA로 고정한다. 고정값과 GitHub 공식 API 확인 결과는 `infra/action-pins.json`에 있으며 워크플로가 사용 중인 SHA와 이 파일의 값이 같은지 배포 전에 검사한다.

## 검증과 빌드

Ubuntu 24.04와 Node 22에서 `npm ci`를 실행한다. `restore-source-cache.py`는 원본 manifest의 고정된 URL에서 테스트 입력 324개를 받고 SHA-256을 검증한다. 캐시 PNG와 CSV는 Git과 배포 산출물에 포함하지 않는다. 테스트는 worker를 2개로 제한하고 테스트 제한 시간을 60초로 둔 뒤 Vite production build를 만든다.

```bash
npm exec vitest -- run --maxWorkers 2 --testTimeout 60000
npm run build
npx tsx scripts/prepare-deploy.ts
```

배포 준비물의 `version.json`은 정확한 40자리 `gitCommit`과 UTC `builtAt`을 담는다. 준비 영수증은 모든 파일의 크기와 SHA-256을 기록한다. 포켓몬 로컬 PNG·GLB, Game Boy ROM 확장자는 준비 디렉터리와 영수증에서 계속 제외한다.

Rust 서버는 수동 실행, 최초 push처럼 `before`가 0인 실행, 비교할 이전 커밋이 없는 실행, 또는 `event.before..GITHUB_SHA`에서 `rust-server/`가 변경된 실행에만 빌드한다. `musl-tools`와 `x86_64-unknown-linux-musl` target을 설치하고 다음 명령으로 정적 release 바이너리를 만든다.

```bash
cargo build --locked --release --target x86_64-unknown-linux-musl --manifest-path rust-server/Cargo.toml
```

결과 경로는 `artifacts/rust-release/choketmon-server`다.

## 배포 순서와 영수증

`scripts/deploy-ci.py`는 입력 영수증의 커밋, 제외 조건, 모든 로컬 파일 SHA를 먼저 검사한다. Rust 바이너리가 있으면 정적 사이트보다 먼저 다음 키에 업로드한다.

```text
s3://choketmon-runtime-960243570517-ap-northeast-2/ci/{40자리 commit}/choketmon-server
```

이후 `i-0edb04b57d4e1361b`에 custom SSM document `ChoketmonDeployRelease`를 `Release`와 `Sha256` 파라미터로 한 번 호출한다. command ID는 호출 직후 `server-command.json`에 저장한다. 상태 조회가 불확실하거나 제한 시간 안에 끝나지 않으면 `pending-ssm.json`을 남기고 실패한다. 이 상태에서는 새 command를 자동 제출하지 않는다. document는 EC2의 기존 그래프와 환경 파일을 재사용하고, 기존 바이너리를 백업한 다음 교체·재시작·health 확인을 수행하며 실패하면 이전 바이너리로 되돌려야 한다.

서버 command가 성공한 다음 정적 파일을 `choketmonster-960243570517-apne2`에 `s3 sync`로 올린다. `--delete`는 사용하지 않아 열린 브라우저가 참조하는 이전 해시 asset을 보존한다. `assets/`에는 1년 immutable cache, `version.json`과 마지막에 업로드하는 `index.html`에는 no-cache를 설정한다.

CloudFront `E1P12YSCXY1AKT`의 `/*` 무효화 완료를 기다린 뒤 최대 4개 thread로 영수증의 모든 파일을 `https://d3b0jo8g1tseoa.cloudfront.net`에서 다시 내려받아 SHA-256을 비교한다. 마지막으로 `/api/health`의 Rust/PostgreSQL 상태와 `/version.json`의 commit을 확인한다. 성공 영수증은 `artifacts/ci-deploy-{commit}/receipt.json`이다. GitHub artifact에는 이 JSON 영수증과 SSM command/pending JSON만 올리며 빌드 묶음과 Rust 바이너리는 올리지 않는다.

로컬에서는 AWS를 변경하지 않고 입력 검사만 실행할 수 있다.

```bash
python scripts/deploy-ci.py --receipt artifacts/deploy-latest.json --commit $(git rev-parse HEAD) --check
```

`git push origin main` 뒤 실제 AWS 배포는 위 워크플로가 자동 수행한다. 실패한 SSM command는 ID로 상태를 확인한 뒤 처리하며 불확실한 설치를 자동 반복하지 않는다. 원본 데이터와 PostgreSQL 세이브는 일반 코드 배포에서 교체하지 않는다.
