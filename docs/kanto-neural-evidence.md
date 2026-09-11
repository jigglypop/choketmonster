# 관동 오픈월드 신경 정책 비교 증거

## 최신 관동 v2 실행

벽·배지 관문·파트너 좌표 동기화·보상·경험치 공유 통합 후 증거는 `artifacts/kanto-evidence-2026-09-11T12-12-45-955Z/`에 있다. 같은 두 평가 시드, 조건당 120틱과 학습 꺼짐을 사용했다. 아래의 이전 v1 기록과 지형·열매 위치가 달라 점수를 직접 비교하지 않는다.

| 조건 | 이동 보상 평균 | 충돌 | 조우 | 완료 전투 |
| --- | ---: | ---: | ---: | ---: |
| 무작위 | -21.2832 | 177.5 | 2.5 | 2.5 |
| 학습 전 | -49.3909 | 257.5 | 2 | 2 |
| 공개 이동 정책 | 44.1301 | 52.5 | 6 | 6 |
| 연결 가중치 제거 | 40.1134 | 38.5 | 6.5 | 6 |

모든 조건의 시작 위치 동일, 평가 가중치·업데이트 불변, 개체 상태 격리, 실제 recurrent 활성, 연결 제거 시 활성·행동 추적 변화, 저장 후 정확한 리플레이, 문자열 뉴런 ID와 입력 파일 불변을 통과했다. 연결 제거가 충돌과 조우에서 더 나은 값도 보였으므로 실제 회로의 일반적 성능 우위를 주장하지 않는다. 전투의 상성·승패·성장 보상 비교는 [별도 통합 실험](./kanto-rewards.md)에 있다.

`scripts/check-kanto-tracking.ts`의 시드 41005·41015·41025에서는 선택한 서로 다른 야생 개체를 커넥톰 이동 정책으로 따라가 그 ID와 배틀했고 파트너 충돌은 모두 0회였다. 모든 지형에서 최단 경로를 보장하는 경로 탐색기는 아니다.

## 이전 지도에서의 기록

이 문서는 관동 지도 변경 뒤 정책을 평가하고 후보를 채택한 과정을 나눠 기록한다. `artifacts/kanto-evidence-2026-09-11T10-50-54-945Z/`는 당시 공개 정책 SHA-256 `701364e3…`를 평가한 과거 baseline이다. 이후 관동 후보 `9afa7181…`가 공개 정책으로 채택됐으며, 현재 상태 재검증은 `artifacts/kanto-evidence-2026-09-11T11-11-28-109Z/`에 별도로 저장했다. 다음 명령은 매번 새 시각 폴더를 만들어 이전 결과를 덮어쓰지 않는다.

```powershell
npx tsx scripts/verify-kanto.ts
```

## 과거 baseline 비교 조건

모든 조건은 새 held-out seed `9311027`, `9311129`, seed당 120틱, 틱당 0.25초, 같은 관동 지도와 같은 시작 상태를 썼다. `learning:false`를 고정했으며 개체 readout update 수가 실행 내내 0인지 검사했다.

| 조건 | 입력·readout과 회로 | 탐색 |
| --- | --- | --- |
| random | 공개 정책, 원본 부분 회로 | `epsilon=1` |
| initial readout | 기존 정책 학습에 사용한 seed `7711003`의 학습 전 입력 투영과 readout을 재구성, 원본 부분 회로 | `epsilon=0` |
| deployed readout | `public/data/openworld-policy.json`을 변경 없이 사용, 원본 부분 회로 | `epsilon=0` |
| edge-zero ablation | 공개 정책을 사용하되 실행 중 모든 recurrent edge weight만 0으로 설정 | `epsilon=0` |

모든 실행은 `setAutoCapture(true)`를 사용한다. 승리 뒤 포획에 실패해 `captureOffer`가 남으면 다음 step 전에 `releaseVictory()`를 호출하는 동일한 결정 규칙을 적용한다. 이번 두 seed에서는 남은 offer가 없어 이 fallback 호출 수는 모두 0이었다.

