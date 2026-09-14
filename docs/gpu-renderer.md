# 오픈월드 GPU 렌더러 계약

현재 설치된 Three.js 0.178.0의 공식 패키지 export인 `three/webgpu`와 `three/tsl`을 사용한다. `WebGPURenderer`는 초기화 시 WebGPU adapter를 먼저 선택하고 지원하지 않는 환경에서는 자체 WebGL2 backend로 전환한다. 두 backend 모두 같은 TSL 노드 재질을 실행하므로 GLSL `onBeforeCompile` 분기를 따로 유지하지 않는다.

R3F Canvas에는 async `createOpenWorldRenderer`를 `gl` factory로 전달한다. `forceWebGL`은 비교 검사에만 사용한다. `getOpenWorldRendererInfo`는 선택된 backend와 Three renderer의 frame, draw call, triangle, line, point 카운터를 제공한다.

`normalizeStandardMaterial`은 GLTF의 색, UV map, normal/roughness/metalness/emissive/alpha 설정을 새 `MeshStandardNodeMaterial`로 복사한다. 풀과 작은 식생에는 `wind: true`를 주며 TSL vertex position만 흔든다. 인스턴스 geometry와 instance matrix는 그대로 유지하고 CPU별 개체 업데이트나 noise render target을 만들지 않는다.

`WaterMaterial`의 shoreline 계산은 geometry와 같은 중심과 크기를 받아야 한다. 직사각형 물은 `center`와 반폭/반깊이 `extent`, 원형 호수는 `center`와 `radius`를 전달한다. 관동 v3 기본값은 남쪽 바다 `center=[-68,202]`, `extent=[91,33]`, 발전소 호수 `center=[122,-50]`, `radius=24`다. 파도, Fresnel 색, 얕은 물과 거품은 TSL 산술만 사용하며 별도 화면 texture나 매 프레임 render target을 만들지 않는다.

## 제한된 브라우저 측정

`artifacts/gpu-renderer/benchmark.json`은 640x360, DPR 1, headless 조건의 작은 backend 비교다. 16,000개 instanced grass와 물 한 장을 12회 `renderAsync`했고 shader 첫 컴파일 시간을 포함한다. 설치 Chrome WebGPU는 평균 6.70ms, 강제 WebGL2 fallback은 7.92ms였으며 둘 다 프레임당 3 draw call과 64,003 triangles였다. 이는 특정 브라우저의 제한된 비교이며 전체 게임의 안정 프레임 시간이나 다른 GPU의 성능을 대표하지 않는다.

전체 앱 smoke에서는 WebGPU backend, daylight environment, 78 textures와 82 geometries 로드를 확인했다. Rust API를 함께 띄우지 않아 `/api/local-brains/step-batch`가 403을 반환했으므로 신경 처리 통신은 이 측정의 검증 범위가 아니다. trainer, 동굴 전환과 최종 화면 구도는 통합 브라우저 시나리오에서 별도로 확인한다.
