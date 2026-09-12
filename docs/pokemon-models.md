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
| 기존 관동을 뺀 추가 지원 | 820종 · 305,962,400바이트 |
| 배포 카탈로그에 없는 종 | 54종 |

성별 파일만 있는 세 종은 male 파일을 기본 표시로 선택한다. 정확한 누락 ID는 `src/data/pokemon-models.ts`의 `MISSING_POKEMON_MODEL_IDS`와 `src/data/pokemon-models-manifest.json`에 기록한다.

| 세대 | 전국도감 범위 | 확보 모델 | 누락 |
| --- | --- | ---: | ---: |
| 1 | 1–151 | 기존 151 | 0 |
| 2 | 152–251 | 100 | 0 |
| 3 | 252–386 | 135 | 0 |
| 4 | 387–493 | 107 | 0 |
| 5 | 494–649 | 156 | 0 |
| 6 | 650–721 | 72 | 0 |
| 7 | 722–809 | 88 | 0 |
| 8 | 810–905 | 79 | 17 |
| 9 | 906–1025 | 83 | 37 |

따라서 기존 원격 카탈로그의 **캐릭터 모델** 기준으로 1~7세대 포켓몬은 전종 지원된다. 이는 캐릭터 세대 지원 범위이며, 실제 지역 맵의 보유·지원 범위와는 별개다. 8·9세대의 나머지 54종은 아래 연구용 원본에서 기하 모델을 확인했지만 배포 권리와 텍스처 완결성이 확인되지 않아 게임의 원격 카탈로그에는 넣지 않는다.

`src/data/pokemon-models.ts`는 다음 API를 제공한다.

- `hasPokemonModel(id)`: 관동 기존 모델 또는 새 regular 모델이 있는지 확인
- `getPokemonModelSource(id)`: 고정 URL, GLB 형식, Draco 필요 여부, 텍스처 형식, 저장소·커밋·원본 경로와 바이트 수 반환
- `EXPANDED_POKEMON_MODEL_IDS`: 152~1025에서 지원되는 820종
- `MISSING_POKEMON_MODEL_IDS`: 현재 허용 원본에 없는 54종
- `EXPANDED_NON_DRACO_MODEL_IDS`, `EXPANDED_NON_WEBP_MODEL_IDS`: 실제 전체 검사에서 확인한 형식 예외

151번 이하는 기존 06wj URL과 `requiresDraco: false`를 반환한다. 이후 지원 종은 Pokemon-3D-api의 고정 raw URL을 반환한다. 실제 검사 결과 820개 모두 `KHR_draco_mesh_compression`을 사용한다. 810개는 내장 WebP 텍스처이며 187·201·328·343·358·378·379·871·907·913번 10개는 저장소 설명과 달리 전부 WebP가 아니므로 `textureEncoding`을 선언하지 않는다. 원격 저장소의 main 브랜치를 런타임에 해석하지 않는다.

## 전체 다운로드와 검사

사용자가 확보를 요청한 152번 이후 820개 모델을 전부 `data/local/pokemon-models-expanded/429de1288cea0d43f5b4f56305d2276e94239d65`에 다운로드했다. 실제 파일 수는 820개, 합계는 305,962,400바이트이고 남은 `.part` 파일은 없다. 이 폴더는 로컬 원본 캐시이며 Git과 배포 산출물에서 제외된다.

```bash
# 152번 이후 존재하는 820종 전체 다운로드·검사
npx tsx scripts/fetch-expanded-models.ts --all --concurrency 6

# 일부 종만 제한 검사
npx tsx scripts/fetch-expanded-models.ts --ids 152,252

# 다운로드 없이 고정 tree로 카탈로그 재생성
npx tsx scripts/fetch-expanded-models.ts --catalog-only
```

동시성은 기본 6, 최대 8로 제한한다. `.part` 파일과 HTTP Range로 중단 다운로드를 재개하며, 완료된 파일은 Git tree의 크기와 Git blob SHA-1이 일치해야 재사용한다. 이미 검증된 파일은 다시 받지 않고, 다른 내용의 완료 파일을 덮어쓰지 않는다.

검사는 820개 각각에 대해 GLB magic, GLB/glTF 2.0 선언 길이, JSON·BIN chunk 경계, 내장 buffer, bufferView·accessor 범위, scene·node·mesh primitive, Draco 사용, 텍스처 MIME을 확인하고 SHA-256을 manifest에 기록한다. 820개 모두 구조 검사를 통과했다. 466개가 skin을 포함하고 114개가 하나 이상의 애니메이션을 포함한다. 모델마다 애니메이션 구성이 다르므로 걷기·대기 클립의 존재나 이름을 가정하면 안 된다. 이 검사는 정적 구조와 디코딩 요구사항을 확인할 뿐 시각 품질, 크기 정규화, 실제 렌더 성능을 증명하지 않는다.

`src/data/pokemon-models-manifest.json`에는 820종 전체의 고정 URL, 파일 크기, Git blob SHA-1, 로컬 SHA-256, 구조 검사, 누락 54종을 기록한다. 전체 모델을 `public`이나 애플리케이션에 복사하지 않으며 화면에 필요한 모델만 고정 raw URL에서 불러오는 카탈로그로 사용한다.

## 누락 54종의 대체 원본 조사