## 과거 baseline 결과

아래 값은 두 seed의 산술평균이다. reward와 충돌·열매는 120틱 동안 발생한 event를 누적했다. 표본이 두 seed뿐이므로 기술 통계로만 읽어야 한다.

| 조건 | reward | 열매 | 충돌 | 조우 | 완료 전투 | 포획 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| random | -21.0363 | 0 | 60.5 | 1.5 | 1.5 | 1.5 |
| initial readout | -45.6575 | 0 | 206.5 | 2.0 | 2.0 | 1.0 |
| deployed readout | -158.5312 | 1.0 | 790.0 | 1.5 | 1.5 | 0.5 |
| edge-zero ablation | -210.3827 | 0 | 1020.0 | 0 | 0 | 0 |

기존 배포 readout은 edge-zero보다 reward가 높고 충돌이 적었으며 실제 조우도 만들었다. 따라서 이 실행에서는 recurrent edge가 상태와 행동 trace에 관여했다. 그러나 기존 배포 readout은 random과 학습 전 readout보다 reward가 크게 낮고 충돌이 많았다. 기존 정책이 바뀐 관동 환경에서도 잘 작동한다는 근거는 되지 않는다. 네 조건 모두 열매 획득은 매우 적거나 없어서 이 길이의 실험으로 탐색 능력을 긍정적으로 평가할 수도 없다.

## 과거 baseline 회로와 재현 검사

사용한 회로는 `connectome-subset`인 `malecns-v1.0-dna02-neighborhood-128`이며 문자열 node ID 128개와 측정 연결에서 변환한 edge 3,623개를 가진다. `public/data/connectome.json`의 SHA-256은 `2131193c48d6a41fc9977c035a8aa73d44663c2c8b1c619e41e040a366cff4d3`, 당시 공개 정책 파일의 SHA-256은 `701364e3835f2d4ef15a346fba20b53f2dddf054d8dd2bb95cf3896f353d3d7d`였다. 이 정책은 현재 `public/data/openworld-policy-legacy.json`에 보존되어 있다. 원본 MaleCNS edge 파일의 기록된 SHA-256은 `e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1`이다. 데이터셋, CC-BY 4.0 라이선스, 선택·제외 조건과 변환 가정은 [connectome-source.md](./connectome-source.md)에 기록되어 있다.

검증 스크립트는 다음 조건을 assertion으로 확인했다.

- seed별 네 조건의 지도·플레이어·먹이·개체 시작 상태 hash가 같다.
- 평가 전 과정에서 `learning:false`, readout 불변, update 수 0이다.
- 개체별 Brain, activity 배열, readout 배열은 서로 다른 객체이며 최종 activity 상태도 한 종류로 합쳐지지 않는다.
- 원본 회로에서 recurrent activity와 readout에 대한 recurrent contribution이 0이 아니다. 관측한 최대 절댓값 contribution은 seed별 `0.05619`, `0.06315`였다.
- 원본 edge와 edge-zero 조건의 activity hash와 전체 trace hash가 두 seed 모두 다르다.
- 저장 checkpoint에서 두 번 복원한 뒤 24틱 event·snapshot hash가 완전히 같고 최종 직렬화 checkpoint도 같다.
- 실행 전후 원본 connectome과 공개 policy 파일 바이트가 같다.

재현 checkpoint SHA-256은 `c05235b6437e2ade8c74db4a250f487bb7c7c9ef26e8185e1f69c1905a7fc64d`, replay trace SHA-256은 `bdd12770624a6cf39d2443082d23db32fe48f7a1f7aefe23881cce554d1e27f7`이다. 해당 폴더의 `checkpoint.json`, `replay-trace.json`, `report.json`에 원자료가 있다.

