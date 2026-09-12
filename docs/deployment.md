# AWS 웹·Rust 서버 배포

초켓몬스터는 정적 웹 앱과 계정·저장·전체 MaleCNS 회로 API를 같은 CloudFront 주소로 제공하도록 구성했다. 정적 파일은 서울 리전의 비공개 S3 버킷에서, `/api/*`는 CloudFront VPC origin을 통해 퍼블릭 인바운드가 없는 EC2 Rust 서버에서 읽는다. Rust 서버는 비공개 RDS PostgreSQL에 계정, 저장, 개체별 회로 상태와 재시도 영수증을 보관한다. 서버 런타임 묶음과 전체 회로 파일은 별도 비공개 S3 버킷에서 EC2로 전달하며 DB 관리자 비밀번호는 Secrets Manager가 관리한다.

운영 주소: **https://d3b0jo8g1tseoa.cloudfront.net**

2026-09-12의 `choketmon-server` 스택은 `infra/aws-server.yaml`의 EC2 `t3.small`, RDS PostgreSQL `db.t4g.micro` Single-AZ, CloudFront VPC origin 구성을 사용한다. 서버 릴리스는 `artifacts/release-20260912T093014Z/receipt.json`, 최신 화면은 `artifacts/deploy-2026-09-12T09-49-18-556Z.deployed.json`에 기록했다. HTTPS API 25개 검사는 `artifacts/rust-api-production.json`, 실제 가입·학습 배틀·저장·로그아웃·재로그인 복원은 `artifacts/rust-production-ui.json`에서 통과했다. EC2 서비스를 재시작한 뒤 세션, 정확한 세이브 내용, 학습 상태가 유지되는 검사도 `artifacts/rust-production-persistence.json`에서 통과했다. 구체적 범위와 제한은 [이번 전달 기록](delivery-2026-09-12.md)을 읽는다.

`artifacts/deploy-2026-09-11T12-14-41-855Z.deployed.json`은 정적 전용 배포의 역사적 기록이다. 당시 검사를 Rust API 배포의 성공 근거로 사용하지 않는다. `artifacts/aws-deploy-verification.json`은 배포 스크립트가 갱신하는 최신 정적 파일 검사다. 실제 계정·전체 회로 화면 검사는 `CHOKETMON_LIVE_RUST=1`, `CHOKETMON_BASE_URL=https://d3b0jo8g1tseoa.cloudfront.net` 환경에서 `pnpm exec playwright test tests/ui/rust-live.spec.ts`로 실행한다.

역사적 정적 배포에서는 관동 조작·구매·모바일, 선택·추적·순간이동, 경험치 공유와 저장 복원 브라우저 검사가 통과했다. 새 배포의 완료 판정에는 여기에 계정 간 저장 격리, 동시 저장 충돌, 재로그인 복원, 요청 재전송의 멱등성, CSRF 거부, 전체 회로 응답과 평가 중 가중치 불변 검사를 추가해야 한다.

## 구성

- S3 퍼블릭 액세스 차단 네 옵션을 모두 켠다.
- S3 Object Ownership은 `BucketOwnerEnforced`, 저장 암호화는 AES-256이다.
- CloudFront Origin Access Control은 SigV4 `always` 서명을 사용한다.
- 버킷 정책은 이 스택의 CloudFront 배포 ARN에만 `s3:GetObject`를 허용한다.
- `/api/*`는 CloudFront VPC origin으로 EC2의 8080 포트에 전달한다. 최종 EC2 보안 그룹은 CloudFront VPC origin 서비스 보안 그룹만 허용한다. EC2의 공인 IPv4는 패키지·SSM 아웃바운드용이며 퍼블릭 API·SSH 인바운드는 열지 않는다.
- Rust 서버는 HttpOnly·SameSite 세션 쿠키, Origin 검사, 계정별 저장 revision과 request ID, 개체별 요청 영수증을 사용한다. RDS는 공개 액세스를 끄고 서버 보안 그룹에서만 5432를 허용한다.
- HTTP 요청은 HTTPS로 리디렉션하고 CloudFront 기본 인증서를 사용한다.
- VPC origin을 쓰는 현재 배포판은 CloudFront 무료 정액 플랜 대상이 아니므로 종량제 `PriceClass_100`을 사용한다.
- Vite의 `/assets/*`는 1년 동안 캐시하고, `index.html`, JSON 등 변경 가능한 파일은 짧게 캐시한다.
- 확장자가 없는 브라우저 경로만 CloudFront Function에서 `/index.html`로 바꾼다. 존재하지 않는 `.glb`, `.json`, `.js` 요청에는 HTML을 반환하지 않는다.
- 버킷과 객체는 스택 삭제 시에도 보존되도록 버킷에 `Retain` 정책을 둔다.
- 버킷 버전 관리를 켜서 덮어쓴 객체의 이전 버전을 원격에서도 보존하고, 이전 버전은 30일 뒤 정리한다.

## 인프라 생성과 확인

AWS CLI 기본 프로필이 계정 `960243570517`, 리전 `ap-northeast-2`를 가리키는지 확인한 뒤 실행한다.

```powershell
./scripts/deploy-aws.ps1 -ProvisionOnly
```

스크립트는 현재 계정이 예상 계정과 다르면 중단하고, 템플릿 검증 후 스택 생성 또는 갱신이 끝날 때까지 기다린다. 마지막에는 스택 상태와 버킷, 배포 ID, CloudFront 도메인, HTTPS URL 출력을 표시한다.

수동 확인 명령은 다음과 같다.

