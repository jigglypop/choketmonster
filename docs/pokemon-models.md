# Pokémon 3D 모델 출처와 사용 범위

## 관동 151종

`public/models/pokemon/{id}.glb`의 관동 151종 regular 모델은 공개 저장소 [06wj/pokemon](https://github.com/06wj/pokemon)의 고정 커밋 [`00d96f7f18894055e7f1db44fa0df6462e5e4c8a`](https://github.com/06wj/pokemon/tree/00d96f7f18894055e7f1db44fa0df6462e5e4c8a)에서 가져온다. 해당 README는 regular 모델 151개, 애니메이션 클립 869개, 골격 애니메이션과 내장 텍스처가 있는 self-contained GLB라고 설명한다.

`scripts/fetch-pokemon-models.ts`는 이 151종만 대상으로 한다. 원본을 `data/local/pokemon-models/<commit>`에 캐시하고 Git blob SHA-1과 SHA-256, GLB 2.0 구조를 검사한 뒤 로컬 개발용 `public/models/pokemon`에 복사한다. 기존 런타임 URL과 카탈로그는 이 출처를 그대로 유지한다.

## 152번 이후 기본종

152번 이후에는 [Pokemon-3D-api/assets](https://github.com/Pokemon-3D-api/assets)의 고정 커밋 [`429de1288cea0d43f5b4f56305d2276e94239d65`](https://github.com/Pokemon-3D-api/assets/tree/429de1288cea0d43f5b4f56305d2276e94239d65)을 사용한다. 이 커밋의 GitHub tree는 잘리지 않았으며 다음 범위를 확인했다.

| 항목 | 고정 커밋 결과 |
| --- | ---: |
| 저장소 전체 GLB | 1,322개 · 1,000,207,160바이트 |
| `models/opt/regular` GLB | 974개 · 332,666,404바이트 |
| 숫자 파일로 있는 전국도감 종 | 968종 |
| 성별 파일만 있는 종 | 521·668·916번 |
| 1~1025 중 지원되는 종 | 971종 |
| 기존 관동을 뺀 추가 지원 | 820종 |
| 모델이 없는 종 | 54종 |

성별 파일만 있는 세 종은 male 파일을 기본 표시로 선택한다. 정확한 누락 ID는 `src/data/pokemon-models.ts`의 `MISSING_POKEMON_MODEL_IDS`와 `src/data/pokemon-models-manifest.json`에 기록한다.

`src/data/pokemon-models.ts`는 다음 API를 제공한다.

- `hasPokemonModel(id)`: 관동 기존 모델 또는 새 regular 모델이 있는지 확인
- `getPokemonModelSource(id)`: 고정 URL, GLB 형식, Draco 필요 여부, WebP 텍스처, 저장소·커밋·원본 경로와 알려진 바이트 수 반환
- `EXPANDED_POKEMON_MODEL_IDS`: 152~1025에서 지원되는 820종
- `MISSING_POKEMON_MODEL_IDS`: 현재 원본에 없는 54종

151번 이하는 기존 06wj URL과 `requiresDraco: false`를 반환한다. 이후 지원 종은 Pokemon-3D-api의 고정 raw URL과 `requiresDraco: true`, `compression: "KHR_draco_mesh_compression"`, `textureEncoding: "webp"`를 반환한다. 원격 저장소의 main 브랜치를 런타임에 해석하지 않는다.

## 제한 다운로드와 검사

전체 regular 모델은 약 333MB이므로 자동으로 모두 다운로드하지 않는다. 다음 명령은 세대별 스타터 대표 10종만 검사하며 현재 합계는 903,200바이트다.

```bash
npx tsx scripts/fetch-expanded-models.ts

# 다른 존재 종을 제한 검사
npx tsx scripts/fetch-expanded-models.ts --ids 152,252

# 네트워크 모델 다운로드 없이 고정 tree로 카탈로그만 재생성
npx tsx scripts/fetch-expanded-models.ts --catalog-only
```

원본은 `data/local/pokemon-models-expanded/<commit>`에만 저장한다. `.part` 파일과 HTTP Range로 중단 다운로드를 재개하며, 완료된 파일은 Git tree의 크기와 Git blob SHA-1이 일치해야 사용한다. 대표 파일은 SHA-256도 manifest에 남긴다.

검사는 GLB magic, GLB/glTF 2.0 선언 길이, JSON·BIN chunk 경계, 내장 buffer, bufferView·accessor 범위, scene·node·mesh primitive를 확인한다. 대표 10종 모두 `KHR_draco_mesh_compression`과 내장 WebP 텍스처를 실제로 포함했다. 모델 간 애니메이션 구성은 일정하지 않았다. 대표 10종 중 810번만 애니메이션 클립 1개가 있었고 나머지는 0개였으며, 일부는 skin도 없다. 따라서 새 모델에 걷기·대기 애니메이션이 있다고 가정하면 안 된다. 이 검사는 정적 구조와 디코딩 요구사항을 확인할 뿐 시각 품질, 크기 정규화, 실제 렌더 성능을 증명하지 않는다.

`src/data/pokemon-models-manifest.json`에는 820종 전체의 고정 URL, 파일 크기와 Git blob SHA-1, 누락 54종, 대표 10종의 구조 검사와 SHA-256을 기록한다. 전체 모델을 애플리케이션에 복사하지 않으며 화면에 필요한 모델만 고정 raw URL에서 불러오는 카탈로그로 사용한다.

## 권리와 출처 한계

Pokemon-3D-api 저장소의 [README](https://github.com/Pokemon-3D-api/assets/blob/429de1288cea0d43f5b4f56305d2276e94239d65/README.md)는 파이프라인이 Sketchfab 원본을 받아 glTF Transform으로 Draco 압축하고 텍스처를 1024×1024 WebP로 바꾼다고 설명한다. 그러나 고정 커밋의 `scripts/model_map.json`은 빈 배열이라 모델별 Sketchfab 작성자, 원본 URL과 라이선스를 역추적할 수 없다.

저장소의 [MIT LICENSE](https://github.com/Pokemon-3D-api/assets/blob/429de1288cea0d43f5b4f56305d2276e94239d65/LICENSE)는 저장소 소프트웨어 조건으로 기록한다. 같은 README는 3D 모델이 Nintendo, Creatures Inc., GAME FREAK Inc.의 자산이라고 명시한다. MIT 문구만으로 모델 파일 재배포 권리가 확인됐다고 해석하지 않는다.

새 모델은 `data/local`의 제한 검사 캐시 외에 `public`, `dist`, S3 배포본으로 복사하지 않는다. 런타임은 소유 저장소의 고정 커밋 URL을 참조한다. 외부 배포·게시에서 이 모델을 실제로 사용하는 권리는 별도로 확인해야 한다. 고정 URL과 해시는 파일의 정체성과 변경 방지를 제공하지만 모델별 라이선스나 게임 실행 품질을 보증하지 않는다.
