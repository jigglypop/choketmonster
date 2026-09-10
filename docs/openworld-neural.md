# 오픈월드 자율 행동과 커넥톰 경로

`OpenWorldSimulation`은 좌표 `x,z = [-120, 120]`인 연속 월드에서 야생 포켓몬 12~18개체와 플레이어의 선두 포켓몬을 실행한다. 기본 야생 개체 수는 15다. 초원, 숲, 호수, 암석 지형의 높이와 통행 가능 여부는 순수 함수 `sampleWorld(x, z)`로 계산한다. 이 함수는 난수를 쓰지 않으므로 렌더링에서 반복 호출해도 시뮬레이션 결과가 바뀌지 않는다.

## 실제 회로가 관여하는 범위

각 월드 개체는 MaleCNS v1.0 실측 부분 회로의 128개 뉴런과 3,623개 연결을 사용하는 별도 `Brain` 인스턴스를 가진다. 음식 또는 추적 대상까지의 방향·거리, 네 방향의 충돌 여부, 에너지로 만든 12개 입력을 받고, 감각 우회를 끈 상태에서 재귀 계산을 4회 수행한다. 다섯 출력은 북쪽·동쪽·남쪽·서쪽 이동과 쉬기에 대응한다.

이 입력 대응, 출력 대응, 이동 거리, 충돌 규칙, 보상과 Q-learning은 게임을 위해 직접 설계한 것이다. 실제 초파리 감각·운동 기관에 대응시킨 회로가 아니며, 자율 이동을 생물학적 지능의 증거로 설명하지 않는다. 들판 Brain은 전투 Brain과 완전히 별개다. 개체의 필드 판독층과 활동 상태가 자동 전투의 기술 선택 가중치를 오염시키지 않는다.

야생 개체는 가까운 음식 방향을 감각 입력으로 받고 움직인다. 동행 포켓몬은 선택한 야생 포켓몬이 있으면 그 개체를, 없으면 플레이어를 목표로 입력받는다. 이동 자체는 Brain의 다섯 출력으로 결정하며 월드 규칙은 경계·장애물·개체 충돌만 집행한다.

## 출현과 레벨

151종 모두 `spawnCatalog()`에 포함되며 배지로 잠기지 않는다. 생성 순번은 1~151종을 순환하므로 전투가 끝나고 야생 개체가 교체되면서 전 종이 실제 생성 경로에 들어온다. 원본 도감의 habitat를 다음 생태계로 대응시킨다.

- `forest` → 숲
- `sea`, `waters-edge` → 호수
- `mountain`, `rough-terrain`, `cave`, `rare` → 암석 지대
- 그 밖의 habitat → 초원

레벨은 배지 대신 월드 중심에서 떨어진 거리를 비선형으로 반영해 2~85 범위에서 정한다. 가까운 지역은 초반 선두 포켓몬으로 상대할 수 있고 외곽으로 갈수록 높은 레벨이 나온다. habitat 대응과 레벨 곡선도 생물학적 정보가 아닌 게임 설계다.

## 월드 안 자동 전투

선택한 야생 포켓몬이 플레이어 반경 4 안에 들어오거나 다른 야생 포켓몬과 반경 1.4 안에서 접촉하면 별도 화면 전환 없이 야생 전투를 연다. 전투가 진행되는 동안 0.9초마다 다음 한 턴을 처리한다.

1. 양쪽 활성 포켓몬의 `ConnectomeController.choose`가 기술 슬롯 4개 또는 기다리기를 선택한다.
2. 선택 결과를 기존 `actBattle`에 전달한다.
3. 데미지, 명중, 상태, PP, 기절, 강제 교체, 경험치, 레벨, 돈, 패배 후 회복은 기존 엔진 규칙이 처리한다.
4. 승리 후 레벨 조건을 만족한 진화는 기존 `availableEvolutions`와 `evolve`를 통해 자동 처리한다. 도구·교환 진화는 자동으로 소비하지 않는다.

포획 버튼은 `requestCapture(ball?)`로 다음 자동 턴에 선택한 볼을 사용한다. 볼을 생략하면 보유 중인 울트라볼, 수퍼볼, 몬스터볼 순으로 선택한다. 자동 포획을 켜면 상대 HP가 최대 HP의 35% 이하일 때 같은 규칙을 적용한다. 성공 확률, 볼 소모, 팀 6마리 제한, 박스 이동, 도감 등록은 모두 기존 `actBattle` 경로를 사용한다.

## 공개 API와 저장

```ts
new OpenWorldSimulation(graph, game, seed, checkpoint?, fieldPolicy?, wildCount?)
simulation.movePlayer({ x, z, heading })
simulation.movePartner({ x, z, heading })
simulation.syncPlayerToCompanion()
simulation.selectWild(instanceId | null)
simulation.startEncounter(instanceId)
simulation.requestCapture(ball?)
simulation.requestAction({ type: 'move' | 'item' | 'switch' | 'run' | 'wait', ... })
simulation.setAutoCapture(enabled)
simulation.setAutoHunt(enabled)
simulation.step({ deltaSeconds?, learning?, epsilon? })
simulation.visibleEntities(max?)
simulation.snapshot()
simulation.rosterStatus()
sampleWorld(x, z)
movementSpeed(speciesId)
nextSpeciesInBiome(speciesId)
serializeOpenWorld(game, simulation)
restoreOpenWorld(graph, json, fieldPolicy?)
```

## Open-world Speed and player actions

`movementSpeed(speciesId)` maps the Pokedex base Speed stat to world units per second with the engineered formula `1.2 + baseSpeed * 0.018`. Movement is multiplied by `deltaSeconds`. A zero delta produces no displacement, and longer paths are sampled every 0.45 world units so a fast Pokemon cannot skip across blocked terrain. This mapping is a game rule and is separate from the battle engine's Speed stat and turn order.

