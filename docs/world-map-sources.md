# 지역 3D 맵 원본 조사

조사일: 2026-09-14

## 판정

**이번 공개 자료 조사에서는 그대로 번들할 수 있는 독립 3D 성도(Johto) 플레이 맵 파일을 확보하지 못했다.** 이 결과는 성도 재구성을 막지 않는다. 관동과 같은 방식으로 도시·도로의 상대 배치와 연결 정보를 근거로 삼고, 프로젝트가 사용 가능한 CC0 또는 자체 지형 요소로 새 3D 지형을 만들 수 있다. P3D-Legacy는 구조 교차 확인에만 쓰며 그 전용 `.dat`, 텍스처, 포켓몬 파생 미술은 게임 자산으로 복제하지 않는다.

성도 이후 지역도 같은 기준을 충족하는 파일을 확보하지 못했다. 따라서 아래 후보를 게임의 지원 지역 또는 확보 자산으로 세면 안 된다. 이 조사는 모델이 검색되거나 뷰어에서 보이는 것과 프로젝트가 파일을 합법적으로 확보해 배포할 수 있는 것을 구분한다.

## 외부 완성 맵 직접 채택 기준과 확인 방법

채택하려면 다음 조건을 모두 만족해야 한다.

- 도시와 도로를 실제로 이동할 수 있는 환경 메시여야 한다. 단일 건물, 캐릭터, 배지, 조형물, 벽걸이 부조는 제외한다.
- GLB, glTF, OBJ 또는 FBX 원본이나 변환본을 로그인과 결제 없이 직접 받을 수 있어야 한다.
- 제작자와 라이선스가 명시되고, 게임에 수정·포함·재배포할 수 있어야 한다.
- ROM 추출이나 사용자가 별도로 보유한 상용 게임 파일을 요구하지 않아야 한다.
- 파일 크기, 형식, 메시 범위, 애니메이션 유무를 내려받은 파일에서 검증할 수 있어야 한다.

지도 정보 기반 자체 재구성은 별도 기준을 적용한다. 출처가 확인되는 도시·도로 그래프를 근거로 삼되 타 프로젝트의 텍스처나 미술 배치를 복사하지 않고, 현재 프로젝트의 사용 가능한 지형 요소로 새 메시·충돌·경계를 만든다. 이 경우 외부 GLB가 없다는 사실은 차단 조건이 아니며, 실제 브라우저에서 연결 이동과 진입 불가 경계를 확인한 뒤 지역을 노출한다.

