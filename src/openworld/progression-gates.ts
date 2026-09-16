import type { KantoGate, KantoGym, KantoLocation } from './kanto';

export function progressionRequirement(required: number, earned: number, gyms: readonly KantoGym[], label = '배지'): string {
  const prerequisite = gyms.find(gym => gym.badge === required);
  return `${prerequisite ? `${prerequisite.name} 완료 · ` : ''}${label} ${required}개 필요 (현재 ${earned}개)`;
}

/** Put signs on the actual ownership boundary, not the geometric road midpoint.
 * Long hub roads can pass through a third location's territory. */
export function terrainProgressGates(
  locations: readonly KantoLocation[], connections: ReadonlyArray<readonly [string, string]>,
  locationAt: (x: number, z: number) => KantoLocation, gyms: readonly KantoGym[], badgeLabel = '배지',
): KantoGate[] {
  const byId = new Map(locations.map(location => [location.id, location]));
  const gates: KantoGate[] = [];
  for (const [from, to] of connections) {
    const a = byId.get(from)!, b = byId.get(to)!;
    const point = (t: number) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    const owner = (t: number) => { const p = point(t); return locationAt(p.x, p.z); };
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2);
    let previous = owner(0);
    for (let step = 1; step <= steps; step++) {
      const next = owner(step / steps);
      if (next.requiredBadges !== previous.requiredBadges) {
        let low = (step - 1) / steps, high = step / steps;
        for (let iteration = 0; iteration < 20; iteration++) {
          const middle = (low + high) / 2;
          if (owner(middle).requiredBadges === previous.requiredBadges) low = middle; else high = middle;
        }
        const locked = next.requiredBadges > previous.requiredBadges ? next : previous;
        const required = locked.requiredBadges, prerequisite = gyms.find(gym => gym.badge === required);
        gates.push({ id: `${from}:${to}:${step}`, from, to, position: point((low + high) / 2),
          requiredBadges: required, badgeLabel, terrainBoundary: true,
          reason: `${locked.name} 방면 · ${prerequisite ? `${prerequisite.name} 완료 후 개방` : `${badgeLabel} ${required}개 필요`}` });
      }
      previous = next;
    }
  }
  return gates;
}
