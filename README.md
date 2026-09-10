# choketmonster · 초켓몬스터

실제 포켓몬 **001 이상해씨부터 151 뮤까지** 만나고, 잡고, 키우고, 진화시키는 로컬 팬 게임이다. 포켓몬마다 실제 초파리 커넥톰의 부분 회로와 독립적인 신경 상태를 연결한다. 작업은 Astra가 통합하고 Sol medium이 범위가 나뉜 구현을 담당한다.

현재 검증된 3D 필드를 바탕으로 Gaesup World 오픈월드와 AWS 배포를 진행한다. [수정한 계획과 완료 조건](docs/openworld-plan.md)을 따른다. 포켓몬 3D/스프라이트 바이너리는 Git에 포함하지 않으며 공개 빌드는 고정한 원본 CDN URL을 사용한다.

## 실행

Node.js 22.13 이상에서 실행한다. 이 작업의 실행 환경은 Windows, Node 24.15.0이다.

```powershell
npm ci
npm run data:pokemon
npx tsx scripts/fetch-pokemon-models.ts --all --concurrency 6
npm run dev
```

브라우저에서 **http://127.0.0.1:5173** 을 연다. 기본 데이터와 포켓몬 이미지 302개, 실제 커넥톰 부분 회로를 로컬에 포함하므로 플레이 중 외부 API·계정·유료 서비스가 필요 없다. 개발 서버가 출력한 포트가 다르면 그 주소를 사용한다.

## 모험

- 이상해씨·파이리·꼬부기 중 첫 친구를 고른다. 다른 친구는 모험에서 얻는다.
- 방향키·WASD·화면 이동 버튼으로 걷거나 탐색 버튼을 눌러 야생 포켓몬을 만난다.
- 기술의 타입·위력·PP와 HP를 확인해 배틀한다. 몬스터볼로 포획하고, 친구를 교체하거나 도망갈 수 있다.
- 파티는 6마리까지 함께하며 나머지는 보관함에 머문다. 경험치와 이상한사탕으로 레벨을 올리고 파티에서 진화 조건을 확인한다.
- 진화의 돌은 상점에서 산다. 교환 계열은 게임 내 통신케이블로 혼자서 진화시킨다. 진화 후에도 같은 개체의 신경 기억이 이어진다.
- 무료 치료소에서 HP·PP를 회복한다. 탐험과 배틀의 보상으로 볼·회복약·진화 도구를 준비한다.
- 체육관 8개를 순서대로 이기면 모든 지역과 챔피언 도전이 열린다. 도감에서 151종의 발견·포획과 출현 지역을 확인한다.

포켓몬 자체의 이름·그림·능력치·기술·진화 자료는 PokéAPI에서 가져왔다. 지역과 진행 구조는 창작이며, 배틀은 현대 타입과 물리/특수 분류를 사용하는 축약 규칙이다. 본가 게임 전체나 게임 ROM을 재현한 것은 아니다. [포켓몬 자료와 출처](docs/pokemon-sources.md), [지원하는 게임 규칙](docs/game-rules.md)을 확인한다.

## 실제로 연결한 뇌

[MaleCNS v1.0](https://male-cns.janelia.org/download/)의 공식 원본 3개를 내려받아 SHA-256을 확인했다. DNa02 좌우 뉴런과 직접 연결된 뉴런 중 128개를 선택했고, 이들 사이의 실측 연결 3,623개를 보존했다. 이는 시냅스 88,574개에 해당한다. 전체 초파리 뇌가 아니다.

상대 포켓몬과 내 포켓몬의 자동 행동은 `src/game/connectome.ts`에서 이 회로를 사용한다. 12개 배틀 관찰값 → 4회 순환 신경 계산 → 기술 슬롯 4개/대기로 연결한다. 감각에서 출력으로 바로 가는 우회 연결은 껐다. 입력 투영·동역학·행동 출력·보상 학습은 게임용 설계다. ‘경험 학습’을 끄면 학습 가중치는 고정된다.

같은 체크포인트에서 실측 연결만 0으로 만든 비교에서는 768개 선택 중 102개가 달라졌다. 평가 중 가중치 고정과 정확한 재현, 151종의 독립 상태도 확인했다. 이 결과는 회로가 실제 계산에 쓰인다는 근거이며 생물학적 학습이나 게임 실력의 증거가 아니다. [실험 근거](docs/game-neural-evidence.md), [제한된 배틀 비교](docs/battle-benchmark.md), [원본·변환 기준](docs/connectome-source.md).

## 저장과 복원

진행과 개체별 기억은 브라우저 IndexedDB에 자동 저장한다. 저장 파일 내보내기/불러오기로 기기를 옮길 수 있다. 그래프 구조는 파일 안에 한 번만 저장한다. 배틀 도중의 HP·PP·난수·신경 상태도 복원한다. 새 모험과 불러오기 전에 기존 기록을 백업한다. 예전 3종 합성 프로토타입의 localStorage 기록은 별도로 보존한다.

## 검증과 재생성

변경한 범위에 맞는 검사만 실행한다. UI 변경이 없는 작업에서 브라우저 검사를 반복할 필요는 없다.

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run check:neural
npx tsx scripts/battle-experiment.ts
```

```powershell
# 로컬 캐시·체크섬을 사용한 데이터 재생성
npm run data:pokemon
# 고정한 원본 커밋과 모든 캐시를 다시 비교
npm run data:pokemon -- --verify-upstream
# 약 1.1 GB 원본을 재사용/재개하며 실제 회로 재생성
npm run data:connectome
```

이전 합성 채집 과제의 `npm run experiment`와 `npm run replay -- <replay.json>`은 별도 실험으로 유지한다. 그 결과를 현재 포켓몬 배틀의 성능으로 해석하지 않는다. [기존 기준 실험](docs/baseline.md).

## 작업 안내

- [기능별 완료 조건](docs/delivery-plan.md)
- [아이디어와 과학적 범위](docs/feasibility.md)
- [짧은 한글 작업 지침과 실행 권한](AGENTS.md)
- [Astra + Sol medium 역할 분담](docs/model-routing.md)
- [하네스 정비 기록](docs/harness-audit.md)

`src/game/`는 포켓몬 규칙·저장·회로 연결, `src/data/`는 검증한 자료, `src/main.ts`는 화면, `scripts/`는 변환·실험·재현 명령이다. 이미지·이름의 권리는 해당 권리자에게 있다. PokéAPI 데이터 라이선스 전문은 `public/data/POKEAPI-LICENSE.txt`에 보존한다. 외부 배포는 이 로컬 작업의 범위에 포함하지 않았다.