Sketchfab 후보는 각 모델의 공개 Data API 응답에서 `isDownloadable`, 라이선스, 면/정점 수, `animationCount`를 확인했다. 그러나 Sketchfab의 [공식 Download API 문서](https://sketchfab.com/developers/download-api/downloading-models)는 다운로드 요청에 Sketchfab 계정 인증과 OAuth access token이 필요하고, 인증 뒤에만 임시 glTF/USDZ URL과 크기를 돌려준다고 명시한다. 실제로 아래 후보들의 `/v3/models/{uid}/download`를 인증 없이 요청하면 모두 HTTP 401 `Authentication credentials were not provided.`가 반환되었다. 이번 조사에서는 계정 로그인이나 인증 우회를 하지 않았으므로 모델 파일과 파일 크기는 미확보다.

`CC BY` 표시는 업로더가 설정한 모델 라이선스다. 포켓몬 게임을 재현한 팬 모델의 원작 요소에 관해 업로더가 어떤 권리를 보유했는지는 별도 문제이며, 설명에 독자 제작 또는 적법한 원본 근거가 없는 후보는 그 표시만으로 프로젝트 재배포에 충분하다고 판정하지 않았다.

## 성도 후보

| 후보 | 원본과 확인 내용 | 형식·크기 | 판정 |
| --- | --- | --- | --- |
| [Radio Tower - Goldenrod City](https://sketchfab.com/3d-models/radio-tower-goldenrod-city-pokemon-gsc-9ef43d1065644930a5d7877801ffd9e7) | Sketchfab 공개 메타데이터상 다운로드 가능, CC BY, 3,326 faces, 애니메이션 0. 제작자는 설명에서 원작 미술의 권리가 Game Freak/Nintendo에 있고 자신은 그 3D 버전을 만들었다고 밝힘 | 인증 뒤 변환 glTF/GLB를 받을 수 있으나 크기는 인증 전 비공개 | 라디오 타워의 한 층이다. 지역·도시·도로 맵이 아니며 다운로드도 OAuth 로그인이 필요해 제외 |
| [Elm's Lab New Bark Town HGSS](https://embed-3dwarehouse-classic.sketchup.com/model/3973791e15ac04f6815688906e4667b/Elms-Lab-New-Bark-Town-HGSS) | Trimble 3D Warehouse의 Elm 연구소 한 동. 1,102 polygons, 18 materials, SketchUp 모델로 표시 | 페이지의 파일 크기는 0으로 표시되어 검증 불가 | 단일 건물이며 재배포 라이선스를 모델 페이지에서 확인하지 못해 제외 |
| [Pokemon Johto Map](https://three-drop.com/model/makerworld/474964) | 검색 색인에 MakerWorld 제작자 Fletch의 벽걸이 맵으로 표시. 1색 STL은 522 KB, 그 밖에 3MF 프린트 플레이트 8개가 기재됨 | STL/3MF, 게임 환경 포맷 아님 | 원 MakerWorld URL을 공개 검색에서 안정적으로 확인하지 못했고, Standard Digital File License는 디지털 파일·파생물 재배포를 금지한다. 도시를 걷는 맵이 아니라 3D 프린트 부조이므로 제외 |
| [Kanto and Johto 3D Pokemon Terrain Map](https://cults3d.com/en/3d-model/art/kanto-and-johto-3d-pokemon-terrain-map-kmac0012-2) | 제작자가 게임 맵과 근사 지형을 바탕으로 Rhino3D에서 만든 벽 장식이라고 설명 | 유료 US$5.70, STL/3MF | 결제가 필요하며 23~34시간 출력용 미술품이다. 플레이 환경이 아니므로 제외 |
| [Gen2-3D-Sprites](https://github.com/randyadr/Gen2-3D-Sprites) | Gold/Silver/Crystal의 맵·충돌·팔레트 자료에서 실행 중 복셀 sector mesh를 만들고 캐시하는 모드. README가 개인 ROM import 및 ROM 기반 캐시를 요구한다고 명시 | 최신 릴리스 ZIP은 약 10.4 MB이나 Stadium 캐릭터 모델 패키지이며 독립 Johto GLB/OBJ 맵이 아님 | 공개 지역 맵 파일이 아니다. ROM 파생 지형 생성 경로이므로 제외. 저장소 라이선스도 MIT 문구 뒤 자체 코드는 CC BY-NC라고 별도 표기해 전체 자산 권리 범위가 단일하지 않음 |
| [P3D-Legacy](https://github.com/P3D-Legacy/P3D-Legacy) | 고정 커밋 [`69b6695`](https://github.com/P3D-Legacy/P3D-Legacy/tree/69b6695ea2a99eaedfe2b6a58d983fb304f104c1)의 잘리지 않은 Git tree에서 성도 주요 도시 10곳과 27~46번 도로 파일을 모두 확인. 대표 파일은 위치·크기·충돌·워프를 가진 전용 텍스트 엔티티 배치임 | 독립 메시가 아닌 P3D `.dat`. 대표 파일 New Bark 36,442 B, Route 29 41,532 B, Goldenrod 125,036 B. 세 파일 모두 GLB/glTF/OBJ/FBX 참조 0건 | 직접 번들할 맵 자산으로는 제외한다. README의 GPLv3 설명은 `code`를 대상으로 하고 포켓몬 파생 미술의 별도 재배포 권리를 입증하지 않는다. 도시·도로 연결 관계의 교차 확인 자료로만 사용 가능 |

성도 도시 이름(New Bark, Cherrygrove, Violet, Azalea, Goldenrod, Ecruteak, Olivine, Cianwood, Mahogany, Blackthorn)으로 Sketchfab의 공개 검색 API를 각각 조회했지만, 다운로드 가능 결과 중 도시 환경에 해당하는 것은 없었다. Goldenrod 결과도 위 라디오 타워뿐이었다.

### P3D-Legacy 심화 검증

GitHub 공개 API에서 기본 브랜치의 고정 커밋과 전체 tree를 받아 검사했다. `P3D/Content/Data/maps` 아래 비전투 맵은 1,147개, 23,874,951바이트다. 도시 파일은 `barktown.dat`, `cherrygrove.dat`, `violet.dat`, `azalea.dat`, `goldenrod.dat`, `Ecruteak.dat`, `Olivine.dat`, `cianwood.dat`, `mahogany.dat`, `blackthorn.dat`가 모두 있다. 도로는 두 경로 규칙을 함께 확인해야 한다. 29~33·36~39번은 `maps/routeNN.dat`, 나머지는 주로 `maps/routes/routeNN.dat`에 있으며 27~46번이 모두 존재한다.

고정 원본 README·LICENSE·전체 tree와 대표 맵 3개는 `data/local/world-maps-research/p3d-legacy-69b6695/`에 보존했다. 모두 `.part`에 재개 다운로드한 뒤 완료 크기를 확인하고 이름을 바꿨으며 남은 `.part`는 없다. `manifest.json`에 SHA-256, 경로 목록과 구조 수치를 기록했다. 대표 파일을 직접 파싱한 결과는 다음과 같다.

| 파일 | 위치 레코드 | 엔티티 | 충돌 엔티티 | 워프 | 위치 좌표 범위 X / Y / Z |
| --- | ---: | ---: | ---: | ---: | --- |
| New Bark | 119 | 116 | 94 | 11 | -1..28 / -0.25..1 / -1..28 |
| Route 29 | 129 | 123 | 94 | 5 | -1..60 / -2..1 / 0..26 |
| Goldenrod | 400 | 378 | 325 | 20 | -150.5..38 / -1..11 / -60.5..89.5 |

이 수치는 지형·건물·충돌·연결을 실제 배치하는 3D 게임 맵 데이터라는 증거다. 반면 세 파일에는 독립 메시 참조가 없고 `Floor`, `WallBlock`, `EntityField`, `TexturePath`를 P3D 엔진이 조립하는 형식이다. 최신 공개 릴리스 0.61.2의 Windows ZIP은 263,754,498바이트로 직접 받을 수 있으나, 위 형식·권리 차단 조건이 먼저 확인돼 실행 파일은 내려받거나 실행하지 않았다. 초켓몬스터는 이 파일을 변환하거나 번들하지 않고, New Bark에서 Violet·Azalea·Goldenrod·Ecruteak으로 이어지는 도로와 서쪽 바다, 동쪽 산악 순환의 상대 관계만 자체 재구성 결과와 대조한다.

## Gold 고정 야생 조우 원본

[PokeAPI 저장소](https://github.com/PokeAPI/pokeapi)의 고정 커밋 [`8fe210b`](https://github.com/PokeAPI/pokeapi/tree/8fe210b21c9abbe73de93670f3d5a346c80a3625) CSV를 원본으로 사용한다. Gold는 `version_id=4`, Gold/Silver는 `version_group_id=3`, Johto는 `region_id=2`다. 성도 본편과 동쪽 연결부를 구현하기 위해 Johto 지역 위치에 PokeAPI가 Kanto로 분류한 Route 27도 명시적으로 포함했다.

원본 16개 파일은 `data/local/johto-gold-source/8fe210b21c9abbe73de93670f3d5a346c80a3625/`에 `.part` 재개 다운로드 후 크기와 SHA-256을 확인해 보존했다. `manifest.json`에 각 파일의 URL·바이트·해시가 있다. 핵심 파일 해시는 `encounters.csv` `93ba8853ac871719d230a6406c91f8418754fdc773f2f4b9f476007f743b4955`, `encounter_slots.csv` `597dc58df2b0a2c64cedce6d6a2a08feeecbd1cf860bdf926cd27f119417d87a`, `locations.csv` `2af5d6a1151d5ae402f9da1d5513bc1c7437795e69b140787c7aab3f6ed7eaa3`다. 원본 라이선스는 BSD-3-Clause다.

[`johto-gold-encounters.ts`](../src/data/johto-gold-encounters.ts)는 Gold의 `walk`와 `surf`만 남기고 `swarm-yes`를 제외한 뒤, 조건 없는 슬롯은 아침·낮·밤 모두에 펼치고 시간 조건 슬롯은 해당 시간에만 배치한 생성 데이터다. 42개 PokeAPI 위치, 297개 위치 영역·방식·시간 풀, 1,611개 슬롯 레코드, 87종을 포함하며 각 풀의 원본 희귀도 합은 100이다. 선물·교환·고정·낚시·박치기는 현재 필드 배회 몹에 섞지 않는다. Route 29와 같은 월드 ID를 PokeAPI ID로 바꾸는 매핑도 함께 내보내며, Dark Cave의 두 입구는 `locationAreaName`으로 분리할 수 있다.

## 성도 포켓몬 모델 현황과 직접 리깅 기준

지역 맵만으로 성도를 열지 않는다. 현재 고정 GLB 검사 결과에서 도감 152~251번은 기하 모델 100종이 모두 있으나, 스킨과 실제 애니메이션 클립이 함께 있는 종은 9종(160, 168, 183, 196, 197, 200, 210, 212, 249)뿐이다. 37종은 스킨만 있고 클립이 없으며 54종은 스킨과 클립이 모두 없다. 따라서 “성도 포켓몬 모델 100종 확보”는 맞지만 “성도 포켓몬 100종이 리깅·동작까지 완성”은 아니다. 이 집계는 [`pokemon-rigging-metadata.json`](./pokemon-rigging-metadata.json)의 파일별 GLB 검사값에서 다시 계산했다.

초기 진행에서 자주 만나는 종을 파일별로 보면 스타터 152·155·158은 스킨이 있지만 애니메이션 클립이 없는 `rigged-static`이다. 161 꼬리선은 스킨 0·클립 0인 `static`, 163 부우부는 스킨 1·관절 51·클립 0인 `rigged-static`, 179 메리프는 스킨 0·클립 0인 `static`이다. `rigged-static`은 뼈가 있어 후속 애니메이션 제작이 가능한 상태를 뜻하며, 현재 걷기 동작이 완성됐다는 뜻은 아니다.

고정 모델 커밋 `429de1288cea0d43f5b4f56305d2276e94239d65`와 manifest SHA-256 `664993e7670f6b82dd49b4e9318e6669157898247c8e4b879f59c2e709c2225c`의 검사는 리깅 작업의 시작 상태를 기록한다. `skins > 0`인 46종 목록은 기존 골격을 재사용할 수 있는 후보 목록이며 런타임 허용 목록이 아니다. Gold 원본 풀의 종은 기존 리깅 유무만으로 제외하지 않고, 골격이나 동작이 부족한 모델을 직접 리깅하는 대상으로 관리한다. 기존 관동 1~151 모델도 유지한다.

원본 Gold 풀 87종과 슬롯 가중치는 변경하지 않는다. 현재 런타임 요약은 위치별 낮 시간 walk 또는 surf 슬롯의 고유 종 목록과 전체 레벨 범위를 만들고, 그 고유 종을 균등하게 선택한다. 따라서 원본 슬롯 가중치에 따른 Gold의 전체 출현 확률을 재현한 결과가 아니다. 화면에는 이 균등 선택 방식과 `static`/`rigged-static`/`rigged-animated`의 차이를 표시해야 한다. 실제 수면을 만들지 않은 도시는 surf 원본이 있어도 육지 출현에 사용하지 않는다.

[Stadium 2 ROM importer](https://github.com/Deftones565/gen1recomp-mod-stadium2-importer)는 전국도감 1~251의 모델과 골격 애니메이션 아카이브를 읽고 동작을 재생하는 공개 구현이다. 그러나 README가 사용자가 합법적으로 보유한 Stadium 2 ROM에서 로컬 추출하도록 요구하고 추출된 Nintendo 모델을 배포하지 않는다. 그러므로 리깅 가능성의 기술 증거로만 기록하며, 초켓몬스터가 확보한 재배포 가능 모델 묶음으로 세지 않는다.

성도 개방 조건은 (1) 출처 기반 도시·도로 그래프를 자체 지형으로 재구성, (2) 충돌·진입 불가 경계·안전 도착 지점을 포함한 연결 이동 확인, (3) Gold 조우 풀을 위치와 walk/surf 지형에 맞게 연결하고 모델·리깅 상태를 화면에 투명하게 표시, (4) 부족한 모델을 직접 리깅하는 경로를 제공, (5) 브라우저에서 실제 플레이·저장 복원을 확인하는 것이다. 독립 외부 GLB는 필수 조건이 아니다. 모델이 없는 종을 다른 종으로 바꾸지 않으며 원본 조우 풀은 보존한다.

## 이후 지역 후보

| 지역 | 후보 | 공개 메타데이터 | 판정과 차단 요인 |
| --- | --- | --- | --- |
| 호연 | 이번 조사에서 공개 다운로드 가능한 지역/도시 맵 미확인 | Sketchfab에서 Hoenn 및 대표 도시 이름으로 다운로드 가능 환경 모델 결과 없음 | 파일 미확보. 검색 색인에 84.7 MB 3MF 지형 부조가 있으나 3D 프린트용이고 원본·권리·직접 URL을 검증하지 못해 후보로 세지 않음 |
| 신오 | [Twinleaf Town fan recreation](https://sketchfab.com/3d-models/twinleaf-town-pokemon-diamond-pearl-platinum-5d86754217424411b3f426272a6e0c48) | 제작자는 Maya 2024로 만든 팬 재현이라고 설명. 결합 FBX, 256×256 텍스처 2개, 20,124 faces, 20,204 vertices, 애니메이션 0, CC BY, `isDownloadable: true` | 도시 한 곳의 실제 환경 메시라는 점은 가장 분명하다. 그러나 다운로드 API가 OAuth 로그인 필수이고 파일 크기를 확인할 수 없어 미확보. 팬 재현물의 원작 권리도 배포 전에 별도 검토 필요 |
| 신오 | [PokéRegions Sinnoh 3D viewer](https://pokeregions.com/) | 브라우저에서 신오 지형을 보는 웹 프로젝트 | 공개 소스, 원본 파일 다운로드, 라이선스를 확인하지 못함. 뷰어 서비스는 파일 자산이 아니므로 제외 |
| 하나 | 이번 조사에서 공개 다운로드 가능한 지역/도시 맵 미확인 | Unova 검색 결과는 배지나 단일 탈것 위주이며 도시·도로 환경 없음 | 파일 미확보 |
| 칼로스 | [Pokemon Kalos Island Map](https://sketchfab.com/3d-models/pokemon-kalos-island-map-832e4aa79adc42a3bf28e18f960323db) | 170,387 faces, 85,156 vertices, 애니메이션 0. 공개 API의 `isDownloadable`은 false이고 라이선스가 비어 있음 | 뷰어 전용이며 다운로드·재사용 권리가 없어 제외 |
| 알로라 | [Iki Town](https://sketchfab.com/3d-models/ikytown-46efc19feed3445fac16e5066cbcf358), [Malie Garden](https://sketchfab.com/3d-models/malie-garden-9ab15966ffbc4dabab1d019c52824711), [Mount Lanakila](https://sketchfab.com/3d-models/mount-lanakila-0118d54740594bac9881b1c010ea0248) | 각각 32,751 / 32,242 / 6,735 faces, 애니메이션 0, CC BY, 다운로드 가능 표시 | OAuth 로그인 필수라 파일·크기 미확보. 설명이 이름 수준에 그쳐 독자 제작인지 게임 추출인지 provenance가 불명확하며, 각기 단절된 장소라 지역 연결 맵도 아님 |
| 가라르 | [Wyndon City](https://sketchfab.com/3d-models/wyndon-city-3d09c9faf49c46ca870d0d6be4f7376c), [Hulbury Town](https://sketchfab.com/3d-models/hulbury-town-4cb798e4ba744e07841fee92bd653fe6), [Turffield Town](https://sketchfab.com/3d-models/turffield-town-e91f03b861e6401caaf4559058590550) | 각각 708,004 / 547,023 / 582,893 faces, 애니메이션 0, CC BY, 다운로드 가능 표시 | OAuth 로그인 필수라 파일·크기 미확보. 한 줄 설명뿐이어서 제작 경로와 원작 권리 불명확. 도시 사이 연결 지형이 없는 개별 장면 |
| 히스이 | 이번 조사에서 공개 다운로드 가능한 지역/도시 맵 미확인 | Hisui 검색에서 환경이 아닌 포켓몬 개체 모델만 확인 | 파일 미확보 |
| 팔데아 | 이번 조사에서 공개 다운로드 가능한 지역/도시 맵 미확인 | Paldea 검색 결과의 일부는 상용 게임 NSP/XCI 다운로드를 유도하는 스팸성 항목이며 환경 맵이 아님 | 저작권 침해 파일 유도 가능성이 있어 배제. 적합한 원본 맵 미확보 |

## 다운로드 및 로컬 파일 상태

외부 완성 맵 직접 채택 기준을 만족한 후보는 없다. 다만 심화 조사 증거로 P3D-Legacy의 고정 tree, README, LICENSE와 대표 `.dat` 3개를 `data/local/world-maps-research`에 내려받아 SHA-256과 위치 bounds를 확인했다. 이는 연구용 원본이며 런타임 자산이나 확보된 독립 지역 메시가 아니다. PokeAPI Gold CSV 원본과 manifest도 `data/local/johto-gold-source`에 보존했다. Sketchfab 후보의 face/vertex 수는 원본 파일 검사가 아니라 Sketchfab 공개 Data API가 제공한 메타데이터다.

성도 자체 재구성은 구현 중이며 이 문서만으로 지역 개방 완료를 판정하지 않는다. 재구성 지형의 브라우저 이동·경계·조우·저장 복원 검증이 지역 노출의 마지막 근거다. 외부 후보를 직접 자산으로 다시 검토할 때는 제작자에게 원본 다운로드와 게임 번들 재배포 허락을 받고, 파일의 체크섬·좌표계·메시 충돌·텍스처 출처를 별도로 검증해야 한다.
