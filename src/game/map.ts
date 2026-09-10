import type { Region } from './regions';

export type MapPosition = { x: number; y: number; steps: number };
const COLS = 24, ROWS = 15, TILE = 32;
export const startPosition = (): MapPosition => ({ x: 12, y: 10, steps: 0 });
const sprites = new Map<number, HTMLImageElement>();
function sprite(id: number) {
  if (!sprites.has(id)) { const img = new Image(); img.src = `/pokemon/${id}.png`; sprites.set(id, img); }
  return sprites.get(id)!;
}
export function tileAt(x: number, y: number): 'tree' | 'water' | 'grass' | 'path' | 'building' {
  if (x < 1 || y < 1 || x >= COLS - 1 || y >= ROWS - 1) return 'tree';
  if (x >= 17 && x <= 21 && y >= 9 && y <= 12) return 'water';
  if ((x >= 3 && x <= 6 && y >= 3 && y <= 5) || (x >= 16 && x <= 20 && y >= 2 && y <= 4)) return 'building';
  if (y === 7 || x === 12 || (y >= 10 && x >= 9 && x <= 14)) return 'path';
  if ((x <= 8 && y >= 9 && y <= 12) || (x >= 15 && y >= 5 && y <= 6) || (x >= 8 && x <= 10 && y >= 2 && y <= 5)) return 'grass';
  return 'path';
}
export function walk(position: MapPosition, dx: number, dy: number): boolean {
  const x = position.x + dx, y = position.y + dy, tile = tileAt(x, y);
  if (tile === 'tree' || tile === 'water' || tile === 'building') return false;
  position.x = x; position.y = y; position.steps++; return true;
}
/** Drawing never consumes the game's RNG. Map collision and encounter steps are separate. */
export function drawMap(canvas: HTMLCanvasElement, region: Region, position: MapPosition, companion: number, now: number) {
  canvas.width = COLS * TILE; canvas.height = ROWS * TILE;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  const coastal = /coast|seafoam|isles/.test(region.id), rocky = /cave|cavern|road/.test(region.id);
  const green = rocky ? '#b4bca2' : coastal ? '#bed7af' : '#b9d89b';
  c.fillStyle = green; c.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const px = x * TILE, py = y * TILE, t = tileAt(x, y), hash = (x * 17 + y * 29) % 11;
    if (y === 7 || x === 12 || (y >= 10 && x >= 9 && x <= 14)) {
      c.fillStyle = '#e8dbaa'; c.fillRect(px, py, TILE, TILE);
      c.fillStyle = '#d8cd9e'; c.fillRect(px + 5 + hash, py + 14, 3, 2); c.fillRect(px + 20, py + hash, 2, 2);
    } else if (t === 'grass') {
      c.fillStyle = '#80b777'; c.fillRect(px, py, TILE, TILE);
      c.fillStyle = '#6a9c64';
      for (let k = 0; k < 4; k++) { const gx = px + 3 + (k % 2) * 16, gy = py + 7 + Math.floor(k / 2) * 15; c.fillRect(gx, gy, 2, 6); c.fillRect(gx + 4, gy - 3, 2, 9); c.fillRect(gx + 8, gy, 2, 6); }
      c.fillStyle = '#a0ce84'; c.fillRect(px + 12, py + 15, 2, 4);
    } else if (t === 'water') {
      c.fillStyle = '#78b6ba'; c.fillRect(px, py, TILE, TILE);
      c.fillStyle = '#a6d5d1'; c.fillRect(px + (Math.floor(now / 700) + x * 7) % 22, py + 12, 9, 2); c.fillStyle = '#86c0c2'; c.fillRect(px + 8, py + 23, 13, 2);
    } else if (t !== 'tree') {
      c.fillStyle = '#accd8d'; c.fillRect(px + 3 + hash, py + 12, 3, 3);
      if (hash === 2 || hash === 7) { c.fillStyle = '#f3ecb5'; c.fillRect(px + 21, py + 7, 3, 3); c.fillStyle = '#829c66'; c.fillRect(px + 22, py + 10, 1, 4); }
    }
  }
  // Tree canopies overlap the grid to give the forest a softer silhouette.
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (tileAt(x, y) === 'tree') {
    const px = x * TILE + 16, py = y * TILE + 16;
    c.fillStyle = '#638b65'; c.fillRect(px - 12, py + 9, 29, 17);
    c.fillStyle = '#56794f'; c.fillRect(px - 3, py + 5, 7, 17);
    c.fillStyle = '#57875e'; c.fillRect(px - 15, py - 12, 30, 22); c.fillRect(px - 9, py - 20, 18, 34);
    c.fillStyle = '#709962'; c.fillRect(px - 11, py - 14, 20, 13); c.fillStyle = '#84a871'; c.fillRect(px - 7, py - 16, 10, 6);
  }
  const house = (x: number, y: number, width: number, color: string, sign: string) => {
    c.fillStyle = '#67835444'; c.fillRect(x + 7, y + 16, width + 3, 94);
    c.fillStyle = '#f3ecd0'; c.fillRect(x, y + 23, width, 74);
    c.fillStyle = color; c.fillRect(x - 8, y + 12, width + 16, 34); c.fillRect(x, y, width, 16);
    c.fillStyle = '#ffffff24'; c.fillRect(x, y + 4, width, 5);
    c.fillStyle = '#759595'; c.fillRect(x + 12, y + 56, 24, 20); c.fillRect(x + width - 36, y + 56, 24, 20);
    c.fillStyle = '#fff8df'; c.fillRect(x + 23, y + 56, 2, 20); c.fillRect(x + width - 25, y + 56, 2, 20);
    c.fillStyle = '#526c64'; c.fillRect(x + width / 2 - 10, y + 65, 20, 32);
    c.fillStyle = '#fff8e1'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.fillText(sign, x + width / 2, y + 33);
  };
  house(3 * TILE, 3 * TILE - 10, 4 * TILE, '#c57d71', 'P · CENTER');
  house(16 * TILE, 2 * TILE - 10, 5 * TILE, '#718ba3', 'GYM');
  // Wayfinding signs and fence.
  c.fillStyle = '#b1a482'; for (let x = 15; x <= 21; x++) { c.fillRect(x * TILE + 6, 8 * TILE, 4, 20); c.fillRect(x * TILE, 8 * TILE + 5, TILE, 4); }
  const bob = Math.sin(now / 280) > 0 ? 1 : 0, px = position.x * TILE + 16, py = position.y * TILE + 15;
  const mon = sprite(companion);
  c.fillStyle = '#4c70473a'; c.beginPath(); c.ellipse(px - 30, py + 15, 14, 5, 0, 0, Math.PI * 2); c.fill();
  if (mon.complete && mon.naturalWidth) c.drawImage(mon, px - 60, py - 32 + bob, 60, 60);
  c.fillStyle = '#415d5044'; c.fillRect(px - 9, py + 16, 21, 5);
  c.fillStyle = '#3d566b'; c.fillRect(px - 6, py + 7, 5, 12); c.fillRect(px + 2, py + 7, 5, 12);
  c.fillStyle = '#f7ecd4'; c.fillRect(px - 8, py - 3, 16, 15);
  c.fillStyle = '#4f7490'; c.fillRect(px - 5, py, 10, 12);
  c.fillStyle = '#e6b18d'; c.fillRect(px - 6, py - 13, 12, 11);
  c.fillStyle = '#66533e'; c.fillRect(px - 8, py - 15, 16, 6);
  c.fillStyle = '#cb7264'; c.fillRect(px - 8, py - 21, 16, 9); c.fillRect(px - 10, py - 14, 21, 4);
  c.fillStyle = '#fcf1dc'; c.fillRect(px - 3, py - 19, 6, 5);
}