이 결과는 게임 구현의 제한된 비교 증거다. MaleCNS 부분 회로는 recurrent topology와 weight를 제공하지만 감각 투영, 신경 동역학, 행동 mapping, reward, 학습 규칙, 전투 fallback과 포획 처리는 직접 설계했다. 수치 차이는 생물학적 학습이나 초파리의 관동 환경 이해를 뜻하지 않는다.

## 관동 자동사냥 후보 정책

기존 배포 정책이 관동 지도에서 건물과 지형에 자주 막히는 결과를 보였으므로 `scripts/train-kanto-policy.ts`로 기존 정책에서 이어서 제한 학습한 후보를 만들었다. 후보 생성 당시에는 공개 정책을 바꾸지 않았고 결과를 `artifacts/kanto-policy-candidate-2026-09-11T10-56-50-623Z/`에 먼저 저장했다. 이후 회귀 검사와 브라우저 검사를 거쳐 이 후보가 현재 `public/data/openworld-policy.json`으로 채택됐고, 이전 정책은 `public/data/openworld-policy-legacy.json`으로 이동했다.

```powershell
npx tsx scripts/train-kanto-policy.ts
```

훈련 seed는 평가와 겹치지 않는 `7319003`, `7319107`이며 각각 1,250틱, 총 2,500틱이다. `learning:true`, `epsilon=0.12`, 자동사냥과 자동포획을 사용했다. 장기 실행에서 팀 전멸과 포획 결정 대기로 멈추지 않도록 전투가 끝날 때마다 `heal()`을 적용하고, 포획구 소진 등으로 `captureOffer`가 남으면 다음 step 전에 `releaseVictory()`를 호출했다. 이는 학습을 계속하기 위한 게임용 실험 규칙이다.

후보 평가는 새 held-out seed `9411007`, `9411109`에서 조건당 240틱을 실행했다. 기존 정책과 후보 모두 `learning:false`, `epsilon=0`이며 같은 시작 상태, 전투 후 heal, 포획 결정 규칙을 사용했다.

| 정책 | reward 평균 | 충돌 평균 | 열매 평균 | 조우 평균 | 완료 전투 평균 | 승리 평균 | 포획 평균 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 기존 배포 | -508.5074 | 2504.5 | 2.0 | 2.0 | 2.0 | 2.0 | 1.0 |
| 관동 후보 | -66.6483 | 417.5 | 2.5 | 12.5 | 12.0 | 12.0 | 2.0 |

후보는 두 seed 모두 기존보다 충돌이 적고 실제 조우를 유지했다. seed `9411007`에서는 충돌 265회, 조우 19회, 승리 18회였고 seed `9411109`에서는 충돌 570회, 조우 6회, 승리 6회였다. 당시에는 실제 화면에서 이동 경로와 건물 주변 정체를 더 검토할 후보로 판정했고, 이후 자동사냥 회귀와 브라우저 검사를 거쳐 채택했다. 이 두 seed만으로 일반 성능이 확정된 것은 아니다.

후보 파일 `candidate-policy.json`의 SHA-256은 `9afa7181d0ffff057f6ea8a7de5e5750f25f6b339d83f97bca1b208dbbd313e0`이다. 평가 중 readout update는 0이었고, 기존·후보의 시작 상태가 seed별로 일치했으며, 후보 checkpoint 복원 뒤 30틱 trace와 최종 checkpoint가 정확히 재현됐다. checkpoint SHA-256은 `090ebcbf3cf39c5c74308da0202e14a7125d5fa0ca211aa5a30ae5674deb81a0`, trace SHA-256은 `ed807101468fc8a4f95c81efee919ebeb265744a0c8ae053bf3e5fd13c83acba`다. 실행 전후 `public/data/connectome.json`과 `public/data/openworld-policy.json` 바이트도 같았다.

후보의 reward와 자동사냥 결과 향상은 설계한 Q-learning과 복구 규칙 아래의 게임 성능이다. 생물학적 학습의 증거가 아니다.

## 현재 채택 정책 재검증

