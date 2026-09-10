# 초켓몬스터 3D 월드 제작 기록

## 결과

`scripts/build-world.py`가 Blender 5.2의 새 팩토리 장면에서 월드, 트레이너, 렌더를 절차적으로 만든다. 외부 생성 서비스나 재배포 자산은 사용하지 않았다. 지형, 건물, 나무, 풀, 연못, 길, 소품과 트레이너는 이 프로젝트를 위해 만든 기본 mesh와 PBR 재질이다.

- 편집 원본: `assets/blender/choketmon-world.blend`
- 정적 런타임 월드: `public/models/world.glb`
- 애니메이션 트레이너: `public/models/trainer.glb`
- 검토 렌더: `artifacts/world-preview.png`
- Blender 전체 로그: `artifacts/world-build.log`
- 기계 판독 검증: `artifacts/world-validation.json`

미리보기는 1024×640 Eevee 렌더로 직접 확인했다. 부드러운 초원 섬, 경계 수목, 붉은 지붕 센터, 청록 체육관, 교차 길, 연못, 양쪽 풀숲 geometry, 표지판·벤치와 트레이너가 모두 보인다. `.blend`에는 `WorldPreviewCamera`, Sun, Softbox가 포함된다. 런타임 GLB에는 카메라와 조명을 넣지 않아 게임 조명이 장면을 제어할 수 있다.

## 좌표와 타일 대응

`src/game/map.ts`의 24×15 타일에서 Blender 위치는 다음과 같다.

```text
Blender X = tileX - 11.5
Blender Y = -(tileY - 7)
Blender Z = 높이
```

glTF는 `export_yup=true`로 내보낸다. 따라서 Three.js에서는 `xWorld = tileX - 11.5`, `zWorld = tileY - 7`, `yWorld = 높이`가 된다.

배치는 충돌 사각형과 일치한다.

| 요소 | `map.ts` 타일 범위 | 3D 생성 방식 |
|---|---|---|
| 포켓몬 센터 | x 3..6, y 3..5 | 4×3 타일 cream 건물과 붉은 박공지붕 |
| 체육관 | x 16..20, y 2..4 | 5×3 타일 청록 건물과 기둥 |
| 연못 | x 17..21, y 9..12 | 5×4 타일 물 mesh와 둥근 돌 테두리 |
| 길 | y=7, x=12, y 10..12의 x 9..14 | 세 개의 둥근 path mesh |
| 풀숲 | `tileAt`의 세 grass 구역 | 56타일, 교차 quad blade geometry |
| 나무 충돌 | 바깥 한 타일 테두리 | 74그루, 줄기·수관·강조를 재질별 결합 |

건물과 물, 경계 나무는 게임에서 걸을 수 없는 타일이다. 풀과 길은 걸을 수 있으며 풀 타일에서 게임 엔진이 조우를 판정한다.

## 성능과 구조 검증

Blender 생성 출력과 별도로 Node가 두 GLB의 binary header와 JSON chunk를 직접 읽었다. GLB magic, 선언 길이와 실제 byte 길이, glTF 버전 2를 확인한 뒤 index accessor에서 triangle 수를 계산했다.

| 자산 | 크기 | triangles | nodes / primitives | materials | animation |
|---|---:|---:|---:|---:|---:|
| `world.glb` | 701,344 bytes | 8,876 | 38 / 38 | 18 | 0 |
| `trainer.glb` | 74,480 bytes | 944 | 10 / 9 | 4 | 5 clips, 5 channels |

월드는 150,000 triangle 제한의 약 5.9%이고 GLB 10MB 제한의 약 7.0%다. primitive 수 38을 보수적인 draw-call 상한으로 사용해 400 제한을 통과한다. 경계 나무 74그루는 줄기, 어두운 수관, 밝은 수관의 세 mesh로 합쳤고 모든 풀잎은 하나의 mesh다.

트레이너는 부모 `TrainerRoot`와 9개 primitive 부품으로 구성된다. 1~20 frame 동안 양팔·양다리가 교차하고 몸이 위아래로 움직이는 반복 가능한 걷기 동작을 GLB transform animation으로 내보냈다.

저장된 `.blend`를 Blender 5.2.1 LTS의 별도 background 프로세스로 다시 열어 51 objects, 47 meshes, 21 materials, camera와 frame 20을 확인했다. SHA-256과 모든 수치는 `artifacts/world-validation.json`에 기록했다.

## 재생성

Blender 5.2.1 LTS에서 다음 명령을 저장소 루트에서 실행한다. 스크립트는 위 네 산출물을 같은 경로에 다시 만든다.

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python 'C:\dev\choketmon\scripts\build-world.py'
```

설치 환경에는 `game-dev` CLI가 없어 capability/doctor 명령은 사용할 수 없었다. 이번 작업은 유료 제공자나 다운로드가 없는 로컬 Blender 절차 생성이므로 Blender 실행 파일과 생성 byte를 직접 검사했다.

## 해시

```text
assets/blender/choketmon-world.blend  68e81ae60bed811913b38a227d45d181fb5fb68389a6e2c38b1d52bde871ac97
public/models/world.glb               fcaace36f8715267e9c80b5a7d3cc7081a7f9d5219981b84766479c52c584a50
public/models/trainer.glb             d44b9bbe14a3de8514422f1dd5c0e0c39b6a7a19e73849e3b8e57912b18b5a25
artifacts/world-preview.png           2ed6798b81eebd28a8cdfeba7bf2d6f6432512dfce66972e5f69e47c0a6e039a
```
