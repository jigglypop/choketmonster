# choketmonster · 초켓몬스터

[게임 실행](https://chocketmon.com) · [지역 확장과 검증 기록](docs/expansion-delivery-2026-09-16.md) · [진화 조건과 상점](docs/evolution-shop.md)

PokéAPI의 포켓몬 1,025종 자료를 사용하는 팬 게임이다. 플레이 지도는 **성도·관동·호연·신오·하나**이며, 각 지방의 도시·도로 연결을 근거로 자체 3D 지형과 충돌을 구성했다. 1~649번 포켓몬의 기하 모델과 리깅 경로를 실행 검증했다. 그 이후 세대의 자료와 기존 보유 개체는 보존하며, 미검증 지방을 여행 선택지에 넣지 않는다. 기본 모습이 플레이 대상이고 추가 모습 자료는 열람용이다.

초파리 커넥톰에서 선택한 연결은 개체의 신경 정책 계산에 쓰인다. 감각 입력·신경 동역학·행동 출력·보상 학습은 게임용 설계다. 커넥톰을 완성된 뇌나 생물학적 학습의 증거로 설명하지 않는다. 각 개체는 별도의 회로 상태와 학습 기록을 유지한다.

## 실행

Node.js 22.13 이상, pnpm을 사용한다.

```powershell
npm ci
python scripts/restore-source-cache.py
pnpm dev --port 5173 --strictPort
```

프론트엔드는 터미널에서 실행하고 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)을 연다. 공개 원본 모델 URL을 사용하므로 인터넷 연결이 필요하다. 로컬 모델 캐시가 필요하면 `pnpm exec tsx scripts/fetch-pokemon-models.ts --all --concurrency 6`을 실행한다.

로그인·서버 저장을 개발할 때는 Rust와 PostgreSQL을 준비한 뒤 별도 터미널에서 `pnpm server:dev`를 실행한다. 기본 로컬 DB는 `data/local/postgres-server`(127.0.0.1:55432), Rust API는 8080이다. Vite는 `/api`를 이 서버로 전달한다.

## 플레이

- 성도 또는 관동 스타터를 선택한다. 성도 리그 → 관동 리그 → 호연 → 신오 → 하나 순서로 진행하며 각 지방에 체육관과 사천왕·챔피언이 있다.
- 방향키·WASD·터치로 파트너를 움직인다. 이동 입력 없이 3초가 지나면 자동 모드가 가까운 야생 포켓몬을 추적하고 배틀한다.
- 초파리 길잡이·목적지 카드·바닥 경로·미니맵이 다음 체육관과 리그를 안내한다. 입구에 권장 레벨과 배지 잠금을 표시한다.
- 기술은 횟수 제한 없이 사용한다. 팀·박스 또는 월드의 기술 배치에서 현재 레벨까지 배운 기술을 교체하고 순서를 정한다.
- 경험치 공유가 켜져 있으면 살아 있는 팀원이 같은 전투 경험치를 받는다. 자동 야생 전투는 건강한 팀원을 순환 출전시킨다.
- 이상한사탕은 수량과 예상 레벨을 확인하고 한 번에 먹인다. Lv.100과 보유량을 초과하면 소비하지 않는다.
- 중복 합치기는 남길 개체를 선택한다. 보내는 개체 레벨 합계의 20%를 내림해 적용하고, 남기는 개체의 경험치 진행률·회로 기억을 유지한다.
- 진화 화면에서 원본 조건, 현재 성장 기록, 실제 사용할 도구를 확인한다. 친밀도·아름다움·애정 간식을 판매하고, 전용 도구와 특수진화 캡슐로 특수 조건을 대체할 수 있다. [자세한 진화 규칙](docs/evolution-shop.md).
- 몬스터볼은 플레이 30초마다 1개씩 기본 보충 한도 20개까지 채운다. 볼이 없으면 자동 포획을 건너뛴다.

