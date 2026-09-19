# 2026-09-19 로딩 변경과 전체 성능 점검

프론트 초기 의존성, React/Three 프레임 루프, 월드 시뮬레이션과 길찾기, 저장/복원, 실시간 클라이언트, Rust 저장/실시간 서버의 주요 실행 경로를 점검했다. 모든 코드를 실서버 부하 시험한 결과는 아니다. 기존 작업 트리의 변경은 보존했고, 앞선 [실행·성능 점검](optimization-review-2026-09-19.md)에 이미 반영된 개선과 이번에 확인한 비용을 구분한다.

## 우선순위와 근거

| 우선순위 | 확인한 비용 | 근거와 권장 후속 작업 |
|---|---|---|
| 높음 | 정적 초기 JS가 큼 | 점검 시작 시 기존 `dist/assets/index-D-qbeSNH.js`는 9,369,454 bytes, `gzipSync` 결과 2,175,565 bytes였다. `src/main.ts`의 정적 import가 전체 포켓몬/버전/지역 데이터 및 3D 진입점까지 연결한다. 초기 로딩 이미지가 JS 다운로드 이전부터 보이도록 HTML에서 표시하고, 실제 기능/지방 진입 시점의 동적 로드로 나누는 것이 다음 단계다. 파일만 여러 chunk로 분할해도 정적 의존성이면 첫 다운로드량은 유지된다. 이 수치는 로딩 변경 후 최종 번들 수치가 아니다. |
| 높음·일부 수정 | 장거리 길찾기의 중복 조회와 반복 실행 | `src/openworld/navigation.ts`의 `walkable`에 검색 1회 동안만 유지되는 격자 캐시를 추가했다. 연두마을→금빛시티 sample 호출 232,648→17,074회, 중앙값 358.67→57.31ms이고 전체 경로 좌표는 동일했다. `src/openworld/target-route.tsx:10`은 여전히 플레이어 또는 목표의 0.5m 좌표가 달라지면 경로를 다시 계산하므로 이동용 경로와 표시용 경로 재사용은 후속 후보로 남긴다. |
| 중간 | 개체 수에 따라 저장/복원 CPU가 증가 | `src/game/storage.ts:20`의 JSON 왕복 복사, `:35`의 개체별 그래프 복사, `:62`의 월드 복원 검증이 있다. `src/game/engine.ts:1446`은 검증만을 위해 `Brain.restore` 결과를 생성했다가 버린다. `src/core/brain.ts`의 restore는 생성자에서 임의 가중치/그래프를 먼저 만든 뒤 저장 상태를 다시 복사한다. 100마리 fixture에서 pack 중앙값 52.75ms, unpack 745.21ms. 이번에는 저장 형식과 검증 경로를 변경하지 않았다. |
| 중간 | Rust 저장 CPU 작업이 async worker와 계정 잠금 구간에서 실행됨 | `rust-server/src/api.rs:649`의 gzip 해제/JSON 해석, `:676`의 저장 검증, `:713`의 직렬화·SHA-256, `:731`의 복제·재직렬화·gzip가 동기 실행된다. 뒤의 일부 작업은 `:678` 계정 잠금을 획득한 뒤 수행된다. 크기별 동시 저장 지연을 측정하고 CPU 작업 분리 및 잠금 범위 축소를 검토해야 한다. 실제 운영 지연/처리량은 이번 점검에서 측정하지 않았다. |
| 중간 | 같은 실시간 패치를 수신자마다 JSON 직렬화 | `rust-server/src/realtime.rs:1054`의 `try_send`가 매번 `serde_json::to_string`을 호출하고 `:1059`의 broadcast는 수신자마다 이를 반복한다. 한 번 직렬화한 불변 WebSocket 메시지를 복제해 전송할 수 있다. 방 인원에 따른 CPU 절감량은 부하 시험 전까지 미확정이다. |
| 낮음 | 추론 시 불필요한 readout 재평가 | `src/core/brain.ts`의 `Brain.act`는 학습이 없어도 동일한 readout을 두 번 평가했다. 이번에 실제 갱신 가능한 경우에만 두 번째 평가를 수행하도록 수정했다. 아래 전체 상태 동등성 검사와 기존 회귀검사를 통과했다. 전체 실행 시간 개선은 측정 오차 범위였다. |

