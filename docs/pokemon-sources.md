# 포켓몬 데이터와 이미지 출처

이 프로젝트의 포켓몬 데이터는 PokéAPI 데이터 저장소의 CSV를 로컬에서 변환한 것이다. 현재 고정한 데이터 커밋은 `8fe210b21c9abbe73de93670f3d5a346c80a3625`이며, 전국도감 1~1025의 모든 종을 포함한다. 각 종에는 `pokemon.csv`에서 `is_default=1`인 기본 개체 하나를 연결한다. 한국어·영어 이름, 타입, 종족값, 포획률, 성장률, 경험치, 키, 레벨업 기술과 표현 가능한 진화 정보를 생성한다.

- 데이터 저장소: https://github.com/PokeAPI/pokeapi
- 원본 라이선스: https://github.com/PokeAPI/pokeapi/blob/master/LICENSE.md
- CSV 원본: https://github.com/PokeAPI/pokeapi/tree/master/data/v2/csv
- PokéAPI 리소스 정의: https://pokeapi.co/docs/v2

정확한 원본 URL, 바이트 수와 SHA-256은 `src/data/source-manifest.json`에 기록한다. 데이터 저장소는 BSD 3-Clause 조건으로 제공되며, 라이선스 전문은 `public/data/POKEAPI-LICENSE.txt`에 보존한다. Pokémon과 캐릭터 이름은 Nintendo의 상표라는 고지도 원본 라이선스에 포함돼 있다.

`src/data/pokemon.ts`의 `POKEMON`, `getSpecies`, `MOVES`, `getMove` 인터페이스는 기존과 같다. `POKEMON`은 전국도감 ID 순서의 1025종이다. 레벨업 기술은 각 기본 개체에 실제 행이 있는 가장 최신 버전 그룹을 `version_groups.order`로 골라 생성한다. 위력·명중률이 원본에서 비어 있으면 기존 숫자 계약에 맞춰 0으로 보존하며, 이는 반드시 실패하거나 위력이 없다는 뜻이 아니라 원본 null을 나타낸다.

경험치는 `experience.csv`의 여섯 성장 곡선과 레벨 1~100 누적값을 `src/data/pokemon-experience.ts`에 그대로 생성한다. PokéAPI 식별자는 `slow-then-very-fast`(통상 Erratic)와 `fast-then-very-slow`(통상 Fluctuating)를 사용한다. 게임과 서버는 수식 재구현 대신 이 표를 조회할 수 있다.

진화는 단순 레벨, 도구, 교환 조건만 기존 메서드로 변환한다. 친밀도·시간대·성별·장소·기술·파티 구성 등 복합 조건이나 별도 트리거가 있는 행은 `method: "special"`과 원본 필드 기반 `requirement`로 보존한다. 게임은 이를 자동 진화 조건으로 단순화하지 않는다. 따라서 리전 폼, 특수 진화와 이후 세대 진화 대상도 데이터에는 남지만, 아직 구현하지 않은 조건은 UI에서 야생 포획 등 다른 획득 경로를 안내해야 한다.

## 버전 도감과 폼 범위

`src/data/pokemon-versions.ts`에는 고정 커밋의 버전 53개, 버전 그룹 32개, 도감 35개와 폼 1579개가 있다.

- `POKEMON_VERSIONS` / `VERSIONS`: 게임 버전별 ID, 이름, 세대, 버전 그룹, 연결 도감, 종 ID
- `getPokemonVersion(id)`: 버전 메타데이터
- `getVersionSpeciesIds(id)`: 버전 도감 종 ID. 가상 ID `national`은 1025종 전체
- `getVersionSpecies(id)`: 버전 도감의 `PokemonSpecies[]`
- `getPokedexEntries(id)`: 해당 지역 도감 번호와 전국도감 종 ID
- `POKEMON_FORMS` / `getPokemonForms(speciesId)`: 기본·외형·리전·메가·배틀 전용 폼 목록과 가능한 이미지

버전별 종 목록은 `pokedex_version_groups.csv`와 `pokemon_dex_numbers.csv`의 조인이다. 한 버전 그룹에 여러 지역 도감이 있으면 합집합을 사용한다. 이는 그 버전의 도감 수록 범위이며 실제 야생 출현표가 아니다. 각 버전 객체의 `basis`가 `regional-pokedex`인지 `no-pokedex-data`인지 표시하고, `source`는 `pokeapi-csv`로 표시한다. 게임이 이 목록을 자체 조우에 배치하면 본가의 실제 출현 정보로 설명하면 안 된다.

`pokemon_forms.csv`의 모든 행을 보존한다. 여기에는 순수 외형 차이뿐 아니라 알로라·가라르·히스이·팔데아 모습, 메가진화, 거다이맥스, 배틀 전용 폼과 별도 능력치를 가진 Pokémon 변형이 함께 있다. 핵심 전투 데이터는 종별 기본 개체를 계속 사용하므로 폼 목록이 있다고 해서 모든 폼의 별도 타입·능력치·기술이 전투에 적용됐다는 뜻은 아니다.

## 이미지와 재생성

전면·후면 이미지는 PokéAPI sprites 저장소의 고정 커밋 `2ecb4eeacd5a1718621fc30f12772e3f60d830b9`에서 내려받는다. 기본·변형 Pokémon ID 파일과 `scripts/forms.json`이 가리키는 `25_1` 같은 외형 파일을 모두 시도한다. 현재 요청 파일 3406개 중 원본에 존재하는 2684개를 `public/pokemon`과 `public/pokemon/back`에 저장했다. 폼별로 매핑 파일을 먼저 쓰고, 없으면 해당 Pokémon ID 이미지를 쓴다. 두 경로 모두 원본에 없으면 `frontSprite` 또는 `backSprite`를 null로 보존한다.

- 이미지 저장소와 구조: https://github.com/PokeAPI/sprites
- 이미지 라이선스 파일: https://github.com/PokeAPI/sprites/blob/master/LICENCE.txt
- 폼 매핑: https://github.com/PokeAPI/sprites/blob/master/scripts/forms.json

`public/pokemon/manifest.json`에는 요청·성공·누락 수, 원본 URL, 파일별 SHA-256과 바이트 수가 있다. sprites 저장소의 라이선스 전문은 `public/data/POKEAPI-SPRITES-LICENCE.txt`에 보존한다. 이 파일은 저장소 배포 조건을 CC0로 밝히는 동시에 이미지 내용의 저작권이 The Pokémon Company에 있다고 명시한다. 외부 배포 전에는 Nintendo, Creatures, Game Freak, The Pokémon Company와 기여 이미지의 실제 사용 권리를 다시 확인한다.

`npm run data:pokemon`으로 재생성한다. 원본 커밋은 manifest에 고정되어 최신 master 변경을 자동으로 섞지 않는다. CSV와 이미지 캐시는 기존 SHA-256을 검증한 뒤 재사용한다. 진행 중 파일은 `.part`에 저장하고 서버가 Range 요청을 지원하면 중단 지점부터 재개하며, 완성된 파일만 원래 이름으로 바꾼다. `--verify-upstream`은 고정 URL을 다시 받아 캐시와 비교한다. 원본 404로 확인된 선택 이미지 방향은 누락으로 기록하며 전체 생성을 실패시키지 않는다.

서버 저장 검증용 `rust-server/data/pokemon-validation.json`도 같은 실행에서 생성한다. 이 artifact는 1025종의 성장표·종족값·기술·진화 대상, 689개 기술의 PP, 실제 버전 53개와 `national`의 허용 종 ID를 담고, SHA-256을 데이터 manifest에 기록한다.
