import { Color } from 'three';

const NAMED_COLORS: Record<string, string> = {
  pallet: '#e8dfc5', viridian: '#4d9b61', pewter: '#83858a', cerulean: '#4e94c8', vermilion: '#c5934d',
  lavender: '#9b77b4', celadon: '#74a86a', saffron: '#d6b54c', fuchsia: '#d87498', cinnabar: '#b84d45',
  'new-bark': '#81b68b', cherrygrove: '#cc879b', violet: '#9484bc', azalea: '#af7658', goldenrod: '#d4ad4e',
  ecruteak: '#ac7869', olivine: '#77a8b6', cianwood: '#68a6a0', mahogany: '#bf8f5e', blackthorn: '#7788a4',
};
export function scenerySeed(id: string): number {
  let value = 2166136261;
  for (let index = 0; index < id.length; index++) value = Math.imul(value ^ id.charCodeAt(index), 16777619);
  return value >>> 0;
}
const styles = new Map<string, { color: string; paving: number; height: number }>();
/** Stable town identity with the same building footprint and draw budget. */
export function townStyle(id: string) {
  let style = styles.get(id);
  if (!style) {
    const seed = scenerySeed(id);
    style = { color: NAMED_COLORS[id] ?? `#${new Color().setHSL((seed % 360) / 360, .28, .58).getHexString()}`,
      paving: seed % 3, height: .9 + (seed % 5) * .05 };
    styles.set(id, style);
  }
  return style;
}

export function townPavingCells(id: string): Array<[number, number, boolean]> {
  const pattern = townStyle(id).paving, result: Array<[number, number, boolean]> = [];
  for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) {
    if (Math.hypot(x, z) > 7.1) continue;
    const accent = pattern === 0 ? Math.abs(x) <= 1 || Math.abs(z) <= 1
      : pattern === 1 ? (Math.abs(x) + Math.abs(z)) % 4 === 0 : Math.max(Math.abs(x), Math.abs(z)) % 3 === 0;
    result.push([x, z, accent]);
  }
  return result;
}