## 이번에 적용한 수정

`Brain.act`는 첫 readout 평가를 재사용한다. `learning=true`, `reward !== null`, 이전 결정인 `state.previous !== null`을 모두 만족할 때만 기존 순서대로 학습한 뒤 다시 평가한다. 학습이 가능한 경우의 bootstrap 계산, 가중치 갱신, RNG 소비, action 선택 순서는 그대로다. `Brain.restore`, 저장 구조, 모델/시야거리/해상도는 이 수정에서 변경하지 않았다.

`tests/core.test.ts`에 학습 꺼짐, reward 없음, 이전 결정 없음의 각 경우를 추가했다. action뿐 아니라 RNG, activity, readout, previous 등을 포함한 전체 snapshot이 비학습 참조와 동일한지 검사한다.

`findWorldPath`에는 호출 내부의 `Map<string, boolean>`을 추가해 인접 칸과 대각선 모서리 검사에서 동일 격자의 blocked 여부를 한 번만 조회한다. 우선순위 큐, 동률 선택, 거리 계산, 경로 복원, 막힌 목적지 대체 순서는 변경하지 않았다. 캐시는 함수가 끝나면 버리므로 다음 검색의 지형·통행 상태 변경을 관찰한다. `tests/navigation.test.ts`에는 대각선 모서리를 건너뛰지 않는 우회 경로와 다음 검색에서 장애물 해제를 반영하는 검사를 추가했다.

## 실제 로컬 CPU 측정

Node 24.15.0, 현재 `public/data/connectome.json`의 128개 노드/3,623개 edge를 사용했다. 브라우저의 렌더링 및 네트워크를 제외한 함수 실행 시간이다. 다른 기기, 실제 서버 지연 또는 제품 FPS로 일반화하지 않는다.

### 저장/복원

`createGame(152, 'audit-perf')`의 스타터에 `new Brain(123, graph)` 상태와 `sensoryBypass=false`를 넣고, 독립 복사와 서로 다른 `mon-*` ID로 1/30/100개체를 만들었다. `nextInstanceId`도 조정했다. `defaultView()`를 사용해 openWorld 복원 비용은 제외했다. `packSave` 및 `unpackSave(save, graph)`를 각각 2회 준비 실행한 뒤 pack 10회, unpack 5회를 측정했다. 각 fixture는 실제 unpack 검증을 통과했다.

| 개체 수 | JSON 문자열 길이 | pack 중앙값 | unpack 중앙값 |
|---:|---:|---:|---:|
| 1 | 333,202 | 2.42ms | 19.75ms |
| 30 | 1,708,026 | 16.48ms | 226.73ms |
| 100 | 5,026,588 | 52.75ms | 745.21ms |

문자열 길이는 `JSON.stringify(save).length`이므로 UTF-8 전송 byte 수와 동일한 값은 아니다. 100마리 pack의 최대값은 148.80ms였다. 별도로 16개체 월드를 250ms 단위로 진행한 40회 실행의 step 중앙값은 2.58ms, 최대값은 44.01ms, snapshot 30회의 중앙값은 0.17ms였다. 이는 해당 seed/초기 경로의 제한된 표본이며 전체 월드의 최대 지연을 뜻하지 않는다.

### 길찾기

`getWorldAtlas('johto')`의 `new-bark` 중심에서 각 마을 중심까지 `findWorldPath(start, target, atlas.sample)`을 3회 호출했다. 조회 횟수는 sample 래퍼로 셌다. 배지별 통행 검사 wrapper와 React/geometry 생성 비용은 제외한 지형 경로 검사다. 첫 실행도 포함하며 3회만의 소규모 표본이다.

| 목적지 | 경로 점 | sample 호출 전→후 | 중앙값 전→후 | 개선 후 최소–최대 |
|---|---:|---:|---:|---:|
| cherrygrove | 80 | 17,357→1,359 | 39.19→16.52ms | 13.92–17.76ms |
| violet | 167 | 61,880→4,716 | 95.25→19.69ms | 19.18–26.82ms |
| goldenrod | 333 | 232,648→17,074 | 358.67→57.31ms | 54.54–66.51ms |

