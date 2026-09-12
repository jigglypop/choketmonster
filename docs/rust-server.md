# Rust 회로 계산과 기기 저장

현재 게임은 로그인 UI 없이 진행을 `choketmon-151` IndexedDB에, 전체 회로의 개체별 체크포인트·재현 이력을 `choketmon-neural-cache` IndexedDB에 저장한다. `POST /api/local-brains/step-batch`는 1~2개체를 로그인 없이 계산하며 PostgreSQL을 읽거나 쓰지 않는다. 기존 계정과 테이블은 삭제하지 않고 호환용으로 보존한다. 아래 계정 API 설명은 이전 방식의 호환 동작이다.

## 기기 전용 회로 API

배치는 불투명한 `clientId`, 개체별 ID와 요청·episode ID, 12개 감각, 5개 합법 행동 mask, 직전 보상, 학습·종료 여부를 받는다. 기기의 비밀 난수·모험 seed·graph ID를 SHA-256으로 묶어 client ID를 만들며 기기 ID 원문은 서버에 보내지 않는다. JSON·Origin 검사와 no-store 응답을 유지한다.

서버는 최대 64개체, 15분 TTL의 임시 LRU 캐시와 계산 permit 2개를 사용한다. 동일 클라이언트의 겹치는 요청은 429로 제한한다. 평소에는 체크포인트 ID와 최대 7턴 이력만 보낸다. 캐시가 사라지면 428 `CHECKPOINT_REQUIRED`를 받고 같은 요청 ID로 압축 체크포인트를 한 번 재전송한다. 8번째 결정과 전투 종료에 새 체크포인트를 받는다. 체크포인트에는 episode ID, 그래프 ID, 활동, readout, RNG, 직전 학습 특징·행동이 들어간다. 서버가 재시작돼도 기기의 체크포인트·이력으로 같은 상태를 복원한다. 같은 요청의 재시도는 동일 결과, 같은 ID의 다른 감각은 409이다.

기술 학습은 새 모험의 기본값이다. 구버전 저장은 한 번만 기본값을 켜고 이후 사용자의 끄기를 보존한다. 학습 때만 합법 행동 중 epsilon 0.08 탐색을 수행한다. `learning=false`는 readout·update count·학습 RNG를 바꾸지 않는다. 공격·버프·회복·상태의 실제 효과와 승패를 게임용 보상으로 반영한다. PP가 있을 때 대기를 제외하고 매 3번째 턴에 유효 공격이 있으면 공격을 선택하는 규칙, 불필요한 회복·포화 버프·불가능한 상태 제외는 학습과 별개의 설계다.

월드 이동은 브라우저의 실측 128-node 부분 회로, 운영 전투는 Rust의 166,700-node 그래프를 사용한다. 네트워크를 기다리는 동안 월드 시계는 계속 흐르며 필요한 결정 없이 전투 턴을 넘기지 않는다. 서버 오류는 화면에 표시하고 일시 정지한다. 엔진의 기술 우선도·스피드·동률 판정 순서와 실제 실행 순서의 애니메이션을 사용한다.

신경 결정은 IndexedDB 쓰기를 마친 뒤 전투에 전달한다. 다른 탭이 같은 기억을 앞서 바꾸면 오래된 응답으로 덮어쓰지 않고 충돌을 알린다. 기본 기기 슬롯이 비어 있을 때만 기존 로컬 계정 슬롯을 한 번 이전할 수 있으며 서버 세이브를 내려받지 않는다. JSON 내보내기는 게임·브라우저 부분 회로·기술 통계를 포함한다. 전체 회로 체크포인트는 이 기기의 별도 IndexedDB에 있다.

`scripts/verify-local-brains.ts`는 실제 API의 배치·학습·체크포인트·멱등성·재현 및 DB 쓰기 불변을 확인한다. `CHOKETMON_LIVE_RUST=1`의 `tests/ui/rust-live.spec.ts`는 로그인 없는 전투와 기기 기억 복원을 확인한다. 실력 변화는 [제한된 비교](battle-benchmark.md)의 수치로 판단하며 구현과 테스트 통과를 생물학적 학습의 증거로 설명하지 않는다.

## 기존 계정 API와 운영 호환

`rust-server/`는 Axum + Tokio + SQLx 서버다. PostgreSQL에 users, sessions, saves, neural_states, neural_requests를 저장하며 SQL migration을 시작 시 적용한다. 실제 MaleCNS [166,700개 curated neuron graph](full-connectome.md)를 한 번만 로드해 공유하고 개체별 활동·학습 출력·난수 상태를 분리한다. 클라이언트의 전투 계산과 서버 신경 정책을 결합한 구조이며, 경쟁 게임용 서버 권위 판정이나 부정행위 방지를 구현한 것은 아니다.

## 실행

Windows 로컬 PostgreSQL 18이 설치되어 있다면 첫 터미널에서 `pnpm server:dev`, 두 번째 터미널에서 `pnpm dev`를 실행한다. 프론트엔드는 백그라운드로 실행하지 않는다. 로컬 DB는 `data/local/postgres-server`에 새로 생성하며 기존 서비스의 데이터는 변경하지 않는다. 개발 전용 trust 인증은 127.0.0.1의 별도 포트 55432에만 적용한다.

