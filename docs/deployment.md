# AWS 정적 배포

초켓몬스터 웹 앱은 서울 리전의 비공개 S3 버킷과 CloudFront로 제공한다. CloudFormation 스택 이름은 `choketmonster-web`, 버킷 이름은 `choketmonster-960243570517-apne2`다.

운영 주소: **https://d3b0jo8g1tseoa.cloudfront.net**

2026-09-11 KST에 코드 커밋 `0a438206f812994a07f30c6be5a0c08d949ca6ea`를 GitHub `main`에 푸시한 뒤 배포했다. 준비한 27개 파일(6,169,800바이트)을 운영 URL에서 다시 내려받아 SHA-256이 모두 일치함을 확인했다. CloudFront 캐시 무효화 `IDJMF6VG3YRR529XKCU3AUQUC0`는 `Completed`다. 루트 페이지는 HTTPS 200, 없는 GLB는 XML 403으로 응답했다.

운영 주소의 브라우저 검사에서는 원통형 트레이너가 없는 파트너 이동, 수평·수직 카메라 조작, 저장·좌표 복원, 네 기술 슬롯, 151종 검색과 모바일 화면을 확인했다. 브라우저 오류와 실패한 자산 요청은 0개였다. 화면은 `artifacts/openworld-smoke-aws-release/`, 파일 검증 결과는 `artifacts/aws-release-verification.json`에 저장했다.

## 구성

- S3 퍼블릭 액세스 차단 네 옵션을 모두 켠다.
- S3 Object Ownership은 `BucketOwnerEnforced`, 저장 암호화는 AES-256이다.
- CloudFront Origin Access Control은 SigV4 `always` 서명을 사용한다.
- 버킷 정책은 이 스택의 CloudFront 배포 ARN에만 `s3:GetObject`를 허용한다.
- HTTP 요청은 HTTPS로 리디렉션하고 CloudFront 기본 인증서를 사용한다.
- 비용 범위를 줄이기 위해 `PriceClass_100`을 사용한다.
- Vite의 `/assets/*`는 1년 동안 캐시하고, `index.html`, JSON 등 변경 가능한 파일은 짧게 캐시한다.
- 확장자가 없는 브라우저 경로만 CloudFront Function에서 `/index.html`로 바꾼다. 존재하지 않는 `.glb`, `.json`, `.js` 요청에는 HTML을 반환하지 않는다.
- 버킷과 객체는 스택 삭제 시에도 보존되도록 버킷에 `Retain` 정책을 둔다.

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

이 명령은 `npm run build`와 `scripts/prepare-deploy.ts`를 실행한 뒤 SHA-256이 검증된 `artifacts/deploy-*` 묶음을 업로드한다. 마지막에 `index.html`을 올리고 CloudFront `/*`를 무효화한다. 이전 해시 청크는 열린 브라우저의 요청을 위해 보존한다. 콘텐츠 해시가 붙은 Vite 자산에는 `public,max-age=31536000,immutable`, `index.html`에는 `no-cache,max-age=0,must-revalidate`, 나머지 파일에는 5분 캐시를 설정한다.

`public/models/pokemon/*.glb`와 `public/pokemon/**/*.png`의 로컬 캐시는 배포 묶음과 업로드에서 제외한다. 준비 스크립트는 파일 경로·바이트 수·해시를 receipt에 기록하고 배포 스크립트는 이를 다시 검증한다. `data/local`의 MaleCNS 원본 캐시와 실험 추적 파일도 `dist`에 포함되지 않으며 업로드하지 않는다. 운영 화면의 포켓몬 모델은 별도로 검토된 원본 CDN resolver를 사용해야 한다.

CloudFront 배포 완료에는 수 분이 걸릴 수 있다. 파일 업로드 뒤 다음 명령으로 응답을 확인한다.

```powershell
$url = aws cloudformation describe-stacks --region ap-northeast-2 --stack-name choketmonster-web --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text
curl.exe -I $url
curl.exe -I "$url/missing-model.glb"
```

두 번째 요청은 `text/html` 성공 응답이 아니라 실제 403 또는 404여야 한다.
