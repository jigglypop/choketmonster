# AWS 정적 배포

초켓몬스터 웹 앱은 서울 리전의 비공개 S3 버킷과 CloudFront로 제공한다. CloudFormation 스택 이름은 `choketmonster-web`, 버킷 이름은 `choketmonster-960243570517-apne2`다.

운영 주소: **https://d3b0jo8g1tseoa.cloudfront.net**

최신 배포는 2026-09-11 KST의 `artifacts/deploy-2026-09-11T12-14-41-855Z.deployed.json`이다. 관동 v2 이동 경계, 순간이동, 선택·추적, 경험치 공유와 보상 기록을 포함한 44개 파일(6,884,964바이트)을 운영 URL에서 다시 내려받아 SHA-256이 모두 일치함을 확인했다. 전체 목록 해시는 `fd595563e496aa4704d3a36432fe1babd87f766f9738e366499a76f2e2313967`이다. CloudFront 캐시 무효화는 완료됐으며 스택은 `UPDATE_COMPLETE`, 배포판은 `Deployed`, 없는 GLB는 XML 403이다. 작업 트리의 수정본을 배포했으며 이번 변경을 GitHub에 푸시하지 않았다.

파일 검증은 `artifacts/aws-deploy-verification.json`에 저장한다. 최신 빌드는 로컬 `http://localhost:5173/`에도 동일한 보존 배포 폴더를 Vite preview로 제공한다. 소스 개발과 Playwright의 기본 포트는 검사 중 충돌을 피하도록 5174를 사용했다. 실제 배포 화면 검사는 `KANTO_URL=https://d3b0jo8g1tseoa.cloudfront.net npx playwright test tests/ui/kanto.spec.ts`이며 스크린샷은 `artifacts/kanto-browser/`에 기록한다.

최신 운영 주소에서 관동 조작·구매·모바일, 야생 정보·추적·순간이동·경험치 공유 저장, 수동 배틀·승리 후 포획·재접속, 이전 v1 좌표와 개체 뇌 보존 복원까지 브라우저 시나리오 4개가 통과했고 각 시나리오의 JavaScript 실행 오류는 0개였다. 로컬 5173의 동일 빌드에서도 선택·추적·순간이동·공유 설정 저장을 다시 확인했다. 코어 테스트 84개와 `npm run build`가 통과했다. Vite의 큰 번들 경고는 남아 있다.

## 구성

- S3 퍼블릭 액세스 차단 네 옵션을 모두 켠다.
- S3 Object Ownership은 `BucketOwnerEnforced`, 저장 암호화는 AES-256이다.
- CloudFront Origin Access Control은 SigV4 `always` 서명을 사용한다.
- 버킷 정책은 이 스택의 CloudFront 배포 ARN에만 `s3:GetObject`를 허용한다.
- HTTP 요청은 HTTPS로 리디렉션하고 CloudFront 기본 인증서를 사용한다.
- 종량제 상태에서는 비용 범위를 줄이기 위해 `PriceClass_100`을 사용한다. 무료 정액 플랜에서는 플랜 호환 조건에 맞춰 `PriceClass_All`을 사용하며 이 배포판의 CDN 요금은 플랜에 포함된다.
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

## CloudFront 무료 정액 플랜

AWS는 2026-09-03부터 [PricingPlanManager API와 CloudFormation 지원](https://aws.amazon.com/about-aws/whats-new/2026/09/cloudfront-flat-rate-pricing-plans-api/)을 제공한다. [무료 플랜](https://docs.aws.amazon.com/PricingPlanManager/latest/UserGuide/plans.html)은 월 USD 0, 데이터 전송 100GB, 요청 100만 건과 S3 Standard 5GB 크레딧을 포함하며 CloudFront 배포에 트래픽 초과 요금을 붙이지 않는다. 허용량은 차단선이 아니며 장기간 크게 초과하면 AWS가 전송 성능을 조정할 수 있다. 다만 AWS Free Tier 계정은 이 플랜을 사용할 수 없고, 배포에 전용 `CLOUDFRONT` 범위 WAF Web ACL이 연결되어야 한다. 지원하지 않는 기능과 계정·리소스 제약은 [CloudFront 공식 문서](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)에서 확인한다.

다음 명령은 기본적으로 계정, 기존 배포 ARN, 두 CloudFormation 템플릿만 읽고 검증하며 AWS 리소스를 바꾸지 않는다.

```powershell
./scripts/manage-aws-free-plan.ps1
```

검토 후 무료 플랜을 적용할 때만 `-Apply`를 명시한다.

```powershell
./scripts/manage-aws-free-plan.ps1 -Apply
```

적용은 `us-east-1`에 전용 WAF를 만들고 기존 배포에 연결한 다음, `FREE`와 `DEFAULT` 사용량으로 고정된 구독을 활성화한다. 플랜 모드에서는 AWS 관리형 `CachingOptimized` 캐시 정책과 `SecurityHeadersPolicy` 응답 헤더 정책을 사용하고 `PriceClass_All`로 전환한다. `UseOriginCacheControlHeaders` 관리형 정책은 뷰어의 `Host` 헤더를 전달해 비공개 S3 REST 원본을 404로 만들기 때문에 사용하지 않는다. `CachingOptimized`는 `Host`를 전달하지 않고 S3 객체의 `Cache-Control`을 존중한다.

스크립트와 템플릿에는 유료 tier나 유료 승인 작업이 없다. 미리보기는 Cloud Control API로 기존 구독 수도 확인하며, 이미 이 배포판에 활성 무료 구독이 있으면 성공으로 종료한다. 계정의 무료 플랜 3개 한도를 채웠거나 기존 구독 상태가 `ACTIVE/FREE`가 아니면 적용을 중단한다. WAF 연결 뒤 구독 활성화 또는 검증이 실패하면 같은 실행에서 `WebAclArn`을 비우고 종량제용 `PriceClass_100`과 사용자 정의 정책을 복원한 뒤 임시 WAF 스택을 삭제한다.

2026-09-11 현재 배포판 `E1P12YSCXY1AKT`에는 무료 구독 `arn:aws:pricingplanmanager::960243570517:subscription:sub_3JBD7uJGoTmxs5Tcuij7xYfF6xr`가 `ACTIVE` 상태로 연결되어 있다. 구독의 `ResourceArns`에는 이 배포판과 전용 WAF `choketmonster-free-plan-web-acl`이 모두 들어 있으므로 이 WAF의 기본 요금과 요청 요금도 플랜에 포함된다. 계정에는 다른 배포용 활성 `FREE` 구독 1개가 별도로 있다. 운영 루트는 HTTPS 200, 없는 GLB는 XML 403으로 다시 확인했다.

현재 설치된 AWS CLI 2.34.43은 `pricingplanmanager` 직접 명령을 아직 노출하지 않지만 CloudFormation은 새 리소스 타입을 검증하므로 이 경로를 사용한다. WAF 생성과 무료 구독 활성화 사이의 짧은 시간에는 표준 WAF 요금이 계산될 가능성이 있다. S3의 최근 30일 롤백 버전 저장량처럼 플랜에 포함되지 않거나 허용량을 벗어난 서비스 비용도 별도로 발생할 수 있다.
