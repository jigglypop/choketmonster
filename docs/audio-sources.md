# 오디오 출처와 사용 범위

## 현재 런타임 오디오

배경 음악 파일은 저장소와 배포 번들에 포함하지 않는다. 사용자가 합법적으로 보유한 원곡 오디오 파일을 직접 선택하면 브라우저가 IndexedDB의 `choketmon-local-music-v1` 저장소에 Blob으로 보관한다. 파일은 서버로 업로드하거나 다른 사용자와 공유하지 않는다.

- 처음에는 상단의 `BGM 선택`을 누르고 MP3, M4A, AAC, OGG, WAV, FLAC 파일을 선택한다. 이후 파일 변경과 제거는 화면 설정의 `BGM 파일`에서 한다.
- 저장된 파일은 다음 방문에 복원되며 첫 게임 클릭·터치·키 입력에서 재생을 요청한다. 곡은 반복 재생되고 기존 음악 음량·전체 음소거 설정을 공유한다.
- 사용자가 `BGM 정지`를 누르면 이후 게임 입력이나 탭 복귀가 음악을 다시 켜지 않는다. `BGM 재생`을 눌러야 다시 시작한다.
- 브라우저의 자동 재생 차단, 지원하지 않거나 손상된 파일, 파일 읽기 실패, 기기 저장 실패를 화면 안에 구분해 표시한다. Blob URL은 파일 교체·제거와 화면 종료 때 해제한다.
- 테스트에서 생성하는 WAV는 저장·재생 흐름을 확인하는 fixture일 뿐 원곡이나 배포 음원이 아니다.

## 포켓몬 울음소리

`src/audio/game-audio.ts`는 등장·개체 선택 시 PokeAPI/cries의 종별 OGG를 요청하고 Web Audio로 디코딩한다. 원본 커밋은 `ef687b18f0ce17169b4b4c09175819f7ade92f0f`로 고정하며 메모리에 최대 32종을 보관한다. 소스 URL은 `https://raw.githubusercontent.com/PokeAPI/cries/ef687b18f0ce17169b4b4c09175819f7ade92f0f/cries/pokemon/latest/{speciesId}.ogg`이다. 울음소리 파일은 로컬 배포 번들에 포함하지 않는다.

- API 문서: https://pokeapi.co/docs/v2
- 파일 저장소: https://github.com/PokeAPI/cries
- 저장소 라이선스 원문: https://raw.githubusercontent.com/PokeAPI/cries/main/LICENSE

해당 저장소는 Showdown과 Veekun을 파일 출처로 설명하며, 라이선스 첫 줄에 오디오의 저작권자가 The Pokémon Company라고 명시한다. 저장소의 CC0 표기를 포켓몬 오디오 자체에 대한 권리 양도로 해석하지 않는다. 원곡·울음소리는 이 프로젝트의 창작물이나 자체 녹음으로 표시하지 않는다.

## 자체 제작 효과음

공격·포획·승리·회복·선택 효과음만 Web Audio 오실레이터로 합성한다. 이 효과음은 원작 녹음이 아닌 자체 구성이다. 음원 처리와 렌더링은 게임 시뮬레이션 난수를 소비하지 않는다.
