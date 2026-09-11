# 관동 마을 건물 에셋

관동 맵의 임시 박스 건물을 대체할 수 있도록 Kenney의 CC0 저폴리 건물 5개를 내려받아 glTF Y-up 기준으로 정규화했다. 이 세트는 원작 포켓몬 건물이나 로고를 복제하지 않는다. 지붕 색과 낮은 실루엣으로 주거지, 회복 시설, 상점, 체육관 역할을 구분하는 일반 도시 에셋이다.

## 출처와 권리

| 원본 | 버전 | 공식 페이지 | 압축 파일 SHA-256 | 라이선스 |
| --- | --- | --- | --- | --- |
| Kenney City Kit (Suburban) | 2.0 | <https://kenney.nl/assets/city-kit-suburban> | `5869c35cf30b1c87bdb2d197b6d325eebadd2ef08ea27f04797e8e08d77a9a39` | CC0-1.0 |
| Kenney City Kit (Commercial) | 2.1 | <https://kenney.nl/assets/city-kit-commercial> | `f8b09b081c2bb88bcc126e2dec1cb40fd0dad7e7e591b6c26aaefe96fb35276b` | CC0-1.0 |

공식 페이지는 각각 CC0, 파일 수 40개와 50개, 버전 2.0과 2.1을 표시한다. 원본 압축 파일, 풀어 쓴 파일, 원본 라이선스, 체크섬 영수증은 `data/local/kanto-assets/`에 둔다. 이 경로는 Git에 포함하지 않으며 원본은 수정하지 않는다. 배포되는 두 라이선스 사본은 `public/models/kanto-buildings/LICENSE-KENNEY-*-CC0.txt`에 있다.

## 재현

Blender 5.2 또는 5.1이 설치된 Windows 환경에서 다음 명령을 실행한다.

```powershell
python scripts/fetch-kanto-assets.py
```

스크립트는 공식 주소에서 두 압축 파일을 `.part`로 내려받고 고정 SHA-256을 확인한 뒤 안전하게 푼다. 이어서 Blender를 백그라운드로 실행해 선택한 GLB를 정규화하고, 내보낸 GLB를 다시 가져와 피벗·치수·삼각형 수를 확인한다. `--download-only`는 원본 확보까지만 수행하며, `--force`는 고정 주소를 다시 내려받는다. 다른 Blender 경로는 `--blender <path>`로 지정한다.

정규화는 메시 형상을 다시 만들지 않는다. 바닥 중심을 원점으로 옮기고 비율을 유지한 채 목표 발자국 안으로 축소한다. 회복 시설과 상점의 색은 각각 원본 팩에 포함된 `variation-b.png`, `variation-a.png`를 쓴다. 산출물은 모두 단위 스케일이며 회전은 `[0, 0, 0]`이다.

## 런타임 계약

정확한 해시와 검증 수치는 `public/models/kanto-buildings/manifest.json`이 기준이다. `dimensions`는 Three.js의 `x/y/z` 미터이고 `y`가 높이다.

| 역할 | URL | 치수 x/y/z (m) | 삼각형 | 바이트 |
| --- | --- | ---: | ---: | ---: |
| 주택 | `/models/kanto-buildings/town-house.glb?v=b4742c7bb903` | 2.7500 / 1.7532 / 2.1237 | 1,612 | 108,340 |
| 큰 주택 | `/models/kanto-buildings/town-house-large.glb?v=b40ea2fd5a6b` | 3.1500 / 2.2194 / 1.8437 | 1,757 | 114,104 |
| 회복 시설 | `/models/kanto-buildings/town-clinic.glb?v=3b049c935182` | 3.2000 / 2.0518 / 2.5308 | 1,174 | 81,092 |
| 상점 | `/models/kanto-buildings/town-mart.glb?v=91d33bcbe904` | 3.2000 / 1.8154 / 2.2548 | 770 | 57,584 |
| 체육관 | `/models/kanto-buildings/town-gym.glb?v=2ca345798350` | 3.2000 / 1.7424 / 1.9666 | 1,509 | 100,684 |

전체 다운로드 크기는 461,804바이트이고 삼각형은 6,822개다. 모델별 상한은 10,000삼각형, 세트 상한은 2MB로 스크립트가 검사한다. 기존 약 3.2×2.8m 건물 자리에 `scale={1}`로 배치하고, 출입구 방향은 맵 배치 회전만 조절한다. 충돌체는 시각 메시 전체보다 약간 작은 기존 건물 발자국을 유지해 처마와 계단에 플레이어가 걸리지 않게 한다.

검토 렌더는 `artifacts/kanto-buildings-preview.png`, 재현 가능한 Blender 장면은 `data/local/kanto-assets/kanto-buildings-inspection.blend`에 생성된다.
