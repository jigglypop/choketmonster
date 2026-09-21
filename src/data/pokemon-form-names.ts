/** Keep source identifiers stable while presenting regional and Mega forms in Korean. */
export function pokemonFormKoreanName(speciesName: string, identifier: string): { name: string; formName: string } | undefined {
  if (identifier.endsWith('-alola')) return { name: `알로라 ${speciesName}`, formName: '알로라의 모습' };
  if (!/-mega(?:-[xyz])?$/.test(identifier)) return;
  const letter = identifier.match(/-mega-([xyz])$/)?.[1].toUpperCase();
  const variant = identifier.includes('-female-') ? '암컷' : identifier.includes('-male-') ? '수컷'
    : identifier.includes('-original-') ? '500년 전의 색' : identifier.includes('-curly-') ? '주황색'
    : identifier.includes('-droopy-') ? '분홍색' : identifier.includes('-stretchy-') ? '노란색' : undefined;
  const suffix = `${letter ? ` ${letter}` : ''}${variant ? ` (${variant})` : ''}`;
  return { name: `메가${speciesName}${suffix}`, formName: `메가진화${suffix}` };
}
