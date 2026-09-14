# 월드 좌표와 동굴 장면 계약

## 지상 좌표

지도 v3는 기존 지상 지도의 `x`, `z`를 각각 2배 확장한다. `WORLD_SCALE`은 2이고 허용 범위는 축마다 -240부터 240까지다. 지형의 도로 폭, 마을 반경, 건물 크기와 충돌 영역도 같은 비율로 확장하므로 화면만 넓어지고 통행 밀도가 그대로 남는 방식이 아니다. 이동 속도는 월드 단위 기준 기존 값을 유지한다. 따라서 장소 사이 실제 이동 시간도 약 2배가 된다.

저장 복원 시 `kanto-v2` 또는 `johto-v2`처럼 확장 전 지상 저장만 `migrateSurfaceSnapshotCoordinates`로 한 번 변환한다. 플레이어, 활성 개체, 보관된 동료 위치와 목표점, 먹이, 스폰 기준점, 리스폰 원점을 함께 변환한 뒤 mapVersion을 v3로 기록한다. v3 저장이나 동굴 저장에는 다시 적용하지 않는다.

포켓몬 모델의 현재 표시 높이는 `pokemonWorldDisplayHeight`가 `height * 2.15 * 0.72 + 0.7 * 0.72`로 계산하고 1.18m에서 3.45m 사이로 제한한다. 이 값은 렌더 높이에만 적용하며 시뮬레이션 좌표, 이동 속도와 충돌에는 영향을 주지 않는다.

## 장면 식별자

멀티플레이와 저장은 다음 형식만 사용한다.

- 지상: `surface:<region>`
- 동굴: `cave:<region>:<cave-id>`

presence의 region과 sceneId 안 region은 같아야 한다. 같은 지역의 지상 플레이어와 동굴 플레이어, 서로 다른 동굴의 플레이어는 서로 보이지 않는다.

`getWorldScene(regionId, sceneId)`는 지상 atlas 또는 해당 지역 소유의 CaveScene을 돌려주며 다른 지역 장면은 거절한다. 각 atlas는 `surfaceSceneId`와 그 지역의 `caves`를 제공한다.

## 동굴 이동과 렌더링

`CAVE_SCENES`의 각 CaveScene은 서로 다른 결정적 미로다. `wallSegments`는 연속 벽 타일을 합친 렌더용 구간이고 `sample(x,z)`가 같은 벽의 이동 충돌을 판정한다. `encounterLocationId`는 지역 출현표 조회 키다. `name`은 화면 입출구에 표시하는 한국어 이름이다.

각 portal은 다음 좌표를 제공한다.

- `surface`: 지상에서 입구를 감지하는 점
- `surfaceArrival`: 동굴에서 나온 뒤 재진입 반경 밖에 놓는 점
- `interior`: 동굴에서 출구를 감지하는 점
- `interiorArrival`: 지상에서 들어간 뒤 출구 반경 밖의 통행 가능한 점

지상에서는 `cavePortalAtSurface`, 내부에서는 `cavePortalAtInterior`로 전환점을 찾는다. 벽 안 저장 좌표는 `nearestCaveWalkable`로 복구한다. 입출구 문구는 `name`을 사용하고 깊이 테스트에 가려지지 않는 HTML 오버레이로 표시한다.
