type Stage = 'connectome' | 'world';
const initial = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#startup-loading');
const template = initial?.cloneNode(true) as HTMLElement | undefined;

/** Progress follows completed work; there is no timer that pretends to load assets. */
export class LoadingScreen {
  private progress = { connectome: -1, world: -1 };
  constructor(readonly element: HTMLElement) {}
  stage(stage: Stage, percent: number, detail: string) {
    if (!this.element.querySelector(`[data-loading-bar="${stage}"]`)) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    if (this.progress[stage] !== value) {
      this.progress[stage] = value;
      this.element.querySelector<HTMLProgressElement>(`[data-loading-bar="${stage}"]`)!.value = value;
      this.element.querySelector(`[data-loading-percent="${stage}"]`)!.textContent = `${value}%`;
    }
    const text = this.element.querySelector(`[data-loading-detail="${stage}"]`)!;
    if (text.textContent !== detail) text.textContent = detail;
  }
  status(message: string) {
    const text = this.element.querySelector('[data-loading-status]')!;
    if (text.textContent !== message) text.textContent = message;
  }
  fail(message: string, retry: () => void = () => location.reload()) {
    this.element.hidden = false;
    this.element.dataset.failed = 'true';
    this.status(message);
    const button = this.element.querySelector<HTMLButtonElement>('[data-loading-retry]')!;
    button.hidden = false;
    button.onclick = () => { button.hidden = true; delete this.element.dataset.failed; retry(); };
  }
  remove() { this.element.remove(); }
}

export const startupLoading = initial ? new LoadingScreen(initial) : undefined;
export function createWorldLoading(host: HTMLElement): LoadingScreen | undefined {
  if (!template) return undefined;
  const element = template.cloneNode(true) as HTMLElement;
  element.hidden = true;
  element.removeAttribute('id');
  element.classList.add('adventure-loading--world');
  element.setAttribute('aria-label', '3D 모험 준비');
  host.append(element);
  const loading = new LoadingScreen(element);
  loading.stage('connectome', 100, 'Male CNS 회로와 이동 정책 준비 완료');
  loading.status('3D 장면과 파트너를 준비하고 있습니다.');
  return loading;
}
