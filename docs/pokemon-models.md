# Pokémon 3D 모델 출처와 사용 범위

`public/models/pokemon/{id}.glb`의 151개 regular-form 모델은 공개 저장소 [06wj/pokemon](https://github.com/06wj/pokemon)의 commit [`00d96f7f18894055e7f1db44fa0df6462e5e4c8a`](https://github.com/06wj/pokemon/tree/00d96f7f18894055e7f1db44fa0df6462e5e4c8a)에 고정했다. 해당 README는 151개 regular model과 869개 animation clip, skeletal animation, embedded texture를 포함하는 self-contained GLB라고 설명한다.

## 재현과 검증

```powershell
# 스타터 3종과 피카츄를 먼저 확인
npx tsx scripts/fetch-pokemon-models.ts --ids 1,4,7,25 --concurrency 4

# 151종 전체
npx tsx scripts/fetch-pokemon-models.ts --all --concurrency 6
```

원본은 `data/local/pokemon-models/<commit>/`에 먼저 저장한다. 중단되면 `.part` 바이트부터 HTTP Range로 재개한다. 완료된 원본은 GitHub tree의 파일 크기와 Git blob SHA-1이 모두 맞아야 재사용하며, 배포 경로에는 SHA-256이 같은 파일만 둔다. `manifest.json`에는 각 파일의 pinned URL, 바이트 수, Git blob SHA-1, SHA-256과 GLB 검사 결과를 저장한다.

검사는 확장자만 믿지 않는다. GLB magic, version 2, 선언 길이, JSON/BIN chunk 범위, 단일 내장 buffer, bufferView·accessor 범위, scene, node, mesh primitive, skin, animation, embedded PNG/JPEG/WebP image를 직접 읽는다. Draco mesh extension이 있으면 실패한다. 이 검사는 정적 파일 구조 검사이며 Blender import, animation 재생, 재질의 시각적 정확성 또는 게임 프레임 성능을 증명하지 않는다.

## 권리 범위

저장소의 `LICENSE`는 저장소 코드에 MIT 조건을 제시한다. 그러나 [원본 README의 Asset credits](https://github.com/06wj/pokemon/tree/00d96f7f18894055e7f1db44fa0df6462e5e4c8a#asset-credits)는 이 프로젝트가 비공식이며 Pokémon 캐릭터와 관련 자산은 각 권리자에게 속하고, 저장소가 그 자산에 대한 권리를 부여하지 않는다고 명시한다. 이 작업은 사용자가 요청한 로컬 팬게임 제작과 검증 범위에만 사용한다. 외부 배포·게시·재배포 권리는 확인되지 않았으므로 별도 권리 검토 없이 배포하지 않는다.
