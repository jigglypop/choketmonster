import { describe, expect, it } from 'vitest';
import { Color, MeshStandardMaterial, Texture } from 'three';
import { createWaterNodeMaterial, normalizeStandardMaterial, regionTrailColor, worldSurfaceColor } from '../src/openworld/materials';
import { getWorldAtlas } from '../src/openworld/atlas';

describe('open-world TSL materials', () => {
  it('preserves imported PBR appearance while adding node wind', () => {
    const map = new Texture(), normalMap = new Texture(), roughnessMap = new Texture();
    const source = new MeshStandardMaterial({
      color: '#87a65d', map, normalMap, roughnessMap, roughness: .71, metalness: .2,
      transparent: true, opacity: .83, alphaTest: .12,
    });
    source.name = 'authored-grass'; source.normalScale.set(.6, .8);
    const material = normalizeStandardMaterial(source, { wind: true });
    expect(material.isMeshStandardNodeMaterial).toBe(true);
    expect(material).toMatchObject({ name: source.name, map, normalMap, roughnessMap, transparent: true, opacity: .83, alphaTest: .12 });
    expect(material.color.getHex()).toBe(source.color.getHex());
    expect(material.normalScale).toEqual(source.normalScale);
    expect(material.positionNode).not.toBeNull();
    expect(material.userData.openWorldNodeEffect).toBe('standard+wind');
    material.dispose(); source.dispose(); map.dispose(); normalMap.dispose(); roughnessMap.dispose();
  });

  it('binds shoreline math to the geometry center and extent', () => {
    const sea = createWaterNodeMaterial({ center: [-68, 202], extent: [91, 33] });
    const lake = createWaterNodeMaterial({ lake: true, center: [122, -50], radius: 24 });
    expect(sea.userData).toMatchObject({ openWorldNodeEffect: 'water:rectangular', openWorldWaterBounds: { center: [-68, 202], extent: [91, 33], radius: 24 } });
    expect(lake.userData).toMatchObject({ openWorldNodeEffect: 'water:radial', openWorldWaterBounds: { center: [122, -50], radius: 24 } });
    expect(sea.colorNode).not.toBeNull(); expect(sea.normalNode).not.toBeNull();
    expect(lake.colorNode).not.toBeNull(); expect(lake.normalNode).not.toBeNull();
    sea.dispose(); lake.dispose();
  });

  it('uses each atlas palette for grass, road, town and water vertex tint', () => {
    const kanto = getWorldAtlas('kanto'), johto = getWorldAtlas('johto');
    const pallet = kanto.locations.find(item => item.id === 'pallet')!;
    expect(worldSurfaceColor(kanto, { height: 0, biome: 'meadow', blocked: false }, pallet.x, pallet.z).getHexString())
      .not.toBe(worldSurfaceColor(kanto, { height: 0, biome: 'meadow', blocked: false }, 0, 0).getHexString());
    expect(regionTrailColor(kanto)).not.toBe(regionTrailColor(johto));
    expect(worldSurfaceColor(johto, { height: 0, biome: 'lake', blocked: false }, 0, 0).getHexString())
      .toBe(new Color(johto.palette.water).getHexString());
  });
});
