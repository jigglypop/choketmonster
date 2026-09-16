/** Pixel audit of pinned GLBs, not texture replacements. Source images stay intact.
 * See docs/model-texture-pixel-audit-2026-09-17.md for the source and exclusions. */
export const OPAQUE_POKEMON_SURFACES: Readonly<Record<number, readonly string[]>> = {
  271: ['body', 'eye', 'mouth'], 480: ['Mouth', 'material', 'Body00'],
  726: ['body_a_01'], 814: ['body_a_00', 'body_b', 'body_a_01'],
  817: ['Body00'], 819: ['Body', 'Eye', 'Mouth'],
  820: ['BodyB', 'BodyC00Vco', 'BodyA02Vco', 'Eye'],
  821: ['BodyVco01', 'Eye'], 822: ['BodyA00', 'Eye', 'BodyB00'],
  823: ['BodyBEnv', 'Eye', 'BodyA'], 828: ['Body'],
  829: ['Body00', 'Eye', 'Mouth'], 834: ['Eye', 'BodyA00', 'BodyB00'],
  838: ['Eye', 'BodyB00Inc', 'BodyA01EnvVco', 'BodyC00EnvIncVco', 'BodyC01EnvIncVco', 'BodyB02IncVco'],
  843: ['Body', 'Eye'], 862: ['pm0862_00_31-BodyA00', 'pm0862_00_31-LEye', 'pm0862_00_31-BodyB00'],
  891: ['body_b', 'body_a', 'l_eye'], 896: ['pm0896_00_00-BodyA'],
  897: ['pm0898_13_00-BodyCVco', 'pm0898_13_00-LEye', 'pm0898_13_00-Mouth'],
  898: ['pm0898_13_00-BodyCVco', 'pm0898_13_00-LEye', 'pm0898_13_00-Mouth'],
  914: ['body_a_00', 'body_b_00', 'r_eye', 'body_c'],
  916: ['pm0916_00_00-Body00', 'pm0916_00_00-LEye'],
  920: ['Body'], 921: ['Body'], 922: ['Body'], 923: ['Body'],
  941: ['body_a_00', 'body_b_00'], 942: ['body_a', 'body_b', 'r_eye'],
  945: ['body_a_01', 'body_b_00'], 962: ['Body'], 987: ['body_a', 'body_b_01'],
  994: ['l_eye'], 995: ['body_b', 'body_a_00'], 996: ['Body.001'],
  997: ['Body', 'Material.001'], 998: ['BodyB', 'BodyA'],
  1014: ['body_a', 'body_b_00'], 1015: ['body_b'],
  1016: ['pm1016_00_00-BodyB01', 'pm1016_00_00-BodyA01Env', 'pm1016_00_00-LEye'],
  1018: ['body_a_01', 'body_a_00', 'body_b_01'], 1020: ['body_a_00', 'body_b_01'],
  1023: ['body_a', 'body_b_00'],
};

/** Corviknight's armored feathers are metal; its eyes are not. */
export const POKEMON_METAL_SURFACES: Readonly<Record<number, readonly string[]>> = {
  823: ['BodyA', 'BodyBEnv'],
};
