# Pokémon 신경 경로 실행 근거

이 문서는 `pokemon-recurrent-v1`이 [MaleCNS v1.0 부분회로](./connectome-source.md)의 실제 공개 node와 edge를 행동 계산에 사용하는지 확인한 제한된 기술 검증이다. battle 승률, 학습 성능 또는 생물학적 학습을 평가한 보고서가 아니다.

## 실행 방법

```powershell
npx tsx scripts/evaluate-pokemon-brain.ts --out artifacts/pokemon-brain-evidence.json
npm test -- --run tests/game-connectome.test.ts
```

2026-09-10 실행 대상은 `malecns-v1.0-dna02-neighborhood-128`로, 128 nodes와 3,623 measured edges를 포함한다. 실험은 16개 brain checkpoint, checkpoint마다 48개 scripted observation, 151개 종별 instance의 한 step 실행으로 제한했다.

관찰 12개는 bias, 양쪽 HP 비율, level 차이, speed 차이, turn 진행도, 양쪽 status flag, 네 move의 PP 비율이다. type과 type effectiveness는 감각에 들어가지 않는다. 이 감각 투영과 tanh dynamics, 네 번의 recurrent microstep, four moves plus wait readout은 모두 게임 설계다. `sensoryBypass=false`이므로 readout의 감각 직접 우회값은 0이고 recurrent node activity를 통해서만 observation의 영향이 전달된다.

## 회로 절제 비교

각 seed에서 만든 같은 초기 checkpoint를 두 번 복원했다. 한쪽은 원본 graph를 사용하고, 다른 쪽은 node, input projection, readout을 그대로 둔 채 3,623개 edge weight만 모두 0으로 만들었다. 두 정책은 같은 observation sequence를 같은 순서로 받았고 `learning=false`, `epsilon=0`, recurrent microstep 4로 실행했다.

| 측정값 | 결과 |
| --- | ---: |
| 비교한 action 쌍 | 768 |
| 서로 다른 action | 102 |
| action 차이가 한 번 이상 난 checkpoint | 15 / 16 |
| 평균 node activity L1 차이 | 0.0966275729 |
| 최대 node activity L1 차이 | 0.1314434850 |

edge를 0으로 만들었을 때 activity와 action이 달라졌으므로, 이 실행에서 connectome edge는 숨겨진 control API가 아니라 `Brain`의 recurrent sum을 거쳐 action 선택에 기여했다. 이 절제는 어느 edge나 세포형이 특정 기술을 담당한다는 뜻은 아니다. 부호와 normalization 가정은 source 문서에 기록되어 있다.

## 상태와 재현성

- 평가 48 step 전후로 readout의 직렬화 값과 `updates`가 모두 같았다. 평가 중 학습 weight는 바뀌지 않았다.
- 하나의 snapshot에서 복원한 두 실행에 같은 48개 observation과 exploration rate를 주었을 때 action sequence, 마지막 전체 snapshot, RNG state가 byte-level JSON 비교에서 같았다.
- 151종에 서로 다른 `instanceId`를 주어 brain을 만들고 한 step씩 실행했다. 151개 seed가 모두 달랐고 모든 activity가 finite였다.
- 첫 instance를 한 번 더 실행해도 두 번째 instance의 저장된 brain snapshot은 바뀌지 않았다. 개체가 recurrent activity, readout, RNG와 update count를 따로 소유한다.

## 해석 한계

scripted observation은 battle engine의 승패와 damage 처리를 실행하지 않는다. 따라서 이 결과로 random, frozen, trained 정책의 battle 승률을 비교하거나 learning efficacy를 주장할 수 없다. 학습 전후 비교가 필요하면 동일한 battle seed와 상대 조건에서 random·초기 frozen·trained를 분리하고, 평가 중 weight 고정을 다시 확인해야 한다. 보상 증가나 행동 변화만으로 biological learning을 주장할 수도 없다. 실제 MaleCNS에서 가져온 것은 선택 node와 그 사이의 measured connection count이며, Pokémon 감각 encoding, dynamics, readout, reward와 learning rule은 직접 설계한 구성이다.
