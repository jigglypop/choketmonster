# 2026-09-19 실행·성능 점검

요청한 9개 항목을 기준으로 의존성, 게임 엔진, 오픈월드 시뮬레이션, 지도/HUD, 지형·재질·모델 캐시, 저장/실시간 클라이언트 및 Rust 저장 검증 경계를 점검했다. 아래의 정적 개선 후보와 실제 실행 측정은 구분한다.

## 적용한 변경

| 항목 | 변경 | 검증 기준 |
|---|---|---|
| gaesup-world 1.0.31 | 정확한 버전 고정. 공개 cameraOption에서 제거된 bounds 정리. Three r178에 없는 screenDPR 호환 어댑터 추가 | 플러그인 시작/정지/재개, TypeScript, production build, 실제 WebGPU 렌더 |
| 전투 선두 | 전투마다 nextBattleTeamIndex를 증가시키던 자동 순환 제거 | 다음 전투는 첫 사용 가능 팀원, 팀 배열·저장 순서 유지 |
| 전투 교체 | 오픈월드 HUD에 출전/HP/기절/지역 제한을 표시하는 교체 목록 | UI 선택으로 activeIndex 변경, 저장한 영구 팀 순서 동일 |
| 무한 몬스터볼 | 구매·보충·차감·재고부족 분기 제거, UI ∞ 표시 | 과거 재고 0 저장도 사용 가능. JSON/Rust 저장은 유한 정수 유지 |
| 프렌들리숍 | summary 가로쓰기 유지, 무한볼 안내 | 데스크톱/좁은 화면에서 문구와 조작 확인 |
| 상세 지도 | 확대/축소/초기화/드래그, 실제 도로 클릭 영역, 회전 역변환 | 잠금 유지, 확대·회전 후 길찾기와 실제 좌표 이동 |
| 잔디 | 기존 PBR 반복 간격 8.70m → 3.57m, 큰 색 변화는 정점에 미리 계산 | 텍스처 3채널·draw call·지형 분할 수 유지. 동일 DPR A/B 측정 |
| 마을/도로 | 성도 10개 마을 고유 색, 다른 지방도 안정적인 색, 3개 포장 무늬, 건물 색/높이 차이, 도로 폭 차이 | 마을당 기존 161개 포장 인스턴스와 건물 평면 충돌 범위 유지 |
| 도로 길이 | 성도 29·30·35·38번 도로 중간 거점 변경 | 기존 연결 관계·포털·마을 좌표 유지, 이동/진행 테스트 |
| 동굴 | 침식된 윤곽, 굴곡 암벽, 높낮이, 바위/자갈/입구 아치, 약한 접지 그림자 | 렌더와 충돌에 같은 높이 함수, 이전 저장 위치·출입구 통행, 실제 PBR 로드 |
| 지형 조회 | feature map/filter/sort 제거, 한 번만 feature 조회, nearest 탐색의 중복 거리 계산·중간 객체 축소 | 8개 지방 고정 좌표 120,000회씩의 높이/blocked 합계 동일 |

gaesup-world의 풀 타일은 별도 풀잎 geometry와 업데이트를 추가하는 기능이다. 이번 변경은 기존 지형 텍스처 타일을 개선해 그 비용을 추가하지 않았다. 단편 셰이더의 잔디 색 변화에 쓰던 삼각함수 3개도 제거했다.

`screenDPR`은 렌더러의 pixel ratio를 렌더마다 읽는 uniform으로 호환한다. 이는 [Three r185의 ScreenNode 구현](https://github.com/mrdoob/three.js/blob/r185/src/nodes/display/ScreenNode.js)의 의미와 같다. Three 전체 버전은 바꾸지 않았다. upstream의 r178 지원 수정 또는 향후 Three 업그레이드 때 어댑터와 Vite alias를 함께 제거할 수 있다.

## 추가 최적화 후보

| 우선순위 | 코드/관찰 | 다음 작업과 성공 기준 |
|---|---|---|
| 높음 | 초기 JS 약 9.37MB, gzip 약 2.18MB. pokemon/encounters/versions 생성 데이터가 정적 import됨 | 지방별 데이터 로드를 분리하고 첫 조작 가능 시간·총 전송량을 비교. 단순 manualChunks는 정적 의존성을 계속 다운로드하므로 충분하지 않음 |
| 중간 | storage.ts가 저장마다 JSON 직렬화·복사, 복원에서 그래프 canonicalization과 개체별 graph 복사 | 대형 박스 저장 fixture로 main-thread 시간을 먼저 분리 측정. 계정 전환·revision 충돌·tradeEpoch 보존을 통과한 뒤 변경 |
| 중간 | panel.ts/main.ts/engine.ts/simulation.ts가 큰 모듈, UI refresh와 엔진 상태 변화가 밀접 | 기능별 view 갱신 경계를 분리하되 실제 느린 조작을 profile한 뒤 적용. 행 수 감소 자체를 속도 향상으로 보고하지 않음 |
| 중간 | 지형 조회는 정렬을 제거했어도 위치/구간/마을 선형 탐색이 남음 | sampler CPU profile에서 지배적인 경우 공간 인덱스 도입. 동률/경계의 기존 선택 결과를 유지해야 함 |
| 유지 | 모델 캐시, 거리/시야 LOD, terrain 공유 material, 물 LOD, 정적 shadow map, 제한된 실시간 전송 이미 존재 | 검증 없이 해상도·시야거리·모델 수를 낮추지 않음 |

거리 비교를 제곱 거리로 바꾸는 실험은 경계 동률에서 3개 지방의 결과가 달라져 채택하지 않았다. 최종 구현은 기존 Math.hypot 비교를 유지하면서 할당과 중복 계산만 줄였다.

## 재현

프론트엔드는 터미널에서 `pnpm dev --port 5173 --strictPort`로 실행한다. GPU 검사는 다른 브라우저 테스트와 겹치지 않게 순서대로 실행하고, Playwright output 경로를 구분한다.

- 플러그인: `pnpm exec tsx scripts/probe-gaesup.mjs`
- 타입/번들: `pnpm run build`
- 지형 CPU: `pnpm exec tsx scripts/measure-terrain-sampling.ts candidate`
- 잔디 A/B: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compare-grass-render.ps1`
- 마을: `pnpm exec playwright test tests/ui/town-identity.spec.ts --config playwright.webgpu.config.ts --output artifacts/ui-town-identity-results`
- 게임 조작: `pnpm exec playwright test tests/ui/kanto.spec.ts -g "open-world shop|open-world battle switches" --output artifacts/ui-gameplay-20260919-results`
- 동굴: `pnpm exec playwright test tests/ui/caves-runtime.spec.ts --output artifacts/ui-cave-20260919-results`

A/B 스크립트는 material 파일만 기존 커밋 내용으로 잠시 교체하고, 실패하더라도 finally에서 현재 작업 내용을 복원한다. 나머지 장면/시드/기기/DPR은 동일하다. 측정은 이 PC의 해당 장면에 대한 결과이며 모든 기기의 FPS 보장이 아니다.

계정 API를 stub한 브라우저 조작 검사는 UI와 엔진 연결 증거다. 실제 서버 인증·저장 검증 및 배포 버전 확인과 구분한다.
