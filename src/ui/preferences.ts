export type InterfacePreferences = {
  fontScale: number;
  density: 'comfortable' | 'compact';
  battlePosition: 'right' | 'left' | 'bottom';
  teamLayout: 'split' | 'stack';
  contrast: 'normal' | 'high';
};

export const DEFAULT_INTERFACE: InterfacePreferences = {
  fontScale: 1, density: 'comfortable', battlePosition: 'right', teamLayout: 'split', contrast: 'normal',
};

function sanitize(value: unknown): InterfacePreferences {
  const input = value && typeof value === 'object' ? value as Partial<InterfacePreferences> : {};
  return {
    fontScale: typeof input.fontScale === 'number' && Number.isFinite(input.fontScale) ? Math.min(1.5, Math.max(1, input.fontScale)) : 1,
    density: input.density === 'compact' ? 'compact' : 'comfortable',
    battlePosition: input.battlePosition === 'left' || input.battlePosition === 'bottom' ? input.battlePosition : 'right',
    teamLayout: input.teamLayout === 'stack' ? 'stack' : 'split',
    contrast: input.contrast === 'high' ? 'high' : 'normal',
  };
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('choketmon-interface', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readInterfacePreferences(): Promise<InterfacePreferences> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('preferences').objectStore('preferences').get('current');
      request.onsuccess = () => resolve(sanitize(request.result));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function writeInterfacePreferences(value: InterfacePreferences): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('preferences', 'readwrite');
      transaction.objectStore('preferences').put(sanitize(value), 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('화면 설정을 저장하지 못했습니다.'));
    });
  } finally { db.close(); }
}

export function applyInterfacePreferences(value: InterfacePreferences): void {
  const root = document.documentElement;
  root.style.setProperty('--ui-font-scale', String(value.fontScale));
  root.dataset.uiDensity = value.density;
  root.dataset.battlePosition = value.battlePosition;
  root.dataset.teamLayout = value.teamLayout;
  root.dataset.uiContrast = value.contrast;
}
