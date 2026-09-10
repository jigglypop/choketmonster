# Gaesup World 런타임 통합

## 배포판과 권리 확인

2026-09-10 기준 npm의 `latest` 태그는 `gaesup-world@1.0.30`이다. 요청에서 비교한
`1.0.6`도 실제 배포된 버전이지만 최신판은 아니다. `1.0.30`은
`gaesup-world/runtime`을 ESM과 CommonJS export로 공개한다.

- npm 패키지: https://www.npmjs.com/package/gaesup-world
- 공식 저장소: https://github.com/jigglypop/gaesup-world
- 런타임 구현: https://github.com/jigglypop/gaesup-world/blob/main/src/core/runtime/createGaesupRuntime.ts
- 라이선스: 저장소 `LICENSE.txt`와 npm 패키지 메타데이터가 MIT로 명시한다.

이 프로젝트는 `1.0.30`을 사용하며 기존 vanilla Three 렌더러는 그대로 둔다.

## 공개 런타임 API에서 확인한 범위

공개 `createGaesupRuntime({ plugins, pluginRuntime })`은 `setup()`과 `dispose()`,
plugin registry, service 조회를 제공한다. plugin의 `setup(context)`에서는
`context.systems.register(id, value, pluginId)`로 system extension을 등록할 수 있다.
공식 README도 runtime factory가 선택한 domain plugin을 묶고 각 plugin이 service, system,
save domain, UI extension을 등록하는 용도라고 설명한다.

하지만 공개 `GaesupRuntime`에는 등록된 system을 주기적으로 실행하는 `tick`, `step`,
`start` 메서드가 없다. `systems`는 lifecycle scheduler가 아니라 extension registry다.
따라서 `src/three/field-runtime.ts`는 다음 경계를 사용한다.

1. 공식 `createGaesupRuntime`으로 client runtime을 만든다.
2. `choketmon.field-simulation` plugin이 실제 step system을 `context.systems`에 등록한다.
3. 같은 system을 service로도 등록하고, `runtime.setup()` 뒤 동일한 인스턴스가 등록됐는지 확인한다.
4. adapter의 200~400ms 고정 `setInterval`은 등록된 service의 `step()`만 호출한다.
5. 지연 시간을 누적 계산하지 않으므로 숨김 탭 복귀 때 밀린 step을 따라잡지 않는다.
6. `pause`, `resume`, `stepOnce`, `dispose`가 타이머와 Gaesup plugin lifecycle을 정리한다.

이는 자체 `requestAnimationFrame` 루프로 라이브러리 이름만 감싼 구현이 아니다. 실제
Gaesup plugin setup과 system/service registry를 통과한다. 고정 주기 scheduling만 adapter가
소유하는 이유는 현재 공개 runtime API가 system 실행 scheduler를 제공하지 않기 때문이다.

## 공개 어댑터 API

```ts
const fieldRuntime = createFieldRuntime(onStep, 300);
await fieldRuntime.start();
fieldRuntime.pause();
fieldRuntime.stepOnce();
fieldRuntime.resume();
await fieldRuntime.dispose();
```

`onStep`은 `{ tick, deltaMs, elapsedMs }`를 받는다. `deltaMs`는 고정 주기이며
`elapsedMs`도 실제 벽시계가 아니라 누적 simulation time이다. Three 렌더링 RAF와 분리되어
있고, 화면 숨김 처리에서는 `pause()`/`resume()`을 호출한다.

## peer dependency와 번들 영향

`gaesup-world/runtime` 배포 ESM은 runtime-only 사용에서도 React, React Three Fiber,
Drei/Rapier 계열 모듈을 정적으로 import한다. 이 adapter가 React component를 렌더링하지
않더라도 브라우저 번들 해석에는 선언된 peer 설치가 필요하다. 그래서 React 19, R3F 9,
Drei 10, Rapier 2 계열 peer를 설치했다.

최종 의존성은 `gaesup-world@1.0.30`, `three@0.178.0`, `@types/three@0.178.1`,
`react@19.2.8`, `react-dom@19.2.8`로 고정했다. Gaesup의 Three 범위와 Fiber 9.7의
React `<19.3` 범위를 모두 만족한다. 우회 옵션 없이 `npm ls`와
`npm ci --dry-run --ignore-scripts`가 통과했다. 기존 GLTF 렌더러도 이 버전에서 사용한다.

## 검증

```bash
npx tsx scripts/probe-gaesup.mjs
```

probe는 실제 runtime setup과 system 등록, 200ms 자동 step, pause 중 정지, 수동 한 step,
resume, dispose를 확인한다. 이어 Vite가 adapter와 `gaesup-world/runtime`을 브라우저용 ESM으로
bundle하고, headless Chromium에서 해당 bundle을 import해 실제 callback 실행까지 검사한다.
