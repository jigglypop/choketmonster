# 자연 에셋, 물체 셰이더와 글래스 UI

2026-09-11 후속 변경. 선택한 야생은 화면 좌측 하단에 독립적으로 고정하며 파트너 창을 펼쳐도 올라가지 않는다. 모바일에서는 접힌 파트너 버튼을 우측 하단에 두고, 펼친 창은 야생 카드보다 위에 표시하며 높이를 화면의 32%로 제한한다. 상단 헤더는 데스크톱 52px, 모바일 80px로 축소했고 지역 제목과 조작 UI도 줄였다. HUD·상단 내비게이션·카드·대화창에는 반투명 표면, 배경 블러, 밝은 테두리, 안쪽 하이라이트를 적용한다. 키보드 포커스 표시와 투명도 감소 환경의 대체 스타일을 제공한다.

볼이 0개면 자동 사냥을 중단하지 않는다. 전투 승리 후 포획 제안은 즉시 놓아주고 다음 탐색으로 진행한다. 저장된 포획 제안을 불러왔는데 볼이 없는 경우에도 다음 시뮬레이션 틱에 해제한다. 포획 요청과 턴 실행 사이에 마지막 볼이 사라져도 도망을 강제하지 않고 정상 전투를 계속한다. 볼이 남아 있을 때의 포획 동작은 유지한다.

## 내려받은 자산

원본은 `assets/source-world/polyhaven-nature-detail-20260911/`에 별도로 보존한다. [Poly Haven 이용 조건](https://polyhaven.com/license)에 따라 모두 CC0-1.0이며, URL·저자·API의 MD5·원본 SHA-256·파일 크기를 기록했다. 다운로드는 `.part`와 Range 요청으로 재개하고 완료 크기와 해시가 맞을 때만 원본 이름으로 옮긴다. 출처: Powered by Poly Haven.

| 원본 | 적용 | 런타임 크기 |
| --- | --- | ---: |
| [Rock Moss Set 01](https://polyhaven.com/a/rock_moss_set_01), Kless Gyzen | 이끼 바위 2종, 1,799 / 1,199삼각형 | 1,010,724바이트 |
| [Fern 02](https://polyhaven.com/a/fern_02) | 양치식물, 784삼각형 | 1,602,292바이트 |
| [Brown Mud 03](https://polyhaven.com/a/brown_mud_03) | 길 전용 색상·노멀·AO/거칠기 |
| [Aerial Grass Rock](https://polyhaven.com/a/aerial_grass_rock), [Rock Boulder Dry](https://polyhaven.com/a/rock_boulder_dry) | 지면·기존 바위의 AO/거칠기 | 새 텍스처 5장 총 1,735,672바이트 |

새 런타임 자산은 총 4,348,688바이트다. 모델은 원본 변형 중 3개 메시를 선택했고 나머지 변형은 포함하지 않았다. 바위만 UV를 보존하며 삼각형 수를 제한하고, 모델의 원본 색상·노멀·거칠기 텍스처를 유지한다. 바닥 중심 피벗과 Y-up 미터 단위를 적용했다. 변환 후 GLB를 다시 가져와 높이·피벗·UV·삼각형 수를 확인했다.

최종 파일의 SHA-256, 선택 노드, 제외 기준, 변환 방법과 재가져오기 검사는 `public/models/openworld/nature-detail/manifest.json`과 `public/textures/nature-detail/manifest.json`에 있다. `game-dev` CLI가 이 환경에 없어 저장소의 독립 원본 패키지·해시 검증·Blender 재가져오기 절차를 사용했다.

## 셰이더와 배치

- 지면·길·기존 바위: 월드 좌표 재질, 노멀 디테일, AO와 거칠기 맵. 길에는 흙 전용 색상과 노멀을 사용한다.
- 새 이끼 바위와 양치식물: 모델 고유 UV와 PBR 맵을 보존한다. 기존 바위의 투영 텍스처를 덮어씌우지 않는다.
- 나무: 높이에 따른 수관 명암과 제한적인 잎 역광 효과를 적용한다. 역광 효과는 게임용 근사식이다.
- 물: 세 주파수의 잔물결 노멀, 시야각에 따른 반사색, 수면 가장자리의 얕은 물색과 포말. 수심 버퍼를 쓰지 않으며 포말은 수면 메시의 경계로 근사한다.
- 조명: 작은 절차적 하늘을 한 번 사전 필터링해 PBR 환경 반사에 사용한다. 프레임마다 후처리 버퍼를 추가하지 않는다.
- 새 모델은 인스턴싱하고 플레이어 주변 68m 셀 범위로 제한한다. 기존 큰 배경 모델은 140m 범위를 유지한다. 원래 지형 높이·통행 판정과 시뮬레이션 난수에는 관여하지 않는다.

## 재현

```powershell
python scripts/fetch-nature-detail.py
python scripts/pack-nature-surfaces.py
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python scripts/normalize-nature-detail.py
npx vitest run tests/kanto-gameplay.test.ts tests/openworld.test.ts tests/kanto-navigation.test.ts
npm run build
npx playwright test tests/ui/render-upgrade.spec.ts tests/ui/capture-skip.spec.ts
```

텍스처 패키징에는 Pillow가 필요하다. 검증용 Chromium은 SwiftShader를 사용하므로 캡처의 프레임 간격을 실제 GPU 성능으로 해석하지 않는다. `artifacts/render-upgrade/glass-before.png`는 이번 변경 전 같은 시드·정지 상태의 화면이다. 새 모델과 셰이더로 그리기 작업량이 늘어날 수 있으며 자동 해상도 제어를 유지한다. 시각적 개선을 생물학적 학습의 증거로 해석하지 않는다.
