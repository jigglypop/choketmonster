import type { WebGLRenderer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { detachRendererTextures, trackRenderObjects } from '../three/render-objects';

export type OpenWorldRendererBackend = 'webgpu' | 'webgl2-fallback';
export type OpenWorldRendererInfo = {
  backend: OpenWorldRendererBackend;
  initializedAt: number;
  frame: number;
  render: { calls: number; totalRenderCalls: number; frameCalls: number; drawCalls: number; triangles: number; points: number; lines: number; timestamp: number };
};

type TaggedRenderer = WebGPURenderer & { userData?: Record<string, unknown> };
export type OpenWorldRendererDefaults = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  antialias?: boolean;
  alpha?: boolean;
  powerPreference?: WebGLPowerPreference;
};
const rendererInfo = new WeakMap<object, { backend: OpenWorldRendererBackend; initializedAt: number }>();

/**
 * R3F async `gl` factory. Three r178's WebGPURenderer owns the WebGL2 fallback,
 * so TSL materials use the same node pipeline on both backends.
 */
export async function createOpenWorldRenderer(
  defaults: OpenWorldRendererDefaults,
  options: { forceWebGL?: boolean; onDeviceLost?: () => void } = {},
): Promise<WebGLRenderer> {
  const renderer = new WebGPURenderer({
    canvas: defaults.canvas,
    antialias: defaults.antialias ?? true,
    // The world always owns the full viewport. Keep its clear pixels opaque so
    // the page fallback gradient cannot replace the cave background.
    alpha: false,
    // Chromium ignores this adapter hint on Windows and warns on every init.
    powerPreference: typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
      ? undefined : defaults.powerPreference === 'default' ? undefined : defaults.powerPreference ?? 'high-performance',
    forceWebGL: options.forceWebGL ?? false,
  }) as TaggedRenderer;
  const originalDeviceLost = renderer.onDeviceLost.bind(renderer);
  renderer.onDeviceLost = info => {
    originalDeviceLost(info);
    options.onDeviceLost?.();
  };
  await renderer.init();
  trackRenderObjects(renderer);
  const backend: OpenWorldRendererBackend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'webgpu' : 'webgl2-fallback';
  const initializedAt = performance.now();
  rendererInfo.set(renderer, { backend, initializedAt });
  renderer.userData = { ...(renderer.userData ?? {}), openWorldBackend: backend, openWorldInitializedAt: initializedAt };
  // R3F unmount only calls gl.forceContextLoss(). WebGPURenderer has none, so every
  // visit to the map leaked a GPU device or WebGL2 context until the browser evicted
  // the oldest one: the team portrait. three ignores a 'destroyed' device loss.
  Object.assign(renderer, { forceContextLoss: () => {
    const device = (renderer.backend as { device?: { destroy(): void } }).device;
    detachRendererTextures(renderer);
    renderer.dispose();
    device?.destroy();
  } });
  return renderer as unknown as WebGLRenderer;
}

/** Lightweight render counters for in-browser WebGPU/WebGL2 comparisons. */
export function getOpenWorldRendererInfo(renderer: object): OpenWorldRendererInfo | undefined {
  const tag = rendererInfo.get(renderer);
  if (!tag) return undefined;
  const rendererStats = (renderer as { info?: { frame?: number; render?: Partial<OpenWorldRendererInfo['render']> } }).info;
  const info = rendererStats?.render;
  return {
    ...tag,
    frame: rendererStats?.frame ?? 0,
    render: {
      // `calls` follows WebGLRenderer.info.render semantics for existing probes.
      calls: info?.drawCalls ?? info?.calls ?? 0,
      totalRenderCalls: info?.calls ?? 0,
      frameCalls: info?.frameCalls ?? 0,
      drawCalls: info?.drawCalls ?? 0,
      triangles: info?.triangles ?? 0,
      points: info?.points ?? 0,
      lines: info?.lines ?? 0,
      timestamp: info?.timestamp ?? 0,
    },
  };
}
