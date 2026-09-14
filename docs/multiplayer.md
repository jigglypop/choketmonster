# 회원 전용 실시간 플레이어와 지역 채팅

실시간 기능은 같은 장면에 있는 플레이어의 포켓몬, 위치, 방향, 탐험·전투 상태와 채팅을 WebSocket으로 공유한다. 포획 개체, 전투 결과, 게임 머니, 저장 파일은 이 채널로 보내지 않는다.

채팅과 플레이어 목록에는 앱 회원가입 아이디를 이름으로 표시한다. 별도 닉네임 입력은 없으며 클라이언트가 표시 이름을 지정하거나 바꿀 수 없다. 로그인하지 않은 사용자는 실시간 방에 접속하거나 채팅을 읽고 보낼 수 없다. 화면에는 `로그인 필요` 상태, 비활성 메시지 입력란, `가입 / 로그인` 버튼을 표시한다.

## 인증과 연결 유지

브라우저는 HttpOnly 세션 쿠키로 메인 API의 `POST /api/auth/realtime-ticket`을 호출한다. API는 현재 회원의 UUID와 아이디, 60초 만료 시각, 암호학적 난수를 담은 HMAC-SHA256 서명 티켓을 발급한다. 요청에는 허용된 `Origin`과 JSON Content-Type이 필요하다. 티켓 발급은 계정당 10분에 30회로 제한한다.

브라우저는 `wss://<현재 호스트>/api/realtime?ticket=<ticket>`으로 접속한다. 전용 실시간 서버는 메인 API와 같은 `REALTIME_TICKET_SECRET`으로 서명을 검증하며, 만료되었거나 변조되었거나 이미 사용한 티켓을 거부한다. 연결 ID와 화면 이름은 티켓의 회원 UUID와 아이디에서만 만든다. 계정 하나는 동시에 한 연결만 유지한다.

클라이언트는 연결을 끊지 않고 40초마다 새 티켓을 받아 다음 프레임을 보낸다.

```json
{"type":"reauth","ticket":"<new one-time ticket>"}
```

서버는 새 티켓의 UUID와 아이디가 현재 연결과 모두 같을 때만 인증 만료를 연장한다. 일시적인 네트워크 실패는 5초 뒤 다시 시도한다. 로그아웃이나 계정 전환은 현재 소켓을 즉시 닫고, 새 계정 로그인이 끝나면 새 티켓으로 접속한다. 로그인 세션이 없어 티켓 발급이 401을 반환하면 화면 상태는 `auth-required`가 된다. 인증을 기한 안에 갱신하지 못한 연결은 서버 heartbeat에서 종료한다.

## 장면별 방

`region`은 `kanto` 또는 `johto`이고 `sceneId`는 다음 고정 형식이다.

- 지상: `surface:<region>`
- 동굴: `cave:<region>:<cave-id>`

`sceneId` 안의 지역은 `region`과 같아야 한다. 지상과 동굴, 서로 다른 동굴은 각각 별도 방이다. 플레이어 목록, 위치 패치, 최근 채팅은 같은 `region + sceneId` 참가자에게만 전달된다. 동굴 출입이나 지역 이동 시 클라이언트는 같은 연결에서 새 `join`을 보내며 이전 방의 목록과 채팅을 비운다.

`join`은 이름을 받지 않는다.

```json
{
  "type": "join",
  "region": "johto",
  "sceneId": "surface:johto",
  "speciesId": 152,
  "x": 12,
  "z": 8,
  "heading": 1,
  "activity": "moving"
}
```

최초 `welcome`은 현재 방의 플레이어와 최근 채팅을 보내고, 이후에는 변경된 플레이어와 퇴장 ID만 `patch`로 보낸다. 위치는 0.01 단위로 양자화한다. 채팅은 200자까지이며 메모리에 방별 최근 50개를 보관하므로 실시간 서버가 재시작되면 사라진다.

## 화면 동작

탐험 화면 하단 채팅 도크에는 현재 지역 채널, 연결 상태, 참가자 수, 회원 아이디, 메시지 기록을 표시한다. 참가자 목록에서 다른 회원을 선택하면 지도에서 위치를 추적할 수 있다. Enter는 채팅 입력과 전송에 사용하고 Esc는 이동 조작으로 돌아간다. 한글 조합 중 Enter는 전송하지 않는다. 사용자가 이전 기록을 읽는 동안 새 메시지가 도착하면 현재 스크롤을 유지하고 `새 메시지` 버튼을 표시한다.

원격 플레이어 렌더링은 기존 포켓몬 모델, 거리 제한, 최대 표시 수를 그대로 사용한다. 실시간 서버의 위치는 다른 사용자를 보여주기 위한 표시 정보이며 전투 판정이나 보상 계산에 사용하지 않는다. 개체와 게임 머니 이동은 별도의 [계정 간 거래](trading.md) API가 처리한다.

## 서버 한도와 운영 구성

- 입력 프레임: 최대 4KB
- 연결당 전체 입력: 초당 40개
- 상태 갱신: 초당 15개
- 채팅: 10초에 5개
- 방 정원: 기본 64명
- 서버 정원: 운영 기본 128명
- heartbeat: 15초, 응답 대기 45초
- 송신 timeout: 5초

`REALTIME_ONLY=true`로 실행한 Rust 프로세스는 PostgreSQL에 연결하지 않고 `/api/realtime`과 `/api/realtime/health`만 제공한다. 운영에서는 `infra/aws-realtime.yaml`의 기존 소형 EC2를 CloudFront VPC origin으로 사용한다. 메인 API가 회원 세션을 검증하고 티켓을 발급하며, 전용 서버는 공유 서명키만으로 티켓을 검증한다.

공유 키는 `infra/aws-server.yaml`의 Secrets Manager 리소스가 생성한다. 메인 API 설치 스크립트와 실시간 서버의 SSM 배포 문서는 이 값을 각각 root 전용 EnvironmentFile에 기록한다. 로그와 배포 산출물에는 키 값을 출력하지 않는다.

## 검증

서버 단위 테스트는 Origin, 티켓 변조·재사용, 다른 계정 reauth, 입력 제한, 장면 격리, 채팅 격리, 실제 WebSocket upgrade와 종료 정리를 확인한다. `tests/realtime-client.test.ts`는 최신 상태 전송, backpressure, 방 전환, 재접속, 로그인 전환과 40초 reauth를 확인한다.

실제 계정·DB·WebSocket 경로는 다음 명령으로 검사한다.

```powershell
uv run --with websockets==17.0.1 python scripts/verify-authenticated-realtime.py `
  --api http://127.0.0.1:8080 `
  --ws ws://127.0.0.1:8080/api/realtime `
  --origin http://127.0.0.1:5186 `
  --verify-reauth
```

실제 브라우저 UI 검사는 두 개의 독립 브라우저 컨텍스트에서 회원가입, 회원 아이디 표시, 양방향 채팅, 참가자 목록과 72초 동안 소켓을 교체하지 않은 reauth를 확인한다.

```powershell
$env:CHOKETMON_TEST_PORT='5186'
$env:CHOKETMON_LIVE_AUTH='1'
pnpm exec playwright test tests/ui/multiplayer.spec.ts --workers=1
```

`scripts/verify-realtime.py`의 부하 검사는 로컬 `REALTIME_TICKET_SECRET` 환경 변수가 전용 서버와 같을 때만 실행한다. 공개 서버에서는 최대 2개 연결·5초·채팅 없음으로 제한한다. 이 검사는 프로토콜과 제한된 서버 부하를 확인하며 브라우저 FPS나 동시 사용자 SLA를 의미하지 않는다.
