import { createGaesupRuntime, type GaesupRuntime } from 'gaesup-world/runtime';
import type { GaesupPlugin, PluginContext } from 'gaesup-world/plugins';

const PLUGIN_ID = 'choketmon.field-simulation';
const SYSTEM_ID = 'choketmon.field-connectome-step';
const SERVICE_ID = 'choketmon.field-connectome-step-service';

export type FieldStep = { tick: number; deltaMs: number; elapsedMs: number };
export type FieldStepCallback = (step: FieldStep) => void;
export type FieldRuntimeAdapter = {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stepOnce(): void;
  dispose(): Promise<void>;
};

type FieldStepSystem = { readonly id: typeof SYSTEM_ID; step(): void };

/**
 * Runs the field connectome callback through a system registered in a real
 * Gaesup plugin runtime. Rendering remains owned by the existing Three scene.
 */
export class GaesupFieldRuntime implements FieldRuntimeAdapter {
  readonly intervalMs: number;
  readonly runtime: GaesupRuntime;
  private readonly system: FieldStepSystem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private setupComplete = false;
  private disposed = false;
  private tick = 0;

  constructor(onStep: FieldStepCallback, intervalMs = 300) {
    if (typeof onStep !== 'function') throw new TypeError('onStep callback is required.');
    if (!Number.isInteger(intervalMs) || intervalMs < 200 || intervalMs > 400) {
      throw new RangeError('Field runtime interval must be an integer from 200 to 400 ms.');
    }
    this.intervalMs = intervalMs;
    this.system = {
      id: SYSTEM_ID,
      step: () => onStep({ tick: ++this.tick, deltaMs: this.intervalMs, elapsedMs: this.tick * this.intervalMs }),
    };
    const plugin: GaesupPlugin = {
      id: PLUGIN_ID,
      name: 'Choketmon field connectome simulation',
      version: '1.0.0',
      runtime: 'client',
      capabilities: ['simulation:field-connectome'],
      setup: (context: PluginContext) => {
        context.systems.register(SYSTEM_ID, this.system, PLUGIN_ID);
        context.services.register(SERVICE_ID, this.system, PLUGIN_ID);
      },
    };
    this.runtime = createGaesupRuntime({ plugins: [plugin], pluginRuntime: 'client' });
  }

  async start(): Promise<void> {
    this.assertUsable();
    if (!this.setupComplete) {
      await this.runtime.setup();
      const registered = this.runtime.requireService<FieldStepSystem>(SERVICE_ID);
      if (registered !== this.system) throw new Error('Gaesup field step system registration failed.');
      this.setupComplete = true;
    }
    this.resume();
  }

  pause(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    this.assertUsable();
    if (!this.setupComplete) throw new Error('Call start() before resume().');
    if (this.timer !== undefined) return;
    const registered = this.runtime.requireService<FieldStepSystem>(SERVICE_ID);
    this.timer = setInterval(() => registered.step(), this.intervalMs);
  }

  stepOnce(): void {
    this.assertUsable();
    if (!this.setupComplete) throw new Error('Call start() before stepOnce().');
    this.runtime.requireService<FieldStepSystem>(SERVICE_ID).step();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.pause();
    if (this.setupComplete) await this.runtime.dispose();
    this.disposed = true;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Gaesup field runtime is disposed.');
  }
}

export function createFieldRuntime(onStep: FieldStepCallback, intervalMs = 300): FieldRuntimeAdapter {
  return new GaesupFieldRuntime(onStep, intervalMs);
}
