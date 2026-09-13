# 포켓몬 3D 리깅·애니메이션 검사

이 문서는 로컬에 고정한 원본 GLB 971개를 수정하지 않고 검사한 결과다. `skin`은 메시가 관절에 묶였다는 뜻이고, `animation`은 실제로 재생할 키프레임 클립이 있다는 뜻이다. 스킨만 있고 클립이 없는 모델은 리깅 정보가 있어도 현재 게임에서 걷기나 공격 동작을 재생할 수 없다.

## 결과

| 분류 | 전체 | 1~151 원본 | 152 이후 원본 |
| --- | ---: | ---: | ---: |
| 스킨과 클립 있음 | 261 | 151 | 110 |
| 스킨만 있고 클립 없음 | 356 | 0 | 356 |
| 스킨 없이 노드 애니메이션 있음 | 4 | 0 | 4 |
| 스킨과 클립 모두 없음 | 350 | 0 | 350 |

따라서 화면에서 어떤 모델만 자연스럽게 움직이는 주된 원인은 렌더러 설정 차이가 아니라 원본 자산 구성 차이다. 1~151 모델은 151개 모두 스킨과 클립이 있다. 확대 원본 820개 중 실제 클립이 있는 모델은 114개뿐이다. 그중 4개(도감 796, 798, 805, 867)는 스킨 대신 노드 계층의 translation/rotation/scale 트랙으로 움직이며 Three.js `AnimationMixer`로 재생할 수 있다.

렌더러는 `SkeletonUtils.clone`으로 스킨과 뼈 연결을 함께 복제하고, 복제된 루트에 `AnimationMixer`를 연결한다. 이 경로에는 공유 스켈레톤 복제 오류가 없었다. 클립 이름은 원본마다 `idle`, `walk`, `attack` 외에도 `Idol`, `defaultwait`, `ba10`, `ba20`, `ba21`, `buturi`, `tokusyu`처럼 달라서 해당 이름도 선택하도록 보완했다. 요청한 동작 이름이 없으면 대기 또는 첫 클립을 반복하고, 그 클립을 공격 동작인 것처럼 한 번 재생한 뒤 마지막 프레임에 고정하지 않는다. 클립이 없는 모델에는 기존의 작은 이동 바운스만 적용되며, 이를 리깅 또는 원본 애니메이션으로 표시하면 안 된다.

세부 결과는 [`pokemon-rigging-metadata.json`](./pokemon-rigging-metadata.json)에 있다. 각 도감 번호별로 원본 경로, 전체 파일 SHA-256, 스킨·고유 관절·스킨 메시·클립·채널·최대 길이와 다음 네 상태를 기록한다. 화면은 큰 검사 JSON을 번들에 넣지 않고, 같은 검사에서 생성한 `src/data/model-motion.ts`의 `getPokemonMotionSupport()`로 네 상태와 `unavailable`을 조회할 수 있다.

- `rigged-animated`: 스킨과 애니메이션 클립이 모두 있음
- `rigged-static`: 스킨은 있지만 클립이 없음
- `transform-animated`: 스킨 없이 노드 변환 클립이 있음
- `static`: 스킨과 클립이 모두 없음

다시 검사하려면 저장소 루트에서 아래 명령을 실행한다.

```sh
npx tsx scripts/inspect-pokemon-rigging.ts
npx tsx scripts/verify-pokemon-animation-playback.ts
```

두 번째 검사는 실행 중인 로컬 Vite 화면에 고정 원본 GLB를 직접 전달하고 카메라 회전을 끈 뒤, 실제 `AnimationMixer`가 550ms 동안 모델 노드의 position/quaternion/scale을 바꾸는지 확인한다. 저장된 결과 `artifacts/interface-refresh/model-tests/animation-playback.json`에서 스킨만 있고 클립이 없는 152번은 53개 노드 중 변화 0개, 스킨과 클립이 있는 160번은 130개 중 34개, 스킨 없이 변환 클립이 있는 796번은 4,456개 중 46개가 변했다. 세 경우 모두 페이지 오류 없이 예상과 일치했다.

게임 개발 스튜디오의 `game-dev capabilities --json`과 `game-dev doctor --json`도 먼저 실행했지만 현재 환경에는 `game-dev` 실행 파일이 설치되어 있지 않아 `command not found`가 반환됐다. 그래서 저장소 안의 읽기 전용 TypeScript 검사기로 GLB v2 JSON 청크를 직접 읽고, 원본 전체 바이트의 SHA-256을 함께 계산했다.

화면에서 지원 상태를 노출할 때는 “리깅됨” 한 가지 표시보다 위 네 상태를 그대로 쓰는 편이 정확하다. 특히 `rigged-static`은 새 애니메이션 제작이나 호환되는 동작의 리타기팅 없이는 재생 동작을 추가할 수 없다. 이번 검사에서는 유료 리깅, 새 자산 생성, 리타기팅, 원본 GLB 변경을 하지 않았다.
