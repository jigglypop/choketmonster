# 오픈월드 자연환경 에셋

## 채택 원본과 사용 조건

오픈월드 소품은 Kenney가 공식 배포하는 [Nature Kit](https://kenney.nl/assets/nature-kit)에서 골랐다. 공식 페이지는 3D 모델 330개와 Creative Commons Zero를 표시한다. 내려받은 ZIP 내부 `License.txt`는 패키지를 `Nature Kit (2.1)`로 식별하며 CC0, 개인·교육·상업 프로젝트 사용 가능, 저작자 표기 선택 사항이라고 명시한다.

- 제작자: Kenney (`www.kenney.nl`)
- 라이선스: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- 공식 원본: `https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip`
- 원본 버전: ZIP 내부 라이선스 기준 2.1
- 원본 ZIP SHA-256: `fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d`
- 고정 식별자: 공식 미디어 경로 `37ac38a37b-1677698939`와 위 SHA-256. 이 배포물은 Git 저장소가 아니므로 커밋 대신 바이트 해시로 고정한다.
- 보존한 라이선스: `public/models/openworld/LICENSE-KENNEY.txt`

공식 페이지의 업데이트 표시는 현재 1.0만 노출하지만, 실제 공식 ZIP에 포함된 라이선스 제목은 2.1이다. 프로젝트 기록은 내려받아 해시로 고정한 ZIP 내부 버전을 따른다.

## 재현 절차

원본 아카이브는 런타임 번들 밖의 `assets/source-world/kenney-nature-kit-2.1/`에 둔다. 다음 명령은 동일 URL을 내려받고 안전한 ZIP 경로인지 검사하며 SHA-256이 다르면 중단한다.

```powershell
python scripts/fetch-world-assets.py
```

다음 명령은 12종을 바닥 중앙 피벗, glTF Y-up 좌표와 게임용 크기로 정규화한다. 각 결과 GLB를 Blender로 다시 가져와 바닥 높이, 바운드, 재질 수, 삼각형 수를 검사하고 스튜디오 파일과 미리보기를 만든다.

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' `
  --background --factory-startup `
  --python scripts/normalize-world-assets.py
```

생성 결과는 다음과 같다.

- 런타임 목록과 해시: `public/models/openworld/manifest.json`
- 소품 GLB: `public/models/openworld/props/*.glb`
- Blender 검사 장면: `assets/blender/openworld-props-study.blend`
- 검사 렌더: `artifacts/openworld-props-preview.png`
- 수치 검사: `artifacts/openworld-props-inspection.json`
- Blender 표준 출력: `artifacts/openworld-assets-build.log`

## 런타임 계약

모든 GLB는 Three.js 기준 X/Z가 지면이고 Y가 위인 미터 단위다. 피벗 `(0, 0, 0)`은 모델 바닥의 수평 중앙이므로 지형 표면 높이를 그대로 `position.y`에 넣는다. 모델 자체에 재질과 색이 들어 있어 별도 텍스처 요청이 없다.

`manifest.json`의 각 항목은 URL, X/Y/Z 바운드, 출력 SHA-256, 삼각형·메시·재질 수와 추천 배치를 제공한다. `recommendedPlacement.scaleRange` 안에서 인스턴스별 크기를 바꾸고 Y축만 회전한다. `recommendedPlacement.collider`가 `null`인 풀과 꽃은 통과 가능하게 둔다. 나무 캡슐은 수관 전체가 아니라 줄기만 막도록 설계했다.

240×240 범위 `[-120, 120]`에는 다음 밀도가 출발점으로 적당하다.

| 구역 | 권장 구성 | 배치 간격 |
| --- | --- | --- |
| 숲 | 나무 3종 혼합, 덤불, 그루터기, 통나무 | 나무 4~6m, 작은 소품 1.5~3m |
| 초원 | 둥근 나무를 드물게, 풀·꽃 군락, 작은 바위 | 나무 8~14m, 식생 0.45~1.2m |
| 고지대 | 소나무, 큰·작은 바위 | 3~7m |
| 마을 경계 | 울타리 3.33m 단위, 그루터기·꽃 | 울타리는 끝점을 맞춰 연속 배치 |

시야 밖 소품은 생성하지 않고, 반복 배치는 같은 GLB와 재질을 공유하는 인스턴싱을 권장한다. 12개 원형을 한 번씩 로드했을 때 총 1,226 triangles, 98,720 bytes이고 개별 모델은 모두 10,000 triangles 미만이다. 이 수치는 런타임 배치 인스턴스 수와 드로콜 수를 뜻하지 않는다.

## 선택한 12종

| ID | URL | 기본 크기 X×Y×Z | 충돌 |
| --- | --- | --- | --- |
| `tree-round` | `/models/openworld/props/tree-round.glb` | 2.12×4.80×1.84 | 줄기 capsule |
| `tree-oak` | `/models/openworld/props/tree-oak.glb` | 2.87×5.50×3.32 | 줄기 capsule |
| `tree-pine` | `/models/openworld/props/tree-pine.glb` | 1.57×6.20×1.59 | 줄기 capsule |
| `rock-large` | `/models/openworld/props/rock-large.glb` | 3.47×1.15×4.50 | box |
| `rock-small` | `/models/openworld/props/rock-small.glb` | 1.53×0.52×1.53 | box |
| `grass-tuft` | `/models/openworld/props/grass-tuft.glb` | 1.16×0.72×1.16 | 없음 |
| `flower-red` | `/models/openworld/props/flower-red.glb` | 0.30×0.55×0.34 | 없음 |
| `flower-yellow` | `/models/openworld/props/flower-yellow.glb` | 0.72×0.55×0.83 | 없음 |
| `bush` | `/models/openworld/props/bush.glb` | 1.54×0.95×1.54 | sphere |
| `stump` | `/models/openworld/props/stump.glb` | 1.24×0.72×1.29 | cylinder |
| `fence` | `/models/openworld/props/fence.glb` | 3.33×1.15×0.23 | box |
| `fallen-log` | `/models/openworld/props/fallen-log.glb` | 1.73×0.72×0.95 | box |

에셋 공급망 검사는 복사한 바이트, 출처와 라이선스를 입증한다. 실제 장면의 밀도, 충돌 체감과 프레임 비용은 오픈월드 뷰에서 별도로 확인해야 한다.

## 실제 장면 통합

`src/openworld/scenery.ts`가 `sampleWorld`만 읽어 숲, 초원, 호숫가와 암석 지대의 배치를 만든다. 배치용 노이즈는 좌표 기반 함수라 시뮬레이션 RNG를 소비하지 않으며 같은 지형에는 항상 같은 결과를 낸다. 큰 나무와 큰 바위는 `sampleWorld(...).blocked`인 지점에만 놓아 보이는 장애물과 이동 판정이 같은 계약을 따른다. 풀, 꽃, 덤불, 작은 바위는 통행 가능한 지면 장식이다. 울타리는 이동 경계에 둔다.

`src/openworld/view.tsx`는 12개 원형 GLB를 한 번씩 캐시하고, 각 원형 내부 mesh별 `InstancedMesh`에 모든 배치 행렬을 기록한다. 인스턴스 행렬은 배치가 바뀔 때만 다시 계산한다. GLB가 소유한 geometry와 material은 인스턴스가 공유하며 컴포넌트별로 폐기하지 않는다. 지형은 계속 `sampleWorld`로 만든 높이 메시가 충돌과 화면 양쪽의 기준이고 별도의 `world.glb`는 기본 렌더 경로에 없다.

호수는 시뮬레이션의 막힌 물 중심부에 반투명 원판과 물가 링으로 표시하며, 굽은 흙길은 각 꼭짓점에서 `sampleWorld` 높이를 다시 읽어 지형 위에 붙인다. 이 장식은 충돌 판정을 추가하지 않는다.

플레이어는 파트너 포켓몬 자체로 표시한다. 최신 요청에 따라 원통형 트레이너 형상은 제거했으며 이동과 카메라가 파트너를 따른다. 포켓몬 렌더 스냅샷의 `movementSpeed`(world units/s)는 수동 조작 속도·위치 보간 최대 속도·걷기 clip 재생률에 쓰인다. `moveType`은 공격 링의 색과 발광을 18개 타입에 맞춰 고른다. 렌더링은 전투 피해나 시뮬레이션 난수 상태를 바꾸지 않는다.