The first three serial spawns remain species 1, 2, and 3, but they are placed 8 to 15 units from the origin at level 2 or 3. Later spawns keep the habitat-biome placement and radial level rule. This provides a playable first encounter without changing the 1-to-151 serial provenance.

`requestAction(action)` queues a manual move, item, switch, run, or wait for the next 0.9-second battle turn. Catch actions delegate to `requestCapture`. All queued actions still pass through `advanceBattle` and `actBattle`, preserving enemy connectome decisions, battle rewards, evolution, entity replacement, and save/replay state. The queued action is included in checkpoints. A manual player turn clears the previous automatic decision before `actBattle`, so its reward cannot update or be counted as learning from the automatic policy.

Transform battle forms use their effective species, stats, and move slots for connectome observations and action validity. The resulting brain state is written back to the original owned instance. Switching the lead also moves the previous companion field brain into `companionMemories`; its weights and update counter survive later lead changes and save restoration.

## Automatic hunting and delayed respawn

Automatic hunting starts enabled. The nearest wild Pokemon is selected, and the companion receives its relative position through the same 12-input recurrent policy used for ordinary movement. The local coordinate inputs are clamped `dx / 16` and `dz / 10`; the previous `/240` scale was too small for the deployed readout. A battle starts when the companion physically approaches within 2.8 world units, or through the existing close player-contact rule. The player is not moved to manufacture an encounter.

In automatic hunting, a connectome output that selects wait, an empty move, or a non-damaging status move is replaced with the strongest usable damaging move. This is an engineered product rule. Because the executed action differs from the policy output, that fallback turn clears pending player learning and does not assign its reward to the connectome choice.

After a win, capture, loss, or escape, the removed wild instance enters `respawnQueue` for 4 to 6 simulated seconds. `alive + pending` remains between 12 and 18. The replacement uses a walkable point near the former habitat or current play area, keeps the same biome, and is capped at the active lead's level plus two. `nextSpeciesInBiome` advances deterministically through every species assigned to that biome, so repeated replacement retains an actual spawn path for all 151 species. The queue, remaining timers, and `autoHunt` flag are saved and replayed.

The trainer and companion share one visible world position. `movePartner` accepts at most 0.35 seconds of the species-specific movement distance, samples the whole path for terrain and entity collisions, moves the companion, and updates the player/camera anchor. It clears the companion's pending neural transition and sets `manualControlRemaining` to 0.3 seconds, during which only that companion's autonomous movement is paused. Wild brains, respawn timers, and battles continue. `syncPlayerToCompanion` copies the current companion coordinates to the player anchor after autonomous ticks. The hold timer is part of the checkpoint and exact replay.

## Bounded validation (2026-09-10)

Run:

```powershell
npm test -- --run tests/openworld.test.ts
npx tsx scripts/verify-openworld.ts
```

The eleven focused tests passed. The saved report is `artifacts/openworld-validation-2026-09-10/report.json`, with its checkpoint, replay trace, and policy beside it. Two fixed evaluation seeds were run for 100 ticks per condition with learning disabled. Random action selection collected 1 food, the pre-training policy 2, the 2,000-tick trained policy 28, and the trained policy with every recurrent edge weight zeroed 1. These short descriptive totals are not statistical evidence of learning.

The public `openworld-policy.json` was trained with automatic hunting disabled, then frozen for three held-out automatic-hunt seeds. Each seed simulated 150 seconds with learning disabled. The runs produced 9/5/4 encounters, 8/3/2 wins, and 9/5/4 completed replacements. Across the three runs, victory rewards added 592 money before defeat recovery costs and experience increased by 702. The overall money delta was -869 because five losses invoked the existing recovery penalty.

The validation also confirmed that evaluation left all input/readout weights and update counters unchanged, each entity owns separate activity/readout state, two restores of one checkpoint replay exactly, and checkpoints do not duplicate the 3,623 graph edges. The edge ablation changed the action trace, showing that the imported recurrent edges participate computationally in this run.

The real-data path is limited to a 128-neuron, 3,623-edge induced MaleCNS v1.0 subset around bilateral DNa02 seeds. The sensory projection, recurrent update equation, action readout, base-Speed mapping, reward, and Q-learning rule are engineered. The comparison does not establish an anatomical sensorimotor mapping, a whole fly brain, biological learning, or Pokemon intelligence.

`visibleEntities(12)`는 전투 상대, 선택 대상, 동행 포켓몬, 플레이어와 가까운 야생 포켓몬 순으로 최대 12개를 반환한다. 시뮬레이션에는 기본 15개 야생 개체가 계속 남아 있으며 이 함수는 렌더 부하를 제한하는 보기 선택일 뿐이다.

월드 스냅샷은 필드 Brain마다 `graphId`만 저장하고 3,623개 연결을 반복 저장하지 않는다. `serializeOpenWorld`도 게임의 전투 Brain에서 그래프를 제거한다. 복원할 때 호출자가 검증된 공통 그래프를 제공한다. RNG 상태, 전투 시간 누적, 선택 대상, 포획 요청, 음식, 모든 개체의 필드 Brain과 게임 상태를 함께 복원하므로 동일 입력으로 정확히 재생할 수 있다.

## 검증

```powershell
npm test -- --run tests/openworld.test.ts
npx tsc --noEmit
```

관련 테스트는 실제 128/3,623 그래프를 이용한 다중 개체 이동, 151종 출현 목록, 생태계와 장애물, 기존 `actBattle`을 통한 자동 승리·경험치·돈·4기술 제한·레벨 진화, 실제 포획 확률과 볼 소모, 진행 중 전투 저장 및 정확한 리플레이, 저장 데이터의 그래프 중복 제거를 검사한다.
