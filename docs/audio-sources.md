# 오디오 출처와 사용 범위

## 현재 런타임 오디오

배경 음악은 `src/audio/original-music.ts`의 화면에 보이는 YouTube 플레이어로 재생한다. 곡은 금·은·크리스탈의 챔피언/레드전 음악이며, 영상 제목은 “Champion/Red Battle - Pokémon Gold/Silver/Crystal Soundtrack”, 업로더는 DaintiiMusic이다. 공식 채널의 업로드라고 표시하지 않는다. OST 파일을 저장소나 배포 번들에 복사하지 않는다.

- 영상: https://www.youtube.com/watch?v=mbffVF79imM
- 플레이어 API: https://developers.google.com/youtube/iframe_api_reference
- 사용자 동작 후 재생을 요청하며 자동 재생 제한 시 재생 버튼을 표시한다. 플레이어를 닫거나 탭이 숨겨지면 일시 정지한다. 플레이어 크기는 최소 200×200이며 음량·음소거 설정을 저장한다. 서비스 차단이나 영상 제한 시 상태와 원본 링크를 표시한다.

## 포켓몬 울음소리

`src/audio/game-audio.ts`는 등장·개체 선택 시 PokeAPI/cries의 종별 OGG를 요청하고 Web Audio로 디코딩한다. 원본 커밋은 `ef687b18f0ce17169b4b4c09175819f7ade92f0f`로 고정하며 메모리에 최대 32종을 보관한다. 소스 URL은 `https://raw.githubusercontent.com/PokeAPI/cries/ef687b18f0ce17169b4b4c09175819f7ade92f0f/cries/pokemon/latest/{speciesId}.ogg`이다. 울음소리 파일은 로컬 배포 번들에 포함하지 않는다.

- API 문서: https://pokeapi.co/docs/v2
- 파일 저장소: https://github.com/PokeAPI/cries
- 저장소 라이선스 원문: https://raw.githubusercontent.com/PokeAPI/cries/main/LICENSE

해당 저장소는 Showdown과 Veekun을 파일 출처로 설명하며, 라이선스 첫 줄에 오디오의 저작권자가 The Pokémon Company라고 명시한다. 저장소의 CC0 표기를 포켓몬 오디오 자체에 대한 권리 양도로 해석하지 않는다. 원곡·울음소리는 이 프로젝트의 창작물이나 자체 녹음으로 표시하지 않는다.

## 자체 제작 효과음

공격·포획·승리·회복·선택 효과음만 Web Audio 오실레이터로 합성한다. 이 효과음은 원작 녹음이 아닌 자체 구성이다. 음원 처리와 렌더링은 게임 시뮬레이션 난수를 소비하지 않는다.
