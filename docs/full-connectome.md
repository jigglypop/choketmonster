# MaleCNS 166,700 curated-neuron 서버 그래프

Rust 서버용 기본 그래프는 MaleCNS v1.0 annotation의 **`superclass`가 지정된 166,700개 body**를 사용한다. 이 노드 사이의 공개된 방향 연결 25,582,938개를 모두 CSR에 보존한다. [공식 다운로드 페이지](https://male-cns.janelia.org/download/)는 annotation 파일을 curated neuron annotations로, 전체 edge 파일을 모든 segment 사이의 full connection graph로 구분한다.

166,700은 로컬 원본에서 `superclass != null`인 고유 body 수와 정확히 일치한다. `status=Glia`인 11,864개에는 superclass가 지정되지 않았지만 두 조건을 모두 명시적으로 검사한다. 처음 검토한 "annotation에서 Glia만 제외한 199,713개"에는 superclass가 없는 body 33,013개가 포함되므로 최종 그래프나 UI에서 neuron 수로 쓰지 않는다. 원본 edge endpoint 합집합 약 8,804만 개 역시 모든 segment의 합집합이며 neuron 수가 아니다.

선택된 166,700개의 status는 `Traced` 164,606, 미기재 2,002, `Anchor` 60, `Orphan` 32다. 모두 superclass는 지정됐지만 2,194개는 세부 `type`이 없다. 따라서 제품 표현은 **“MaleCNS v1.0 166,700 superclass-assigned curated neurons”** 또는 **“MaleCNS 166,700 curated-neuron graph”**가 맞다. 개별 세포의 type과 tracing status가 모두 확정됐다고 표현하지 않는다. 전체 superclass별 수는 산출물 `manifest.json`에 기록한다.

## 재현

원본 파일을 수정하거나 다시 내려받지 않는다. 변환기는 먼저 기존 세 파일의 크기와 SHA-256을 모두 검증하고, 불일치하면 중단한다.

```powershell
uv run --with pyarrow --with numpy scripts/prepare-full-connectome.py
cargo test --manifest-path rust-server/Cargo.toml --release connectome -- --nocapture --test-threads=1
```

파생 산출물은 기본적으로 `data/local/malecns-neurons166k/`에 생긴다. 이미 있으면 덮어쓰지 않는다. `--force`도 검증된 원본에는 쓰지 않고 `graph.bin`, `node_ids.txt`, `manifest.json` 파생 파일만 교체한다. 두 번의 독립 변환에서 세 파생 파일의 SHA-256이 모두 같았다.

| 산출물 | 역할 | SHA-256 |
| --- | --- | --- |
| `manifest.json` | 범위, 포함·제외 기준, provenance, transmitter 가정, 통계 | `8e5c40ea726c66f555bfe7172ece423913b851cbf4cd22a8b37256ffabc2a22b` |
| `node_ids.txt` | 64-bit body ID를 손실 없는 10진 문자열로 보존 | `17255b947bea6e0858b1def57ce82a5e9ee37bbc8e7a097696fe90ad665bd820` |
| `graph.bin` | little-endian incoming CSR | `ad0ab3a8e6eaebe7bf01e44400852e1e8ff43841c27ebca864fc611227d53256` |

`graph.bin`은 `CHKCSR01`, schema `u32`, node count `u32`, edge count `u64`, `offsets[u64]`, `sources[u32]`, `synapses[u32]`, `signs[i8]` 순서다. 크기는 231,580,074 bytes다.

## transmitter와 실행 가정

presynaptic neuron의 consensus prediction confidence가 0.5 이상일 때 ACh는 `+1`, GABA와 glutamate는 `-1`로 둔다. 이는 target receptor를 측정한 결과가 아닌 거친 공학 가정이다. 그 밖의 transmitter, 누락, unclear, 낮은 confidence는 `0`이다. 해당 edge 1,207,620개는 topology와 synapse count에는 남지만 recurrent activity에는 기여하지 않는다. 임의로 흥분성으로 바꾸지 않는다.

활성 edge는 24,375,318개, 전체의 95.2796%다. target마다 활성 edge의 synapse 합으로 나누고 0.8을 곱한다. sensory projection, tanh recurrent dynamics, 256차원 pooled readout, 다섯 게임 행동, 보상과 Q-learning은 모두 게임을 위해 설계했다. 해부학적 감각·운동 매핑이나 완성된 초파리 뇌를 재현하지 않는다.

`Connectome`은 서버 프로세스에서 하나의 불변 그래프로 공유한다. source index, 정규화 weight, CSR offset의 예상 크기는 205,997,112 bytes다. 개체 상태는 166,700개 `f32` activity와 5x256 readout을 가지며 실제 bincode 직렬화 측정은 673,108 bytes였다. 렌더링 난수는 사용하지 않는다.

## 제한 실행 증거

2026-09-12 Windows release build의 단일 test thread에서 한 full-graph step은 6.229 ms였다. 호스트와 동시 부하에 따라 달라지는 참고값이며 EC2 성능 보장은 아니다. 같은 checkpoint와 요청의 action/activity/readout은 정확히 재현됐고 `learning=false`에서 update count와 readout은 변하지 않았다.

같은 상태와 입력을 두 번 실행한 뒤 recurrent topology만 제거한 대조군과 비교한 mean activity L1 차이는 `0.01757094`였다. 이는 실제 MaleCNS edge가 계산 경로와 상태에 영향을 준다는 실행 증거다. 행동 품질, 생물학적 학습, 초파리 지능의 증거는 아니다. `terminal=true`는 마지막 보상을 bootstrap 0으로 반영한 다음 activity와 previous trace를 초기화하며 새 recurrent 결정을 만들지 않는다.
