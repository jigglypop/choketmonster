# 실제 커넥톰 연결

브라우저는 MaleCNS v1.0에서 추출한 **128개 뉴런, 3,623개 연결의 부분 회로**(`connectome-subset`)를 사용한다. 전체 뇌나 해부학적으로 검증된 감각/운동 경로를 구현한 것은 아니다. 아래 범용 CSV 가져오기 명령은 별도의 작은 회로 실험용이다. 실제 브라우저 회로의 원본과 선택 근거는 [connectome-source.md](./connectome-source.md), 정책 실행과 재현 증거는 [kanto-neural-evidence.md](./kanto-neural-evidence.md)를 따른다.

현재 게임 입력의 공식 원본은 [MaleCNS v1.0 다운로드](https://male-cns.janelia.org/download/)이다. 사용자가 준 Threads 게시물은 여러 응용 사례를 소개하는 2차 자료이며, 게시물의 “16만 6천 개 뉴런” 설명과 일치하는 최신 공식 배포를 선택했다. 2026-09-11에 공개 flat-connectome Feather 객체 11개(31,318,683,398 bytes)를 별도 원본 폴더에 다운로드하고 검증했다. 파일별 generation, 크기, MD5, SHA-256과 포함하지 않은 대형 volume 범위는 [다운로드 기록](./connectome-downloads.md)에 있다. MaleCNS와 FlyWire FAFB는 서로 다른 데이터셋이므로 섞지 않는다.

## 입력

`data/local/selected-nodes.json`에 실제 원본의 뉴런 ID를 **문자열** 배열로 넣는다. 64비트 root ID를 JavaScript 숫자로 바꾸면 정밀도가 소실된다.

```json
["720575940123456789", "720575940123456790"]
```

위 ID는 형식 설명용 가짜 예시이며 검증된 세포가 아니다. 실제 선택은 세포형/회로 근거로 정한다.

CSV 또는 `.csv.gz`에는 다음 헤더가 필요하다.

```text
pre_root_id,post_root_id,syn_count,nt_type
```

`syn_count`는 양의 정수이며 동일한 방향의 행은 합친다. ACH는 양수, GABA/GLUT/GLU는 음수로 모델링한다. 이 부호는 수용체별 기능을 확증하지 않은 단순화이다. 도파민 등 기타/불명 타입이 선택된 회로의 연결에 나타나면 가져오기를 중단한다. 임의로 흥분성으로 처리하지 않는다.

## 실행

```powershell
npm run import:connectome -- --csv data/local/connections.csv.gz --nodes data/local/selected-nodes.json --source https://실제-원본-데이터-URL --version 실제-데이터셋-버전 --license 실제-라이선스 --out data/local/circuit.json
npm run experiment -- --graph data/local/circuit.json --seeds 3 --train 50 --eval 20
```

명령의 URL/버전/라이선스는 실제 메타데이터로 바꾼다. 도구는 다운로드를 수행하지 않는다. 지정한 로컬 파일을 스트리밍으로 읽고 원본 파일 바이트의 SHA-256을 계산한다. gzip이면 압축 파일의 해시다. 입력에 없는 데이터를 생성하거나 원본 파일을 수정하지 않는다. 출력 파일이 이미 있으면 덮어쓰지 않고 실패한다.

가져오기에는 최대 60초, 3천만 행, 선택된 방향 연결 5만 개의 한도가 있다. 초과하면 이미 정해 둔 작은 회로를 별도 CSV로 추출해 재실행한다. 데이터 파싱 오류·지원하지 않는 신경전달물질·연결 없음은 명시적으로 실패한다.

## 보존과 변환

노드 ID, 방향, 합산한 시냅스 수, 원본 URL·버전·라이선스·해시를 저장한다. 목표 뉴런별 절대 유입 가중치 합을 0.8로 정규화한다. 감각 투영과 학습 출력은 게임용 설계이며 실제 감각/운동 세포와 대응하지 않는다. 메타데이터는 사용자가 제공하므로 `connectome-subset` 표시는 가져온 회로라는 뜻이고, 원본 진위가 자동 인증되었다는 뜻이 아니다.

범용 CSV 파서 테스트는 합성 fixture를 사용한다. 별도로 실제 MaleCNS 파일 체크섬과 변환 통계, 브라우저 부분 회로의 정책 실행, 가중치 고정 평가 및 저장된 리플레이를 검증했다. 이는 게임 구현 검증이며 생물학적 학습의 증거가 아니다.