현재 공개 정책 SHA-256은 후보와 같은 `9afa7181d0ffff057f6ea8a7de5e5750f25f6b339d83f97bca1b208dbbd313e0`이다. `scripts/verify-kanto.ts`를 현재 파일에 다시 실행한 결과는 `artifacts/kanto-evidence-2026-09-11T11-11-28-109Z/`에 있다. 두 held-out seed `9311027`, `9311129`에서 조건당 120틱, `learning:false`, 같은 시작 상태를 사용했다.

| 조건 | reward 평균 | 열매 | 충돌 | 조우 | 완료 전투 | 신규 caught 도감 항목 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| random | -21.0363 | 0 | 60.5 | 1.5 | 1.5 | 1.5 |
| initial readout | -45.6575 | 0 | 206.5 | 2.0 | 2.0 | 1.0 |
| 현재 채택 readout | -49.8259 | 1.0 | 295.5 | 5.0 | 4.5 | 1.5 |
| edge-zero ablation | -16.9888 | 1.0 | 127.5 | 6.0 | 5.0 | 2.0 |

현재 정책은 두 seed에서 각각 조우 4/6회, 완료 전투 4/5회, 승리 2/3회, 패배 2/2회를 기록했다. 자동사냥이 실제로 실행됐지만 random과 edge-zero보다 reward가 낮고 충돌이 많았다. edge를 0으로 만든 조건도 이 짧은 평가에서 더 나았으므로 후보 훈련 당시의 기존 정책 대비 향상을 회로 기여의 우수성이나 일반 성능 향상으로 확대 해석할 수 없다. 다만 원본 edge와 edge-zero의 activity 및 trace hash는 두 seed에서 모두 달라 recurrent 회로가 계산에 관여한다는 실행 증거는 유지된다.

평가 중 모든 readout과 update 수는 불변이고 개체별 Brain 객체는 격리됐다. recurrent readout contribution 최대 절댓값은 두 seed에서 `0.05467`, `0.06097`이었다. 입력 connectome과 정책 파일은 실행 전후 바이트가 같았다. 재현 checkpoint SHA-256은 `d38c3dc3f34fcf6085d7d1b9b3e4821056e7092e98bfc4f1f834956fc0ff67bb`, 24틱 trace SHA-256은 `f8d3b9709df7b1351dd2b4de63be659565d2e17ab7f1dad91f7b14671f3d007f`이며 두 복원의 trace와 최종 checkpoint가 정확히 일치했다.

## 회복 없는 장기 자동사냥 점검

현재 정책을 seed `6012044`, `9411007`, `9411109`에서 각각 400틱(100초) 실행했다. `learning:false`, `epsilon=0`, 자동포획을 사용했고 HP를 인위적으로 회복하지 않았다. 포획구가 소진된 뒤 남은 승리 후 선택지는 다음 진행을 위해 놓아주기로 처리했다. 원시 결과는 같은 현재 증거 폴더의 `noheal-live.json`에 저장했다.

| seed | 조우 | 승리 | 패배 | 종료 시 최초 파트너 HP | 놓아주기 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 6012044 | 15 | 11 | 4 | 0 | 3 |
| 9411007 | 19 | 14 | 4 | 20 | 6 |
| 9411109 | 20 | 17 | 3 | 0 | 9 |

세 실행 모두 자동 조우와 승리를 반복했고 평가 중 뇌 update는 0이었다. 두 seed에서 최초 파트너 HP가 0이 됐지만 포획한 팀원이 이어 싸워 진행했다. 한 실행은 400틱 종료 시 전투 중이었다. 따라서 현재 정책은 회복 없이도 제한 시간 동안 사냥을 계속할 수 있으나, 팀 소모와 포획구 소진 뒤 선택 처리가 장기 지속성의 실제 한계다. 표의 `신규 caught 도감 항목`은 서로 다른 종의 도감 증가량이며 포획한 개체 총수와 같지 않다.