지상은 항상 낮 밝기로 표시하며 사람형 필드 NPC·안개·시계 UI를 사용하지 않는다. 풀·흙 텍스처, 그림자와 수면 효과는 유지하고 가까운 영역만 자세히 그린다. 동굴은 돌 바닥·외곽 암벽·종유석·석순과 열린 통로를 사용한다. 포켓몬 표시 크기는 이전 설정에서 18% 늘렸고 기본 이동 속도는 종족 속도식의 2.4배를 유지한다.

출현 원본은 관동 레드·성도 크리스탈·호연 에메랄드·신오 플래티넘·하나 블랙으로 고정한다. 원본에서 빠지는 종은 별도 희귀 추가 분포로 표시한다. 시간별 원본 출현 자료는 보존한다.

## 음악과 모델

기본 음악은 Chris Murphy(zesona)의 [Other Center](https://opengameart.org/content/other-center), CC0 게임용 반복 음악이다. `public/audio/other-center.mp4`를 첫 게임 입력 후 반복 재생한다. 사용자가 선택한 파일을 우선하고, 음량·음소거·파일 교체를 지원한다. 선택한 음악은 기기에 보관하며 서버에 업로드하지 않는다. 출처·체크섬·변환 기록은 `public/audio/music-sources.json`에 있다.

포켓몬 모델 원본은 고정한 공개 GitHub URL에서 읽는다. 골격·동작이 부족한 기하 모델에는 자체 골격·스킨 가중치·동작을 추가하며 원본 애니메이션과 구분한다. 이미지나 임시 도형을 검증된 포켓몬 모델로 세지 않는다. [모델·리깅 검증 범위](docs/expansion-delivery-2026-09-16.md).

## 저장과 복원

진행·성장 기록·개체별 회로 기억은 IndexedDB에 먼저 저장한다. 계정을 연결하면 로그인·로그아웃·자동저장·지금 저장에서 PostgreSQL과 동기화한다. 게스트와 계정별 저장을 분리하고 새 모험·불러오기·개체 합치기 전에 로컬 백업을 남긴다.

전투·포획 대기·야생 개체·재출현 대기·좌표와 난수 상태를 복원한다. 야생과 재출현 대기의 합이 12마리보다 작은 과거 저장은 검증 후 부족분을 보충한다. 기존 개체와 기억은 유지하고, 18마리 초과 등 잘못된 데이터는 거부한다.

서버 전체 회로가 준비되면 Rust에서 기술을 선택하고, 없으면 브라우저의 부분 회로를 사용한다. 큰 서버 신경 체크포인트는 별도 기기 캐시에 보관하며 계정 저장과 범위가 다르다.

## 검증과 배포

```powershell
pnpm exec vitest run --maxWorkers 2 --testTimeout 60000
npm run build
pnpm exec playwright test tests/ui/evolution-shop.spec.ts
pnpm exec tsx scripts/audit-all-evolutions.ts
pnpm exec tsx scripts/generate-evolution-rules.ts
```

`main`에 push하면 [GitHub Actions](.github/workflows/deploy.yml)가 검증·빌드 후 **Rust API → realtime → 정적 파일** 순서로 배포한다. 기존 AWS CLI·OIDC 배포 경로를 사용한다. 배포 완료는 Actions 성공과 [운영 version.json](https://chocketmon.com/version.json)의 커밋, API·저장 흐름으로 확인한다.

`prepare-deploy.ts`와 `deploy-ci.py`는 포켓몬 GLB·PNG 로컬 캐시와 ROM을 배포 묶음에서 제외한다. 출처를 보존하는 것과 재배포 권리는 구분한다. 포켓몬 이름·그림의 권리는 원 권리자에게 있으며, PokéAPI의 BSD-3-Clause 라이선스는 `public/data/POKEAPI-LICENSE.txt`에 보관한다.

작업 규칙은 [AGENTS.md](AGENTS.md), 게임 규칙과 저장은 `src/game/`, 출처 자료는 `src/data/`, 월드는 `src/openworld/`, 변환·검증·배포 명령은 `scripts/`에서 관리한다.
