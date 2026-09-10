# 포켓몬 데이터와 이미지 출처

이 프로젝트의 1세대 151종 데이터는 PokéAPI 데이터 저장소의 CSV를 변환한 것이다. 생성 시점에 확인한 저장소 커밋은 `src/data/source-manifest.json`의 `resolvedCommit`에, 사용한 각 CSV의 원본 URL·바이트 수·SHA-256은 같은 파일의 `csvFiles`에 기록한다. 데이터 저장소는 BSD 3-Clause 조건으로 제공되며, Pokémon과 캐릭터 이름은 Nintendo의 상표라는 고지가 원본 라이선스에 포함돼 있다.

- 데이터 저장소: https://github.com/PokeAPI/pokeapi
- 원본 라이선스: https://github.com/PokeAPI/pokeapi/blob/master/LICENSE.md
- CSV 원본: https://github.com/PokeAPI/pokeapi/tree/master/data/v2/csv

`scripts/fetch-pokemon.ts`는 전국도감 ID 1~151의 기본 폼만 선택한다. 한국어·영어 종명과 기술명은 PokéAPI 언어 테이블을 사용한다. 타입과 종족값, 기술의 타입·위력·명중률·PP·분류·우선도·상태이상 확률, 타입 상성은 생성 시점의 PokéAPI 현재값이다. 명중률·위력이 원본에서 비어 있는 기술은 계약의 숫자 필드에 맞춰 `0`으로 보존한다. `0`은 실패 확률이나 무위력 판정이 아니라 원본의 `null`(예: 반드시 명중하거나 직접 피해를 주지 않음)을 나타낸다.

레벨업 기술은 각 종이 지원하는 가장 최신의 전통적인 본가 버전 그룹을 선택한다. 우선순위는 Scarlet/Violet, Brilliant Diamond/Shining Pearl, Sword/Shield 확장 및 본편, Let's Go, Ultra Sun/Ultra Moon 순이며 이후 과거 본가 버전으로 내려간다. 종별 실제 선택 결과는 `src/data/source-manifest.json`의 `selection.learnsetVersionGroups`에 남긴다. 레벨 `0`은 PokéAPI가 진화 직후 배우는 기술에 사용하는 값이라 그대로 둔다.

진화는 151종 내부의 직접 진화만 포함한다. PokéAPI의 기본 진화 조건 가운데 최초로 기록된 전통 조건을 선택해 레벨, 진화의 돌 식별자, 통신교환으로 변환한다. 이후 세대 진화와 리전 폼은 151 범위 밖이므로 제외한다. 이 규칙으로 피카츄의 `thunder-stone`, 윤겔라·근육몬·데구리·고우스트의 통신교환, 이브이의 물·천둥·불꽃의 돌 분기가 유지된다.

전면·후면 PNG는 다음 공개 원본에서 `public/pokemon`에 내려받는다. `public/pokemon/manifest.json`에 원본 URL, 확인한 sprites 저장소 커밋, 파일별 SHA-256과 바이트 수가 있다.

- 전면: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{id}.png`
- 후면: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/back/{id}.png`
- 저장소 안내: https://github.com/PokeAPI/sprites/blob/master/README.md

sprites 저장소 README는 애플리케이션용 다운로드 방법과 이미지 기여자를 안내하지만 별도 오픈 라이선스를 명시하지 않는다. Pokémon 이미지와 명칭의 권리는 PokéAPI의 코드·데이터 라이선스와 별개다. 이 캐시는 로컬 개발용이며, 외부 배포 전에 Nintendo, Creatures, Game Freak 및 개별 기여 이미지의 사용 권리를 다시 확인해야 한다.

재생성은 `npm run data:pokemon`으로 실행한다. 다운로드는 동시 요청 6개로 제한하며 `src/data/.cache/pokeapi`와 이미 존재하는 PNG를 체크섬 검증 후 재사용한다. 두 manifest에 기록된 불변 커밋을 사용하므로 실행할 때마다 최신 master를 섞지 않는다. 캐시 내용이 체크섬과 다르면 기존 원본을 덮어쓰지 않고 실패한다. `npm run data:pokemon -- --verify-upstream`은 커밋을 고정한 원본과 모든 CSV·PNG 캐시를 다시 내려받아 바이트 단위 해시로 대조한다. 2026-09-10에 이 대조를 실행해 통과했다.

기술의 변화량·회복률·흡수/반동률·대상·효과 식별자·연타 횟수는 원본 `move_meta.csv`, `move_meta_stat_changes.csv`, `moves.csv`에서 가져온다. 이 필드는 게임 규칙에서 지원하는 효과를 계산하는 근거이며, 데이터가 있다는 사실만으로 본가의 모든 기술 효과를 재현했다고 주장하지 않는다. 원본 데이터 라이선스 전문은 `public/data/POKEAPI-LICENSE.txt`에 보존한다.
