export type WorldPoint = { x: number; z: number; y?: number };

export type WorldHeading = 0 | 1 | 2 | 3 | 4;

export type WorldPlayer = WorldPoint & { heading: WorldHeading };

export type WorldCreatureAction = 'idle' | 'walk' | 'attack' | 'hurt' | 'fainted';

export type WorldCreature = WorldPoint & {
  id: string;
  speciesId: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  heading?: WorldHeading;
  action?: WorldCreatureAction;
  inBattle?: boolean;
};

export type WorldFood = WorldPoint & { id: string; kind?: string };

export type OpenWorldRenderSnapshot = {
  player: WorldPlayer;
  entities: readonly WorldCreature[];
  foods?: readonly WorldFood[];
  selectedWildId?: string | null;
  tick?: number;
};

export type WorldSample = {
  height: number;
  biome: 'meadow' | 'forest' | 'lake' | 'rock';
  blocked: boolean;
};

export type OpenWorldProp = WorldPoint & {
  id: string;
  url: string;
  rotationY?: number;
  scale?: number;
  collider?: 'cuboid' | 'trimesh' | 'none';
};

export type PlayerMove = { x: number; z: number; heading: WorldHeading };

export type OpenWorldViewOptions = {
  getSnapshot: () => OpenWorldRenderSnapshot;
  onPlayerMove: (next: PlayerMove) => boolean | void;
  onSelect: (instanceId: string | null) => void;
  onInteract?: (instanceId: string) => void;
  modelUrl?: (speciesId: number) => string;
  spriteUrl?: (speciesId: number) => string;
  sampleWorld?: (x: number, z: number) => WorldSample;
  terrainUrl?: string;
  terrainTransform?: Partial<Pick<OpenWorldProp, 'x' | 'y' | 'z' | 'rotationY' | 'scale'>>;
  props?: readonly OpenWorldProp[];
};

export type OpenWorldView = {
  update(snapshot?: OpenWorldRenderSnapshot): void;
  destroy(): void;
};