개선 전 전체 경로 배열을 보관한 뒤 개선 후 배열과 모든 좌표를 순서대로 비교했으며 세 경로 모두 완전히 일치했다. sample 호출은 약 92% 감소했다. 가장 긴 경로의 중앙 실행 시간은 이 표본에서 약 84% 감소했지만 여전히 동기 실행이므로 반복 호출 자체를 줄일 여지가 있다.

이동 경로는 `src/openworld/view.tsx`의 destination effect에서도 별도 계산한다. 표시용 `TargetRoute`의 반복 탐색과 초기 중복 탐색 재사용은 이번 변경에 포함하지 않았다. 여러 호출에 걸친 캐시를 후속 적용할 경우 지방·동굴·배지 변경 시 반드시 무효화해야 한다.

### Brain.act 변경 전후

실제 커넥톰에서 72회 act 시퀀스를 실행했다. seed 731, 매 9회 episode reset, 학습/비학습과 null/양수/음수 reward, epsilon .17, recurrentSteps 1/4를 섞었다. 모든 action과 전체 snapshot을 차례로 SHA-256에 넣은 결과가 변경 전후 일치했다.

```text
9cfef9d0c316f51131a147456e6d9f07d1151a96754902c1ef102d6b80d9a864
```

고정 sensory 입력, recurrentSteps 4, act 4,000회로 1회 준비 실행 후 7회 중앙값을 비교했다. 비학습은 197.65→196.96ms, 학습은 205.31→208.14ms였다. 중복 readout 계산은 제거됐지만 이 표본에서 전체 추론 속도의 유의미한 개선은 확인하지 못했다. recurrent 계산이 같은 상태로 남기 때문에 작은 최적화로 보고한다.

## 렌더·시뮬레이션·통신 점검

- **이미 적용된 개선:** 지형 feature map/filter/sort 제거와 중복 조회 축소, 잔디 셰이더 삼각함수 제거, 정적 shadow, terrain material 공유, 거리/시야 LOD와 물 LOD. 세부 변경과 동등성 범위는 기존 점검 문서를 따른다.
- **모델:** `src/three/model-cache.ts`는 참조 수, 24개 캐시 기준, 동시 3개 로드, 실패 cooldown, 큐와 disposal을 이미 갖췄다. 캐시를 추가로 중복 구현할 근거는 없었다.
- **React/Three:** `src/openworld/view.tsx`의 SnapshotStore는 snapshot 비교 뒤 구독자를 갱신한다. 프레임마다 무조건 React state를 바꾸는 구조는 아니다. 시야/frustum 갱신은 0.16초 이상 간격과 카메라 변화 조건이 있다. 반면 `Creature`는 위치가 멈춰도 프레임마다 terrainSurfaceHeight를 다시 호출하고, 모델 grounding은 애니메이션 정점/뼈 변환을 매 프레임 처리한다. 화면상 발 접지와 애니메이션 정확성에 영향을 주므로 profile 후 위치/포즈 변화에 따른 캐시를 검토한다.
- **HUD:** 월드 tick은 250ms, snapshot poll은 100ms다. `panel.ts`의 html/text cache는 내용이 같을 때 DOM 쓰기를 생략한다. 다만 refresh마다 상점 문구·버튼 핸들러·지역 도감 Set 등을 재생성한다. 대형 파일이라는 이유만으로 성능 결함이라고 판단하지 않으며 현재 실제 조작 지연의 지배 요인이라는 측정은 없다.
- **게임 진행:** tick 중복 실행 방지, hidden/dialog/paused/model readiness gate가 이미 있다. 신경 시뮬레이션은 렌더 프레임마다 실행하지 않는다. 입력·회복·학습·저장까지 포괄하는 구조 변경은 이번 작은 추론 수정과 분리한다.
- **저장/네트워크:** 1초 debounce, 서버 revision/tradeEpoch 보존, 충돌 복사, IndexedDB 트랜잭션이 이미 있다. 명시적 저장의 render suspension은 1초 제한이다. 저장 CPU 개선은 계정 전환·다른 기기 충돌·거래 복구를 함께 검증해야 한다.
- **실시간:** 클라이언트는 100ms 전송 간격, 변화가 없으면 전송 생략, bufferedAmount 제한, background 연결 종료가 있다. Rust는 유한 outbound queue, 방/연결 수 제한, dirty patch를 사용한다. 전송 빈도를 무작정 낮출 근거는 없었고 broadcast 직렬화 중복은 별도 후보로 남겼다.
- **Rust:** 인증 hash 및 로컬 신경 작업은 spawn_blocking 사용을 확인했다. 저장 경로의 CPU 분리 여부는 위의 남은 후보다. DB 인덱스와 SQL을 읽었으나 실데이터 EXPLAIN/동시 부하 시험을 수행하지 않았으므로 DB 병목이나 서버 처리량 개선은 주장하지 않는다.

