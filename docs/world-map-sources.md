# 지역 3D 맵 원본 조사

조사일: 2026-09-13

## 판정

**이번 공개 자료 조사에서는 실제 3D 성도(Johto) 플레이 맵 파일을 확보하지 못했다.** 확인한 성도 자료는 단일 건물, 3D 프린트용 부조, 또는 사용자가 소유한 게임 ROM을 실행 중에 복셀 지형으로 변환하는 프로그램이었다. 조사 범위 안에서는 로그인 없이 직접 받을 수 있고, 게임에 포함해 재배포할 권리가 명확하며, 이동 가능한 도시와 도로를 갖춘 GLB/glTF/OBJ/FBX 지역 맵을 확인하지 못했다.

성도 이후 지역도 같은 기준을 충족하는 파일을 확보하지 못했다. 따라서 아래 후보를 게임의 지원 지역 또는 확보 자산으로 세면 안 된다. 이 조사는 모델이 검색되거나 뷰어에서 보이는 것과 프로젝트가 파일을 합법적으로 확보해 배포할 수 있는 것을 구분한다.

## 채택 기준과 확인 방법

채택하려면 다음 조건을 모두 만족해야 한다.

- 도시와 도로를 실제로 이동할 수 있는 환경 메시여야 한다. 단일 건물, 캐릭터, 배지, 조형물, 벽걸이 부조는 제외한다.
- GLB, glTF, OBJ 또는 FBX 원본이나 변환본을 로그인과 결제 없이 직접 받을 수 있어야 한다.
- 제작자와 라이선스가 명시되고, 게임에 수정·포함·재배포할 수 있어야 한다.
- ROM 추출이나 사용자가 별도로 보유한 상용 게임 파일을 요구하지 않아야 한다.
- 파일 크기, 형식, 메시 범위, 애니메이션 유무를 내려받은 파일에서 검증할 수 있어야 한다.

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

성도 도시 이름(New Bark, Cherrygrove, Violet, Azalea, Goldenrod, Ecruteak, Olivine, Cianwood, Mahogany, Blackthorn)으로 Sketchfab의 공개 검색 API를 각각 조회했지만, 다운로드 가능 결과 중 도시 환경에 해당하는 것은 없었다. Goldenrod 결과도 위 라디오 타워뿐이었다.

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

채택 기준을 만족한 후보가 없으므로 `data/local/world-maps-research`에는 파일을 다운로드하지 않았다. 따라서 SHA-256, 실제 아카이브 크기, scene graph, 좌표 bounds, 텍스처 포함 여부와 애니메이션 트랙 검증 결과도 없다. 검색 결과의 face/vertex 수는 원본 파일 검사가 아니라 Sketchfab 공개 Data API가 제공한 메타데이터다.

현재 제품은 새 게임과 지역 지도에서 관동만 선택할 수 있게 제한한다. 위 후보를 다시 검토하려면 제작자에게 원본 다운로드와 게임 번들 재배포 허락을 직접 받고, 받은 파일의 체크섬·좌표계·메시 충돌·텍스처 출처를 별도로 검증해야 한다.