```powershell
aws cloudformation validate-template --region ap-northeast-2 --template-body file://infra/aws-static.yaml
aws cloudformation describe-stacks --region ap-northeast-2 --stack-name choketmonster-web --query "Stacks[0].{Status:StackStatus,Outputs:Outputs}" --output json
aws s3api get-public-access-block --region ap-northeast-2 --bucket choketmonster-960243570517-apne2
```

## 검토 후 콘텐츠 배포

```powershell
./scripts/deploy-aws.ps1
```

이 명령은 `npm run build`와 `scripts/prepare-deploy.ts`를 실행한 뒤 SHA-256이 검증된 `artifacts/deploy-*` 묶음을 업로드한다. 준비 영수증에는 Git 커밋과 dirty 여부, 파일별 바이트와 SHA-256, 정렬된 파일 목록 전체의 `manifestSha256`을 기록한다. 마지막에 `index.html`을 올리고 CloudFront `/*`를 무효화한 뒤 완료까지 기다린다. 운영 URL에서 모든 파일을 다시 내려받아 해시를 확인하고 배포 시각·계정·버킷·배포·무효화 ID를 `artifacts/deploy-*.deployed.json`에 남긴다.

이전 해시 청크는 열린 브라우저의 요청을 위해 보존한다. 콘텐츠 해시가 붙은 Vite 자산에는 `public,max-age=31536000,immutable`, `index.html`에는 `no-cache,max-age=0,must-revalidate`, 나머지 파일에는 5분 캐시를 설정한다. CloudFront의 `Compress: true`가 브라우저의 `Accept-Encoding`에 따라 압축 응답을 만들고 캐시한다.

`public/models/pokemon/*.glb`와 `public/pokemon/**/*.png`의 로컬 캐시는 배포 묶음과 업로드에서 제외한다. `.gb`, `.gbc`, `.gba`, `.rom` 파일도 경로와 관계없이 제외한다. 준비·배포·운영 검증 스크립트가 이 조건을 각각 확인한다. `data/local`의 MaleCNS 원본 캐시와 실험 추적 파일도 `dist`에 포함되지 않으며 업로드하지 않는다. 운영 화면의 포켓몬 모델과 스프라이트는 `src/game/assets.ts`에 고정된 원본 CDN URL을 사용한다. 외부 재배포 권리가 확인되지 않은 바이너리를 S3에 복사하지 않는다.

CloudFront 배포 완료에는 수 분이 걸릴 수 있다. 파일 업로드 뒤 다음 명령으로 응답을 확인한다.

```powershell
$url = aws cloudformation describe-stacks --region ap-northeast-2 --stack-name choketmonster-web --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text
curl.exe -I $url
curl.exe -I "$url/missing-model.glb"
```

두 번째 요청은 `text/html` 성공 응답이 아니라 실제 403 또는 404여야 한다.

현재 AWS 상태만 다시 검사하려면 다음 읽기 전용 명령을 쓴다. 영수증을 넘기면 운영 URL의 모든 파일을 내려받아 SHA-256도 대조한다.

```powershell
./scripts/verify-aws-deploy.ps1
./scripts/verify-aws-deploy.ps1 -ReceiptPath artifacts/deploy-latest.json
```

## 롤백

준비 단계마다 `artifacts/deploy-<시각>.json`과 같은 이름의 디렉터리를 함께 보존한다. 이전 배포 영수증과 디렉터리가 남아 있으면 빌드 없이 같은 바이트를 다시 게시할 수 있다.

```powershell
./scripts/deploy-aws.ps1 -SkipBuild -ReceiptPath artifacts/deploy-2026-09-11T10-40-32-882Z.json
```

이 명령도 파일 해시를 먼저 검사하고, HTML을 마지막에 게시하고, 캐시 무효화와 운영 URL 재검증을 마친다. 로컬 영수증을 잃었을 때는 S3 버전 관리에서 필요한 객체의 이전 VersionId를 확인해 복원한 뒤 `./scripts/verify-aws-deploy.ps1`로 검사한다.

## 비용과 이전 무료 플랜 기록

현재 VPC origin 구성은 CloudFront 무료 정액 플랜이 지원하지 않으므로 2026-09-12부터 종량제로 운영한다. 서울 리전 공개 가격 조회 원본인 `artifacts/ec2-pricing.json`은 Linux `t3.small` On-Demand를 시간당 USD 0.026, `artifacts/rds-pricing.json`은 PostgreSQL Single-AZ `db.t4g.micro`를 시간당 USD 0.025로 기록한다. 두 인스턴스를 730시간 실행하면 약 USD 37.23이며, RDS·EBS 저장 공간, Secrets Manager, S3, CloudFront 요청·전송량을 더한 현재 계획치는 월 USD 45~50에 트래픽과 세금이 추가되는 범위다. 실제 청구액은 사용량과 환율에 따라 달라지므로 Cost Explorer와 예산 경보로 확인한다.

2026-09-11에는 정적 S3 배포판에 CloudFront `FREE` 정액 플랜과 전용 WAF를 연결했다. 이는 이전 정적 전용 구성의 역사적 기록이며 현재 VPC origin 배포에 적용할 수 없다. Rust 서버 배포 절차는 기존 무료 구독을 비활성화하고 WAF를 분리한 뒤 `PriceClass_100` 종량제 설정과 API VPC origin을 적용한다.

`./scripts/manage-aws-free-plan.ps1`은 여전히 읽기 전용 미리보기를 제공하지만, 사이트 스택의 `ApiVpcOriginId`가 설정되어 있으면 `freePlanCompatible: false`를 표시한다. 이 상태에서 `-Apply`를 실행하면 AWS 리소스를 변경하기 전에 중단한다. 다시 무료 플랜을 검토하려면 먼저 API VPC origin을 제거하는 별도 아키텍처 변경이 필요하다.
