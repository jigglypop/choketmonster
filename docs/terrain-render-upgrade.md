# 2026-09-11 지형과 표시 개선

포켓몬 머리 위 이름·HP는 기본으로 숨긴다. 카메라 옆 `이름·HP` 버튼을 켠 경우에만 가까운 개체를 표시하며, 추적·전투가 이 설정을 바꾸지 않는다. 켠 표시도 지형과 포켓몬을 뚫고 그리지 않는다. 설정은 이 브라우저에 저장한다. 직접 선택한 야생의 이름·레벨·HP·타입·이동 속도와 추적·배틀 버튼은 **좌측 하단**에 고정한다. 파트너 패널은 우측 하단에 유지한다. 좁은 화면에서도 선택 카드는 움직이지 않으며, 펼친 파트너 패널은 그 위에서 내부 스크롤을 쓴다. 자동 사냥의 내부 타깃은 정보창을 띄우지 않는다.

추가 모델·PBR 셰이더·글래스 UI와 볼 소진 처리의 후속 변경은 [nature-glass-upgrade.md](nature-glass-upgrade.md)에 기록한다. 아래 측정은 후속 변경 전 버전의 결과다.

## 자산 출처와 재현

- [Kenney Nature Kit 2.1](https://kenney.nl/assets/nature-kit), CC0: 보관 중인 공식 원본 압축의 고정 SHA-256을 확인한 뒤 `rock_tallC`, `rock_tallG`, `cliff_rock`을 추가 적용했다. 새 모델 3개는 합계 15,868바이트, 131삼각형이다. 바닥 중심·Y-up·미터로 정규화하고, 내보낸 GLB를 다시 가져와 피벗·치수·삼각형 수를 검사했다. 원본 형상은 보존했다.
- [Poly Haven Aerial Grass Rock](https://polyhaven.com/a/aerial_grass_rock), Rob Tuytel; [Rock Boulder Dry](https://polyhaven.com/a/rock_boulder_dry), Dimitrios Savva / Rico Cilliers. [CC0 이용 조건](https://polyhaven.com/license). 공식 다운로드 서버에서 1K 색상·OpenGL 노멀 4장을 새로 내려받고 서버 SHA-1 및 로컬 SHA-256을 검사했다. 색상은 1K WebP, 노멀은 512px 무손실 WebP로 변환했다. 런타임 파일 합계 1,175,880바이트.

원본 텍스처는 `assets/source-world/polyhaven-terrain-20260911/`, 원본 Kenney 압축은 `assets/source-world/kenney-nature-kit-2.1/`에 보존한다. 배포 파일별 URL·원본 해시·변환·산출물 해시와 라이선스는 `public/textures/terrain/manifest.json`, `public/models/openworld/rocks/manifest.json`, 각 폴더의 `LICENSE.txt`에 있다.

```powershell
python scripts/fetch-terrain-textures.py
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python scripts/normalize-terrain-rocks.py
```

Python 텍스처 변환은 Pillow가 필요하다. 기존 체크섬 영수증이 있는 다운로드는 재사용한다. 이번 환경에는 `game-dev` CLI가 없어 정식 vendoring 명령 대신 저장소의 다운로드·해시·Blender 재가져오기 절차로 검증했다.

## 렌더링 변경과 검증 범위

지형·길·바위에 월드 좌표 기반 질감과 노멀 디테일을 적용한다. 기존 지형 메시·높이·이동 판정은 그대로 사용한다. 물은 두 파장의 시간 애니메이션과 시야각에 따른 색 변화를 같은 렌더 패스에서 계산한다. 별도 후처리 버퍼는 추가하지 않는다.

그림자를 플레이어 주변에 집중하고 2048²에서 1024²로 줄였다. 안개 너머 배경 인스턴스를 제외하고 먹이는 한 인스턴스 메시로 묶었다. 느린 환경에서는 3D 캔버스만 DPR 0.7까지 낮추고, 여유가 생기면 최대 1.5까지 복구한다. HTML UI 해상도는 유지한다. 렌더링은 시뮬레이션 RNG나 개체의 학습 상태를 바꾸지 않는다.

`scripts/capture-render.ts`는 태초마을, 동일 저장 데이터·시드, 일시 정지, 동일 카메라, 1440×1000 화면에서 비교한다. `?renderProbe`가 있을 때만 읽기용 Three.js 통계를 노출한다. 결과와 스크린샷은 `artifacts/render-upgrade/`에 보관한다.

| 측정 | 이전 | 개선 후 |
| --- | ---: | ---: |
| 프레임당 그리기 호출 중앙값 | 148 | 123 |
| 프레임당 삼각형 중앙값 | 288,336 | 183,417 |
| GPU 텍스처 객체 | 88 | 82 |
| 그림자 텍스처 픽셀 수 | 4,194,304 | 1,048,576 |

이는 제출되는 렌더 작업량 비교다. Playwright Chromium은 SwiftShader 소프트웨어 렌더러를 사용했다. 자동 해상도를 적용한 프레임 간격 중앙값은 이전 169.1ms, 개선 후 159.5ms였지만 해상도가 다르고 호스트 부하 영향을 받으므로 실제 GPU FPS 향상의 증거로 보지 않는다. 같은 해상도의 첫 셰이더 버전은 211.3ms로 느려져 자동 해상도 제어를 추가했다. 원시 측정은 `baseline.json`, `candidate-1.json`, `candidate-final.json`이다.