기존 DB를 사용할 때는 `rust-server/.env.example`의 환경변수를 설정하고 저장소 루트에서 `pnpm start`를 실행한다. `.env.example`은 참고이며 자동으로 로드하지 않는다. CONNECTOME_DIR가 설정됐는데 데이터 해시나 범위가 잘못되면 서버는 시작을 거부한다. 환경변수를 생략하면 계정 API만 제공하고 신경 API는 명확한 503을 반환한다.

## API

| 경로 | 동작 |
| --- | --- |
| GET `/api/health` | PostgreSQL 연결과 Rust 프로세스 확인 |
| GET `/api/connectome` | 로드된 그래프 ID, 범위, 활성 연결, 출처·변환 가정 |
| POST `/api/auth/register`, `/login` | `{username,password}`. 아이디 3~32자, 비밀번호 10~128바이트 |
| GET `/api/auth/me` | `{user:null}` 또는 계정 ID·이름 |
| POST `/api/auth/logout` | 현재 세션의 서버 토큰 폐기 |
| GET `/api/saves` | 계정의 저장 슬롯 목록 |
| GET/PUT `/api/saves/{slot}` | 조회 또는 `{save,revision,requestId}` 저장. revision은 기대하는 현재 버전(신규 0) |
| POST `/api/brains/{creature}/step` | `{requestId,episodeId?,inputs:[12],available:[5],reward,learning,terminal}` |

비밀번호는 Argon2id, 세션은 OS 난수 256비트와 서버 SHA-256 토큰 해시를 사용한다. 운영 쿠키는 HttpOnly, Secure, SameSite=Lax다. 변경 요청은 JSON과 허용 Origin을 확인하며 API 응답은 no-store이다. 세이브 revision이 다르면 409, 같은 요청 ID에 다른 내용이 오면 409를 반환한다. 계정별 SQL 조건과 PK가 다른 계정의 세이브·뇌를 분리한다.

세이브는 계정당 128슬롯·압축 64MB, 서버 개체 상태는 512개로 제한한다. 계산은 2개 worker permit 및 계정별 잠금으로 제한하고, 대기 중인 동일 계정 요청은 429를 받는다. 초기 저비용 단일 인스턴스용 제한으로 대규모 동시접속 성능을 보장하지 않는다. 계정 복구·이메일 인증·비밀번호 변경은 이번 범위에 포함하지 않았다.

## 실제 게임과 저장 경계

로그인 상태에서 서버 회로가 로드돼 있으면 오픈월드·기존 배틀의 기술 결정은 서버 응답을 기다린 뒤 실행한다. 공격·버프·회복·상태 기술의 감각과 합법 행동 마스크를 공유한다. 오픈월드의 기술 효과 보상과 개체별 moveLearning 기록은 세이브에 포함된다. 서버 장애가 나면 월드를 일시 정지하고 원인을 알린다. 월드 이동은 기존 브라우저 128-node 모델을 사용한다.

전체 회로는 topology가 고정된 희소 recurrent 모델이다. 각 턴 활동·readout·RNG는 PostgreSQL에 압축해서 저장되며 렌더링은 서버 RNG를 소비하지 않는다. 요청 재시도는 1일 보관하는 응답 영수증으로 멱등 처리한다. 전투 episode가 바뀌면 활동·이전 행동 trace를 초기화하고 학습된 readout은 보존한다. `learning=false`에서 readout과 update count는 고정된다. 종료 보상은 terminal 요청으로 반영하며 오픈월드의 전송 대기 기록도 클라이언트 세이브에 보존한다.

IndexedDB는 `account:{userId}:{slot}`로 분리되며 게스트의 이전 키는 그대로 둔다. HTTP 저장 ACK는 같은 requestId의 동기화 기록만 갱신하므로 다른 탭의 최신 스냅샷을 덮어쓰지 않는다. 저장 충돌 시 자동 병합하지 않으므로 내보내기로 현재 진행을 보관한 후 기기를 선택한다. JSON 내보내기는 게임·브라우저 회로·기술 통계를 포함하며 PostgreSQL의 전체 회로 readout은 서버에 보존된다.

## 검증

`pnpm check:server`는 실제 API에 테스트 계정 두 개를 생성해 로그인, 격리, 세이브 충돌, 재시도, 로그아웃 폐기, 재로그인 복원과 전체 그래프 step을 검증한다. 생성 계정명은 산출물에 남으며 비밀번호와 쿠키는 기록하지 않는다. `CHOKETMON_LIVE_RUST=1`에서 `tests/ui/rust-live.spec.ts`를 실행하면 실제 브라우저 사용자 흐름을 검사한다. `tests/ui/save-race.spec.ts`는 두 탭의 늦은 ACK 경합을 검사한다.

승률 향상은 아직 확인하지 못했다. 제한 비교에서 학습 전·후 승리 수가 같았으며 일부 학습 시드가 회복·상태 기술을 과도하게 선택했다. 정확한 결과는 [배틀 비교](battle-benchmark.md)에 있다.
