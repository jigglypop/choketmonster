# 대표 이미지

2026-09-15 사용자가 제공하고 사이트 배포를 요청한 `chocketmon.png`를 원본 그대로 사용한다. 별도의 자르기, 재생성, 색상 변경은 하지 않았다. 이 기록은 사용자의 해당 사이트 배포 요청을 기록하며 이미지에 포함된 캐릭터의 권리를 새로 부여하거나 별도의 라이선스를 주장하지 않는다.

- 원본 보관: 저장소 루트 `chocketmon.png`
- 배포 파일: `public/chocketmon.png`
- PNG, 1024 × 1536, 2,118,882바이트
- SHA-256: `791b4048dfd8f5c6eeb0b8725fe9996294d25e2fc3421f3fbbfc2bfaa190877e`
- 사용 위치: OG(카카오톡 링크 미리보기), Twitter 카드, 브라우저 아이콘, Apple 터치 아이콘

초기 HTML에서 HTTPS 절대 이미지 주소와 실제 크기를 제공한다. `vite.config.ts`가 파일 SHA-256의 앞 12자리를 URL의 `v` 값에 넣으며, 파일 교체 뒤에는 개발 서버를 다시 시작하거나 production build를 실행해야 새 해시가 반영된다. AWS 배포는 기존 이미지와 HTML의 CloudFront 캐시를 무효화한다.

이미 공유된 주소의 카카오 캐시는 CloudFront와 별개다. [카카오 공식 FAQ](https://developers.kakao.com/docs/ko/message-template/faq)에 따라 [OG 캐시 초기화](https://developers.kakao.com/tool/clear/og)에서 사이트 주소와 이미지 주소를 초기화할 수 있다. 이미 발송된 메시지의 화면까지 자동 갱신된다고 보장하지 않는다.
