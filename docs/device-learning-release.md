# 기기 저장·기술 학습·자동 배포 변경

2026-09-12 후속 요청에 따라 로그인·가입·로그아웃 UI를 제거했다. 모험과 개체별 기억은 이 기기의 IndexedDB에 저장한다. 전체 166,700-node 회로는 Rust가 계산하지만 정상 전투와 저장은 PostgreSQL에 접근하지 않는다. 기존 계정 데이터는 삭제하지 않았다. 상세 계약은 [Rust와 기기 저장](rust-server.md), 배포는 [자동 배포](auto-deploy.md)에 있다.

## 행동과 저장

- 새 모험은 기술 학습이 켜져 있다. 기존 저장은 한 번만 기본값을 이전하고 이후 끄기 설정을 유지한다.
- 자동 기술 선택에서 공격·회복·버프·상태 기술의 실제 효과를 게임용 보상으로 학습한다. 학습 중에만 epsilon 0.08 탐색을 한다.
- 자동 전투에서 PP가 남은 유효 기술을 사용하고 매 3번째 턴에 유효 공격이 있으면 공격을 선택한다. PP가 모두 소진되면 발버둥을 사용한다. 이 행동 제한은 학습과 분리한 게임 규칙이다.
- 기술 우선도, 상태·단계가 반영된 스피드, 결정론적 동률 처리 순서를 검사했다. 애니메이션도 실제 실행 순서를 따라 재생한다.
- 기술 결정을 기기에 저장한 다음 전투에 적용하고, 전투 결과도 다음 결정 전에 저장한다. 서버 캐시가 없어져도 체크포인트와 최대 7턴 이력으로 복원한다.
- 이동 모드, 자동 대상 선택, HP와 기술 카드의 크기·정렬을 정리하고 수동 다음 파트너 선택 UI를 제거했다.

## 측정과 한계

같은 정지 화면·시드·1440×1000·DPR 0.7·소프트웨어 렌더러 비교에서 삼각형 수는 1,005,326→520,708(-48.21%), 중앙 프레임 시간은 419.8→374.5ms(-10.79%)였다. 실제 GPU의 FPS로 해석하지 않는다. 원자료는 `artifacts/render-upgrade/perf-before.json`, `perf-after.json`이다.

실제 로컬 release Rust의 2개체 배치는 요청 697B·응답 521B·45.882ms였다. 체크포인트 참조가 있는 warm 요청은 424B였고 cold 복원에서만 약 830KB를 보냈다. 이는 로컬 측정이며 운영 EC2·인터넷 지연과 구분한다. `artifacts/local-brains-final-api.json`의 20개 검사는 체크포인트와 이력의 byte 단위 복원, 멱등성, 부분 배치 재전송과 PostgreSQL 삽입·갱신·삭제 통계 불변을 확인한다.

실제 전체 그래프를 이용한 제한 비교는 뇌 seed 2개마다 학습 6회, 별도 공통 평가 seed 4개를 사용했다. 학습 전후 모두 2승/8회이고 평균 보상은 -0.2572→-0.2959였다. 가중치 갱신과 재현은 확인했지만 이 비교에서 실력 향상은 확인하지 못했다. [실험 조건과 결과](battle-benchmark.md).

## 공개 버전 확인

`git push origin main`으로 GitHub Actions가 실행된다. 마지막 운영 배포 커밋을 기준으로 Rust 변경을 검사하므로 이전 push가 실패해도 필요한 서버 변경을 빠뜨리지 않는다. OIDC로 AWS 역할을 얻고 서버 설치가 건강 상태 검사를 통과한 다음 정적 파일을 공개한다. 새 실행 파일의 시작이나 검사에 실패하면 이전 실행 파일로 복구한다. CloudFront 무효화 후 모든 배포 파일의 HTTPS SHA-256과 `/version.json` 커밋을 검사한다.

운영 UI 검증은 `CHOKETMON_BASE_URL=https://d3b0jo8g1tseoa.cloudfront.net`, `CHOKETMON_LIVE_RUST=1`에서 `tests/ui/rust-live.spec.ts`로 실행한다. 별도 API 검증은 `scripts/verify-local-brains.ts --base-url https://d3b0jo8g1tseoa.cloudfront.net --origin https://d3b0jo8g1tseoa.cloudfront.net --skip-db`를 사용한다. `--skip-db`는 로컬 DB 통계를 운영 DB의 증거로 오인하지 않도록 명시한다. 실제 배포 결과는 GitHub 실행과 `artifacts/ci-deploy-{commit}/receipt.json`으로 확인한다.
