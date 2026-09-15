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
  /** Display-space model height in world metres, derived from canonical species height. */
  displayHeight?: number;
  /** Engine-provided world units per second, used only for visual interpolation. */
  movementSpeed?: number;
  /** Type of the currently presented move, used to choose a readable battle effect. */
  moveType?: string;
  /** A battle opponent to face without changing the simulation heading. */
  lookAt?: { x: number; z: number };
  inBattle?: boolean;
  /** Ephemeral same-region presence. Never participates in simulation selection or saves. */
  remotePlayer?: { name: string; activity: 'idle' | 'moving' | 'battle' };
};

export type WorldFood = WorldPoint & { id: string; kind?: string };

export type WorldTrainer = WorldPoint & { id: string; name: string; trainerClass: string; locationId: string };
export type WorldPortal = WorldPoint & { id: string; label: string; targetSceneId: string };

export type OpenWorldRenderSnapshot = {
  /** Game-designed progression directions, separate from neural movement decisions. */
  guide?: import('./next-destination').DestinationGuide;
  gyms?: readonly import('./kanto').KantoGym[];
  regionId?: string;
  sceneId?: string;
  timeOfDay?: 'morning' | 'day' | 'night';
  worldHour?: number;
  daylightIntensity?: number;
  badges?: number;
  player: WorldPlayer;
  entities: readonly WorldCreature[];
  foods?: readonly WorldFood[];
  trainers?: readonly WorldTrainer[];
  portals?: readonly WorldPortal[];
  selectedWildId?: string | null;
  tick?: number;
};

export type WorldSample = {
  height: number;
  /** The sampler already interpolates the local rendered triangle grid. */
  exactHeight?: boolean;
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
  /** Selects manual control before a click-to-move route begins. */
  onNavigationStart?: () => boolean | void;
  /** Active keyboard or route input, including attempts blocked by terrain. */
  onMovementInput?: () => boolean | void;
  onSelect: (instanceId: string | null) => void;
  onInteract?: (instanceId: string) => void;
  onTrainer?: (trainerId: string) => void;
  onPortal?: (portalId: string) => void;
  modelUrl?: (speciesId: number) => string;
  spriteUrl?: (speciesId: number) => string;
  sampleWorld?: (x: number, z: number) => WorldSample;
  /** Fired once keyboard listeners are installed and the Canvas has rendered a frame. */
  onReady?: () => void;
  terrainUrl?: string;
  terrainTransform?: Partial<Pick<OpenWorldProp, 'x' | 'y' | 'z' | 'rotationY' | 'scale'>>;
  props?: readonly OpenWorldProp[];
};

export type OpenWorldView = {
  update(snapshot?: OpenWorldRenderSnapshot): void;
  destroy(): void;
};
