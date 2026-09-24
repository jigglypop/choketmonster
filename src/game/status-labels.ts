/** Korean names for engine ailment ids; ailments without a battle label stay unnamed. */
export const STATUS_LABELS: Readonly<Record<string, string>> = {
  poison: '독', burn: '화상', paralysis: '마비', sleep: '잠듦', freeze: '얼음', confusion: '혼란',
  trap: '속박', 'leech-seed': '씨뿌리기', infatuation: '헤롱헤롱', yawn: '하품', disable: '사슬묶기',
};

export function statusLabel(status?: string): string | undefined {
  return status ? STATUS_LABELS[status] : undefined;
}