같은 Pokemon-3D-api 저장소의 shiny·regional·special 카테고리와 이전 저장소 [Sudhanshu-Ambastha/Pokemon-3D](https://github.com/Sudhanshu-Ambastha/Pokemon-3D)를 고정 tree에서 비교했지만 누락 54종의 regular 대체 모델은 없었다. 이전 저장소는 현재 저장소와 같은 자산 계열이다.

[Lilothestitch16/Pokemon-HOME-GLB-Models](https://github.com/Lilothestitch16/Pokemon-HOME-GLB-Models)의 고정 커밋 `27703273836f38f0e185976d955b1fbfb15448af`에는 GLB·glTF 6,070개와 전국도감 1,025종이 있어 누락 54종을 파일명상 모두 채운다. 공개 원본 조사 권한에 따라 이 54개만 `data/local/pokemon-models-research/<commit>`에 내려받아 검사했다. 합계는 30,275,196바이트이고 다운로드·검증 성공 54건, 실패 0건, 남은 `.part` 0개다.

텍스처를 별도로 대조한 결과, 고정 커밋의 전체 파일은 `.bin`, `.glb`, `.gltf`가 각각 3,035개이며 PNG·JPEG·WebP·KTX·DDS·TGA·BMP·GIF 파일은 0개다. 선택한 54개 GLB에는 material 312개와 이름은 있지만 `images`, `textures`, 외부 이미지 URI, material texture 참조는 모두 0개다. 이름만으로 대응 텍스처를 추정할 수 없고 저장소에도 연결 가능한 이미지가 없으므로 추가 텍스처는 내려받지 않았다. 종별 material 이름과 검사 수치는 연구 manifest에 기록했다.

`scripts/fetch-home-models-research.ts`는 비희귀 `pmNNNN_00_00.glb`를 기본형으로 선택한다. 이 이름이 없는 854·863·864·866·931·964·1012·1013·1024번은 가장 낮은 비희귀 폼 코드를 선택하고 실제 경로와 선택 사유를 `src/data/pokemon-home-research-manifest.json`에 남긴다. 54개 모두 Git blob SHA-1, SHA-256, GLB/glTF 2.0, 내장 binary buffer, scene·mesh·skin 구조 검사를 통과했다. 전부 skin이 있지만 애니메이션은 0개, Draco 압축도 0개, GLB 내부 이미지도 0개다. 따라서 3D 기하와 rig는 확보됐지만 이 파일만으로 텍스처와 동작까지 완결된 게임 모델이라고 판단할 수 없다.

```bash
npx tsx scripts/fetch-home-models-research.ts
```

이 명령도 동시 다운로드를 6개로 제한하고 `.part`와 HTTP Range를 사용한다. 완료 파일은 고정 tree의 크기와 Git blob SHA-1을 확인한 뒤 재사용한다.

저장소 설명은 이 모델을 Pokémon HOME에서 추출했다고 명시하며 고정 커밋에는 README와 라이선스 파일이 없다. 연구용 로컬 다운로드가 모델 재배포 권리를 만들지는 않는다. 이 54개는 `public`, `dist`, S3, `hasPokemonModel`과 런타임 URL 카탈로그에 넣지 않는다.

[dnnyngyen/codex-pokepets](https://github.com/dnnyngyen/codex-pokepets)가 “3D”로 소개하는 전 세대 자산은 Pokémon Showdown의 렌더 애니메이션 이미지로, 회전 가능한 GLB/glTF 기하 모델이 아니다. 게임의 3D 모델 요구사항을 충족하지 않아 대체 원본에서 제외했다.

이 조사로 “3D 파일 자체가 없음”은 해소됐다. 54종 모두 연구 캐시에 실제 기하 파일이 있다. 다만 원본 게임 추출물이 아니고 파일별 출처·사용 조건과 텍스처를 확인할 수 있는 대체 GLB/glTF 묶음은 찾지 못했다. 따라서 배포 가능한 게임 카탈로그 범위는 971종으로 유지한다.

## 권리와 출처 한계

Pokemon-3D-api 저장소의 [README](https://github.com/Pokemon-3D-api/assets/blob/429de1288cea0d43f5b4f56305d2276e94239d65/README.md)는 파이프라인이 Sketchfab 원본을 받아 glTF Transform으로 Draco 압축하고 텍스처를 1024×1024 WebP로 바꾼다고 설명한다. 그러나 고정 커밋의 `scripts/model_map.json`은 빈 배열이라 모델별 Sketchfab 작성자, 원본 URL과 라이선스를 역추적할 수 없다.

저장소의 [MIT LICENSE](https://github.com/Pokemon-3D-api/assets/blob/429de1288cea0d43f5b4f56305d2276e94239d65/LICENSE)는 저장소 소프트웨어 조건으로 기록한다. 같은 README는 3D 모델이 Nintendo, Creatures Inc., GAME FREAK Inc.의 자산이라고 명시한다. MIT 문구만으로 모델 파일 재배포 권리가 확인됐다고 해석하지 않는다.

새 모델은 `data/local`의 검사 캐시 외에 `public`, `dist`, S3 배포본으로 복사하지 않는다. 런타임은 소유 저장소의 고정 커밋 URL을 참조한다. 외부 배포·게시에서 이 모델을 실제로 사용하는 권리는 별도로 확인해야 한다. 고정 URL과 해시는 파일의 정체성과 변경 방지를 제공하지만 모델별 라이선스나 게임 실행 품질을 보증하지 않는다.
