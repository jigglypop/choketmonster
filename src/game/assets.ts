// Local development uses verified downloaded bytes. Published builds reference
// the pinned asset owners' public endpoints instead of redistributing binaries.
const remote = import.meta.env?.PROD || import.meta.env?.VITE_REMOTE_POKEMON_ASSETS === 'true';
export const POKEMON_MODEL_COMMIT = '00d96f7f18894055e7f1db44fa0df6462e5e4c8a';
export const POKEMON_SPRITE_COMMIT = '2ecb4eeacd5a1718621fc30f12772e3f60d830b9';
export function pokemonModelUrl(id: number): string {
  return remote ? `https://raw.githubusercontent.com/06wj/pokemon/${POKEMON_MODEL_COMMIT}/public/models/${String(id).padStart(3, '0')}/model.glb` : `/models/pokemon/${id}.glb`;
}
export function pokemonSpriteUrl(id: number, back = false): string {
  return remote ? `https://raw.githubusercontent.com/PokeAPI/sprites/${POKEMON_SPRITE_COMMIT}/sprites/pokemon/${back ? 'back/' : ''}${id}.png` : `/pokemon/${back ? 'back/' : ''}${id}.png`;
}