## 검증 경계

이번 Brain 수정 관련 검사는 4개 파일/21개, 길찾기 관련 검사는 4개 파일/17개가 통과했다.

```powershell
pnpm exec vitest run tests/core.test.ts tests/connectome.test.ts tests/connectome-controller.test.ts tests/game-connectome.test.ts
pnpm exec vitest run tests/navigation.test.ts tests/kanto-navigation.test.ts tests/camera-navigation.test.ts tests/next-destination.test.ts
git diff --check -- src/core/brain.ts src/openworld/navigation.ts tests/core.test.ts tests/navigation.test.ts docs/performance-audit-loading-2026-09-19.md
```

## 이미지와 실제 준비 단계 표시

- 초기 HTML에서 원본 `chocketmon.png`를 높은 우선순위로 불러온다. 약 3.38kB의 부트스트랩과 2.85kB의 전용 CSS가 먼저 로딩 화면을 표시하며, 큰 게임 모듈을 가져오는 동안에도 그림과 로딩 바가 보인다. 이는 첫 화면 개선이며 게임 본체 9.37MB(gzip 2.18MB)의 전송량을 없앤 것은 아니다.
- Male CNS 진행률은 부분 회로, 서버 상태, 이동 정책 3개의 총 5개 준비 작업 완료 수다. 독립 요청을 병렬화하고 `/api/connectome`의 중복 요청을 하나로 합쳤다. 필수 데이터 요청에는 20초 제한, 서버 상태에는 기존 5초 제한을 둔다.
- 3D 진행률은 런타임·그래픽 장치·첫 장면·필수 모델의 완료 단계다. 다운로드 바이트 비율이나 예상 남은 시간이 아니다. 파트너/전투 모델이 실제로 준비되기 전에는 로딩 화면을 닫지 않는다.
- 최초 시작, 저장된 모험 복원, 월드 재진입에서 같은 이미지를 사용한다. 회로 실패, 3D 초기화 실패, 모델 실패에는 재시도 버튼을 제공한다. 모델 재시도는 현재 모험을 유지한다.

`tests/ui/loading-screen.spec.ts`의 브라우저 시나리오 4개가 통과했다. 모바일에서 게임 모듈을 보류한 상태의 이미지, 데스크톱에서 서버 상태를 보류한 80% 진행률/단일 요청, 회로 503 응답 후 새로고침 재시도, 실제 152번 GLB의 503/보류/재시도/준비 완료와 기기 저장 후 복원을 확인했다. UI 검사의 계정/서버 상태 API는 stub이며 GLB·장면은 실제 파일을 사용한다. 운영 연결 검증과 구분한다.

근거 이미지는 `artifacts/loading-mobile.png`, `artifacts/loading-desktop.png`, `artifacts/loading-world.png`다. 실행은 `pnpm dev --port 5181 --strictPort` 터미널 서버와 `CHOKETMON_TEST_PORT=5181`을 사용했다. 최종 배포 결과는 GitHub Actions 완료와 운영 `/version.json`, API health 및 운영 브라우저 진입으로 별도 확인한다.

?? ?? ????: 78? ?? / 432? ?? ??(`artifacts/loading-release-unit.log`), TypeScript ? ???? ?? ??. ? ?? ?? ??? ?? ??.
