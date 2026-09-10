# MaleCNS v1.0 부분회로 출처와 변환

게임 기본 실제 회로는 HHMI Janelia의 [MaleCNS v1.0 공식 다운로드](https://male-cns.janelia.org/download/)에서 공개한 수컷 초파리 뇌와 배신경삭 connectome의 부분 그래프다. 데이터셋은 **CC-BY 4.0**으로 공개되어 있다. 사용한 release는 `MaleCNS v1.0`, synapse confidence 조건은 원본 파일명에 명시된 `minconf 0.5`다.

## 재현

```powershell
uv run --with pyarrow scripts/prepare-connectome.py
```

스크립트는 `data/local/malecns-v1.0/`에 annotation, neuron-level neurotransmitter prediction, full connection graph Feather 원본을 저장한다. 완료된 파일은 크기와 SHA-256이 모두 맞을 때만 재사용한다. 중단된 다운로드는 `.part` 파일에서 HTTP Range로 재개하며, 원본을 수정하지 않는다. 최종 게임 파일은 `public/data/connectome.json`이다.

| 원본 | 바이트 | SHA-256 |
| --- | ---: | --- |
| `body-annotations-male-cns-v1.0-minconf-0.5.feather` | 14,483,314 | `2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2` |
| `body-neurotransmitters-male-cns-v1.0.feather` | 43,282,834 | `95c9289220663abeb3409f3ad9e5a7f8a53f8093f5139d15502cd08da8879621` |
| `connectome-weights-male-cns-v1.0-minconf-0.5.feather` | 1,051,241,946 | `e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1` |

## 선택 기준

회로의 seed는 annotation의 `type == DNa02`인 좌우 한 쌍이다. MaleCNS annotation은 이를 `descending_neuron`으로 분류하며, 별도의 생리·행동 연구인 [Fine-grained descending control of steering in walking Drosophila](https://pmc.ncbi.nlm.nih.gov/articles/PMC10614758/)는 DNa02와 보행 steering의 관계를 실험했다. 두 seed와 직접 연결된 뉴런 가운데 type과 superclass가 있고 Glia가 아니며, neuron-level transmitter 예측이 acetylcholine, GABA, glutamate 중 하나이고 예측 confidence가 0.5 이상인 뉴런만 후보로 둔다. 양방향의 공개 connection weight, 즉 실측 synapse 수 합이 큰 순서로 126개를 선택하며 동률은 숫자 body ID 순으로 고정한다. 결과는 128개 노드의 induced subgraph라서 선택된 노드 사이의 공개 edge는 threshold를 추가하지 않고 모두 보존한다. 64비트일 수 있는 body ID는 JSON에서 문자열로 저장한다.

edge 부호는 presynaptic neuron의 consensus transmitter를 이용해 acetylcholine을 양수, GABA와 glutamate를 음수로 둔 모델링 가정이다. 실제 receptor별 흥분·억제를 측정한 결과가 아니다. 각 target의 절대 signed synapse 수 합이 0.8이 되도록 정규화한다. 원본 synapse 수는 각 edge의 `synapses`에 함께 둔다. 각 node에는 원본 body ID, type, instance, superclass, status, transmitter와 confidence를 저장한다.

## 게임에서의 의미와 한계

이 파일은 `connectome-subset`이며 전체 뇌가 아니다. 실제 MaleCNS node와 선택된 node 사이의 실측 연결이 recurrent dynamics에 사용된다. 게임의 12개 감각값을 node에 넣는 random projection, 5개 행동을 고르는 learned readout, 보상과 학습 규칙은 직접 설계한 것이다. 일반 `Brain` 구현은 감각 skip feature를 지원하지만 Pokémon 모델은 `sensoryBypass=false`로 이 우회 경로를 끄고 recurrent node activity만 readout에 전달한다. 이 입력과 출력은 MaleCNS의 해부학적 감각·운동 세포에 대응하지 않는다. 따라서 움직임이나 점수 향상을 생물학적 학습 또는 초파리 지능의 증거로 해석할 수 없다.
