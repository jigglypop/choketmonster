import { BoxGeometry, ConeGeometry, type BufferGeometry } from 'three';
import { MergedBuilder, at } from './town-details';

/** Scenery `fence` placements keep the former GLB's footprint: 3.33 m along local X, centred, base at y = 0. */
const FENCE_LENGTH = 3.33;
const WHITE = '#fbf8f1', RAIL = '#ece6d9', POST = '#f5f0e6';

let geometry: BufferGeometry | undefined;
/** One white picket section as a single vertex-coloured geometry, instanced like the other route details. */
export function picketFenceGeometry(): BufferGeometry {
  if (geometry) return geometry;
  const builder = new MergedBuilder(), half = FENCE_LENGTH / 2 - .07;
  for (const x of [-half, half]) {
    builder.add(new BoxGeometry(.13, 1.02, .13), POST, at(x, .41, 0));
    builder.add(new ConeGeometry(.092, .13, 4), POST, at(x, .985, 0, Math.PI / 4));
  }
  for (const y of [.26, .6]) builder.add(new BoxGeometry(FENCE_LENGTH - .14, .07, .045), RAIL, at(0, y, -.045));
  const pickets = 10, span = (half * 2 - .24) / (pickets - 1);
  for (let index = 0; index < pickets; index++) {
    const x = -half + .12 + index * span, height = .72 + (index % 2) * .03;
    builder.add(new BoxGeometry(.1, height, .035), WHITE, at(x, height / 2 - .02, 0));
    // Square pyramid tip; flattened to the picket's depth.
    builder.add(new ConeGeometry(.0707, .1, 4), WHITE, at(x, height + .03, 0, 0, 1, 1, .35).multiply(at(0, 0, 0, Math.PI / 4)));
  }
  return geometry = builder.build();
}
