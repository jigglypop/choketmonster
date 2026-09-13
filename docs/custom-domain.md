# chocketmon.com 운영

운영 주소는 https://chocketmon.com 이다. 기존 https://d3b0jo8g1tseoa.cloudfront.net 주소도 같은 CloudFront 배포에서 제공한다.

2026-09-14 KST에 사용자가 승인한 1년 등록을 AWS Route 53 Domains로 완료했다. 등록 가격은 USD 16이며 DNS 등 기존 인프라 비용은 별도다. 등록자·관리·기술 연락처는 사용자 지정에 따라 기존 `signight.com`과 동일하게 복사하고 개인정보 보호를 켰다. 자동 갱신은 껐으므로 만료 전에 갱신해야 한다. 연락처 원문은 코드·영수증·로그에 남기지 않는다.

- 등록 작업: `94ac5c2d-ab79-41af-bddb-9af6960fa8cc` (`SUCCESSFUL`)
- CloudFront: `E1P12YSCXY1AKT`, 별칭 `chocketmon.com`
- 공개 DNS zone: `Z038546815YZUTI7DNF1M`, apex A/AAAA alias
- 인증서: `us-east-1` ACM, DNS 검증 완료
- Rust `APP_ORIGIN`: 새 도메인과 기존 CloudFront 주소를 모두 허용
- 로컬 작업 영수증: `artifacts/custom-domain-chocketmon.json`

`scripts/configure-custom-domain.py`는 이 계정과 도메인에 범위를 고정한다. 등록 요청 전 영수증을 남기며 결과가 불확실한 유료 등록을 자동으로 다시 제출하지 않는다. 동시 실행은 잠금 파일로 거부한다. `status`, `dns`, `attach`, `allow-origin` 단계로 상태 확인과 이어서 구성을 수행할 수 있다. 이미 등록한 도메인에 `register`를 다시 실행하지 않는다. 배포 스크립트는 기존 사용자 도메인·인증서 파라미터와 허용 Origin을 보존한다.

브라우저 저장소와 로그인 쿠키는 주소별로 분리된다. 기존 주소에서 계정에 저장한 게임은 새 주소에서 같은 계정으로 로그인해 불러올 수 있다. 게스트 진행은 기존 주소에서 JSON을 내보내고 새 주소에서 가져와야 한다. 전체 회로의 체크포인트·재현 이력은 별도 IndexedDB에만 있으며 서버 저장과 JSON 내보내기에 포함되지 않으므로 주소 이동 시 자동 이전되지 않는다. 기존 주소는 이 기록을 계속 사용할 수 있도록 유지한다.

HTTPS 인증서와 DNS 검증 레코드는 갱신을 위해 유지한다. [AWS CloudFront 인증서 요구사항](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)과 [Route 53 가격](https://aws.amazon.com/route53/pricing/)을 참고한다.
