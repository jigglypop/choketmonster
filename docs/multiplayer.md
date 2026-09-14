# 지역별 실시간 플레이어와 채팅

같은 지역에 접속한 플레이어의 이름, 선두 포켓몬, 위치·방향과 탐험/전투 상태를 WebSocket으로 공유한다. 야생 개체·전투 결과·팀·박스·개체별 회로와 저장 데이터는 개인 모험에 남는다. 공유 위치는 다른 사람을 보여주기 위한 정보이며 경쟁 전투의 판정에 사용하지 않는다.

표시 이름은 기기에 저장하는 최대 16자의 닉네임이다. 계정 인증 표시나 계정 ID를 공개하지 않는다. 서버가 연결마다 별도 ID를 부여하며 재접속하면 현재 지역의 플레이어 목록을 다시 받는다. 지역 채팅은 최대 200자, 서버 메모리에 최근 50개만 보관한다. 서버 재시작 시 채팅은 사라지며 게임 저장과 별개다.

## 통신과 렌더링

- 브라우저는 위치가 바뀌었을 때만 초당 최대 10회 전송한다. 서버는 같은 틱의 반복 갱신을 마지막 값으로 합치고 좌표를 0.01 단위로 정리한다.
- 최초 `welcome`은 현재 지역 전체 목록, 이후 `patch`는 변경된 플레이어와 떠난 ID만 보낸다. 채팅에도 지역을 붙여 지역 이동 직전 대기 중이던 메시지가 새 지역에 섞이지 않게 한다.
- 화면은 원격 이동을 보간하고 기존 포켓몬 모델·캐시·거리별 표시 예산을 사용한다. 원격 플레이어는 로컬 시뮬레이션 개체 목록, 난수와 저장에 들어가지 않는다.
- 연결 오류는 지연 시간을 늘리며 재접속한다. 송신 버퍼가 밀리면 오래된 위치를 쌓지 않고 최신 위치를 다음 기회에 보낸다. 숨겨진 탭과 닫힌 화면의 연결·타이머를 정리한다.
- 서버는 지역별 최대 64명, 운영 환경 전체 최대 128명으로 제한한다. 입력 프레임은 4KB, 상태 갱신은 초당 15개, 채팅은 10초에 5개까지 허용한다. 느린 연결은 제한된 송신 큐에서 정리하고 15초 heartbeat와 45초 타임아웃을 사용한다.

## 서버 구성

`/api/realtime`은 Rust Axum WebSocket 엔드포인트이며 `/api/realtime/health`에서 상태와 인원 수를 확인한다. `REALTIME_ONLY=true`이면 PostgreSQL과 커넥톰을 읽지 않는다. 일반 API 모드에도 같은 경로를 제공하므로 로컬 개발은 기존 API 한 개로 실행할 수 있다.

운영 구성은 `infra/aws-realtime.yaml`의 별도 `t3.micro` 한 대다. 기존 `t3.small` 신경 계산 API와 RDS를 유지하며, 추가 NAT Gateway나 로드 밸런서를 만들지 않는다. 전용 서비스는 256MB 메모리 제한을 두고 비특권 사용자로 실행한다. 인바운드는 기존 CloudFront VPC 보안 그룹만 허용한다. 관리·배포를 위한 아웃바운드 연결에는 EC2 공인 IPv4를 사용하므로 인스턴스·8GB EBS·IPv4·실제 전송량 비용이 발생한다.

CloudFront에서 `api/realtime*`을 기존 `api/*`보다 먼저 전용 VPC origin에 연결하고 캐시를 끈다. 브라우저는 사이트와 같은 호스트의 `wss://.../api/realtime`에 연결한다. 설정 근거: [CloudFront WebSocket 전달 헤더](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html), [VPC origins 지원과 접근 제한](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html), [Axum WebSocket API](https://docs.rs/axum/latest/axum/extract/ws/index.html).

배포 파이프라인은 같은 검증된 Linux 실행 파일을 기존 API와 실시간 서버에 설치한 뒤 정적 사이트를 게시한다. SSM 명령은 SHA-256을 확인하고 새 프로세스의 health가 실패하면 해당 서비스의 검증된 이전 실행 파일로 복구한다. 두 서비스 전체가 하나의 트랜잭션으로 되돌아가는 것은 아니므로 둘째 서비스 실패 시 정적 게시를 중단하고 각 서버 영수증을 확인해 복구한다. 각 서버 명령과 최종 사이트 버전의 영수증은 `artifacts/ci-deploy-<commit>/`에 남긴다.

## 실행과 검증

기본 개발 서버는 [모험 변경 문서](campaign-balance.md)의 명령을 사용한다. 전용 모드만 따로 실행할 때는 환경 변수 `REALTIME_ONLY=true`, `LISTEN_ADDR=127.0.0.1:8081`, `APP_ORIGIN=http://127.0.0.1:5186`을 설정하고 Rust 실행 파일을 시작한다. Vite의 `REALTIME_PROXY_TARGET`으로 별도 주소를 지정할 수 있다.

```powershell
uv run --with websockets==17.0.1 python scripts/verify-realtime.py --url ws://127.0.0.1:8081/api/realtime --clients 64 --seconds 5 --chat --out artifacts/realtime-dedicated-64.json
```

소켓 검사는 실제 연결·채팅 전달·갱신 수·수신 바이트·ping 왕복 지연을 기록한다. 공개 엔드포인트 검사는 최대 두 연결·5초로 제한하고 채팅을 보내지 않는다. 이 수치는 소켓 서버의 제한된 부하 검사이며 브라우저 FPS나 전체 게임의 동시 접속 보장 수치가 아니다. `tests/ui/multiplayer.spec.ts`는 게임 UI 한 개와 별도 브라우저 컨텍스트의 WebSocket 상대를 연결해 실제 양방향 채팅·위치 갱신·지역 이동과 재접속을 검사한다. Windows 소프트웨어 렌더링 환경에서 두 3D 화면을 동시에 돌리는 검사는 시간 제한에 걸려 완료하지 못했다. 클라이언트 복구와 큐 처리는 `tests/realtime-client.test.ts`, 서버 프로토콜 검사는 `rust-server/src/realtime.rs`에 있다.

2026-09-14 로컬 전용 프로세스의 5초 측정:

| 접속 / 이동 중 | ping 표본 | RTT p50 / p95 | 전체 클라이언트 합계 수신량 |
| --- | --- | --- | --- |
| 64 / 1 | 320 | 4.12 / 28.74ms | 약 144KB/s |
| 64 / 64 | 320 | 5.37 / 6.86ms | 약 7.00MB/s |

서로 다른 시점의 짧은 측정이므로 둘 사이의 지연 차이를 인과 효과로 해석하지 않는다. 첫 검사에서 변경된 개체는 patch당 정확히 1개였으며, 64개 연결 모두 지역 채팅을 받았다. 모든 플레이어가 동시에 움직이면 지역 전체 전달량이 크게 늘어난다. 운영 전송 비용과 실제 이용 패턴은 이 최대 부하 수치와 따로 확인해야 한다. 원본 결과는 `artifacts/realtime-dedicated-64.json`, `artifacts/realtime-dedicated-64-moving.json`이다.
