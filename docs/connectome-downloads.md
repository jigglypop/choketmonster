# MaleCNS v1.0 다운로드 기록

## Threads 게시물과 데이터셋 판별

사용자가 준 공유 URL `https://www.threads.com/share/He1PKfU4C/`은
`https://www.threads.com/@choi.openai/post/DdG5Kuzj7FG`로 연결된다. 2026-09-11에
로그인 없이 받은 게시물 HTML의 `og:description`은 “16만 6천 개 뉴런을 재현한
초파리 뇌”를 Minecraft, Doom, VTuber, 방탈출 NPC 등에 연결한 15개 사례를
정리했다고 설명한다. 이 문구만으로 특정 배포 파일을 식별할 수는 없지만, 뉴런
수와 공개 시점은 166,700개 뉴런을 포함한 HHMI Janelia **MaleCNS v1.0**과
일치한다. 다운로드 출처는 소셜 게시물의 2차 설명이 아니라 Janelia의 공식
[MaleCNS 다운로드 페이지](https://male-cns.janelia.org/download/)로 고정했다.

## 실제로 받은 범위

- 데이터셋: `MaleCNS v1.0`, 공개일 2026-06-08
- 라이선스: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 공식 버킷: `gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/`
- 로컬 경로: `data/local/malecns-v1.0-flat-connectome/`
- 인벤토리 기준일: 2026-09-11
- 범위: 위 prefix에 공개된 분석용 Feather 객체 11개 전부
- 총 크기: 31,318,683,398 bytes (31.32 GB, 29.16 GiB)

공식 웹 페이지가 본문에서 열거하는 핵심 파일은 annotation, neuron-level
neurotransmitter, body stats, full connection weights, synapse points, synapse
partners, t-bar neurotransmitter의 7개다. 공개 버킷에는 connection weights와
synapse partners의 `significant-only`, `traced-only` 파생본 4개도 있어서 함께
받았다. 정확한 객체 generation, 원본 URL, 크기, GCS MD5와 로컬 SHA-256은
`data/local/malecns-v1.0-flat-connectome/manifest.json`에 있다.

| 파일 | bytes | SHA-256 |
| --- | ---: | --- |
| `body-annotations-male-cns-v1.0-minconf-0.5.feather` | 14,483,314 | `2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2` |
| `body-neurotransmitters-male-cns-v1.0.feather` | 43,282,834 | `95c9289220663abeb3409f3ad9e5a7f8a53f8093f5139d15502cd08da8879621` |
| `body-stats-male-cns-v1.0-minconf-0.5.feather` | 778,062,826 | `ca5dc83a26382ae70c8d8f42fc09ce2dbc1af7c03f3a001a1936b5e142540647` |
| `connectome-weights-male-cns-v1.0-minconf-0.5-significant-only.feather` | 502,169,298 | `5c536423a62a688e59e7b441f9c04d6272c9a1f017e35814cf561f8c275d9e9e` |
| `connectome-weights-male-cns-v1.0-minconf-0.5-traced-only.feather` | 508,025,642 | `9b3beab17bad5f618be3f2c02d3139a8d07b822565919c013f1e5506d93e604b` |
| `connectome-weights-male-cns-v1.0-minconf-0.5.feather` | 1,051,241,946 | `e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1` |
| `syn-partners-male-cns-v1.0-minconf-0.5-significant-only.feather` | 2,965,702,122 | `43748c76db13e339e9eeb6f4d56e98aab704a4f7fa8bf3cb916b323000070d04` |
| `syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather` | 2,965,367,002 | `3db100d3b4c7cfdc9b34506b3eb8b5ead2d9760b38952e5656285bb362327efc` |
| `syn-partners-male-cns-v1.0-minconf-0.5.feather` | 6,777,179,098 | `959d8ef4173b35382a3e6acfaf5167c795b6d10b877572d146af04e1b487bc07` |
| `syn-points-male-cns-v1.0-minconf-0.5.feather` | 13,061,489,098 | `c16b1b63186c4d4f28939decea7444451f0f5f6f7ef1bb5dab5b2a7058f8f284` |
| `tbar-neurotransmitters-male-cns-v1.0.feather` | 2,651,680,218 | `bade84c9eab431dd537ff644aaf3d203d639a819c739ecedb338e7d109064f4d` |

`scripts/download-connectome-data.py`는 동일 인벤토리를 코드에 고정한다. 완료된
파일은 크기와 MD5를 통과할 때만 재사용하고, 잘못된 완료 파일은 덮어쓰지 않는다.
중단된 전송은 `.part`에 보존하고 HTTP Range로 이어받는다. URL에는 GCS object
generation을 넣어 같은 이름의 파일이 나중에 바뀌어도 이번 입력이 달라지지 않게
했다. 실행 명령은 다음과 같다.

```powershell
uv run python scripts/download-connectome-data.py
```

Feather의 `body`, `body_pre`, `body_post` 같은 ID 열은 원본의 64비트 정수형을
그대로 보존한다. JSON 등 정밀도를 잃을 수 있는 형식으로 내보낼 때는 문자열로
변환해야 한다. 이 다운로드 작업은 원본 Feather를 변환하거나 수정하지 않는다.

## 이 다운로드에 포함되지 않은 큰 범위

“flat-connectome 분석 객체 전부”와 “MaleCNS가 공개한 모든 바이트”는 다르다.
공식 페이지는 아래 자료도 공개하지만 이번 로컬 전체 다운로드에는 포함하지
않았다.

| 범위 | 공식 위치 | 제외 이유와 규모 |
| --- | --- | --- |
| 정렬 EM | `gs://flyem_cns_z0720_07m_dvidcoords_n5`, `gs://flyem-male-cns/em/em-clahe-jpeg` | 94,088 × 78,317 × 134,576 uint8 voxels. 무압축 배열만 약 991.65 TB이며 청크 저장 객체 전체를 내려받는 분석 입력이 아니다. |
| v1.0 neuron segmentation | `gs://flyem-male-cns/v1.0/segmentation` | 같은 8 nm 공간의 uint64 precomputed volume과 많은 mesh/skeleton 객체를 포함한다. 이론상 비압축 dense 배열은 약 7.93 PB이며 실제 버킷 압축 크기는 공식 페이지가 제시하지 않는다. |
| nuclei/ROI volumes | 공식 다운로드 페이지의 nuclei, brain ROI, VNC ROI prefix | 다해상도 청크형 volume이며 flat graph 분석에는 필요하지 않다. |
| 전체 skeleton collections | v1.0 segmentation 아래 SWC/precomputed, mirrored, unisex-template prefix 5개 | 뉴런별 다수 객체 디렉터리다. 필요 뉴런만 선택해서 받는 용도이며 단일 전체 파일/공식 합계 크기가 없다. |
| neuPrint database | `gs://flyem-male-cns/v1.0/database/neo4j`, `.../neuprint-inputs` | 자체 neuPrint/Neo4j 서버를 만들기 위한 중복 배포물이다. 공개되어 있으나 단일 분석 파일 묶음이 아니다. |
| neuPrint API, Clio, NeuronBridge | 공식 페이지에서 연결되는 서비스 | neuPrint API와 시각 검색은 계정/토큰 또는 로그인이 필요하다. 계정 권한 없이 자동 수집하지 않았다. |

따라서 로컬 자료는 연결, 시냅스 좌표, annotation, neurotransmitter 분석을 재현할
수 있는 공개 flat 파일의 완전한 스냅샷이다. 영상 volume, 모든 형태 mesh, 서비스
DB까지 포함한 MaleCNS 전체 미러라고 부르면 안 된다. 향후 volume이 필요하면 전체
미러보다 좌표 경계를 명시한 cutout을 새 폴더에 받고 별도 체크섬과 선택 기준을
남긴다.
