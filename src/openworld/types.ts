export type WorldPoint = { x: number; z: number; y?: number };

export type WorldHeading = 0 | 1 | 2 | 3 | 4;

export type WorldPlayer = WorldPoint & { heading: WorldHeading };

export type WorldCreatureAction = 'idle' | 'walk' | 'attack' | 'hurt' | 'fainted';
export type WorldModelStatus = 'loading' | 'ready' | 'failed' | 'untracked';

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
  /** Canonical form identifier when the base-species model is not the visible form. */
  formIdentifier?: string;
  /** Verified pinned GLB for the exact regional or battle form. */
  formModelUrl?: string;
  /** Form-specific sprite used instead of a misleading base-species GLB. */
  formSpriteUrl?: string;
  /** Temporary battle presentation applied to this creature. */
  transformationKind?: 'mega';
  /** A battle opponent to face without changing the simulation heading. */
  lookAt?: { x: number; z: number };
  inBattle?: boolean;
  /** Move just used, shown above the nameplate with the damage it dealt; the key restarts its animation. */
  cue?: { key: string; text: string; moveType: string; damage?: number };
  /** A held or used item's effect this turn, shown beside the nameplate. */
  note?: { key: string; text: string; detail?: string };
  /** Engine ailment id (poison, burn, sleep…). */
  status?: string;
  /** Ephemeral same-region presence. Never participates in simulation selection or saves. */
  remotePlayer?: { name: string; activity: 'idle' | 'moving' | 'battle' };
};

export type WorldFood = WorldPoint & { id: string; kind?: string };

/** One executed battle move drawn between two battlers; `start` is a performance.now() time. */
export type WorldMoveEffect = {
  key: string;
  moveType: string;
  style: 'physical' | 'special' | 'status';
  /** The move connected (damage, ailment or buff), so the target reacts. */
  hit: boolean;
  from: WorldPoint & { height: number };
  to: WorldPoint & { height: number };
  start: number;
};

export type WorldFieldItemPickup = WorldPoint & {
  id: string;
  itemId: string;
  name: string;
  kind: 'held-tool' | 'mega-stone' | 'technical-machine';
  regionId: string;
  locationId: string;
};

export type WorldTrainer = WorldPoint & { id: string; name: string; trainerClass: string; locationId: string; facing?: number; model?: string; defeated?: boolean };
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
  /** A battle or capture decision is open; scene buttons wait. */
  busy?: boolean;
  /** The leader's party in the gym hall the player is standing in. */
  gymParty?: ReadonlyArray<readonly [number, number]>;
  /** The league trainer waiting in the league hall the player is standing in. */
  hallTrainer?: { name: string; team: ReadonlyArray<readonly [number, number]> };
  player: WorldPlayer;
  entities: readonly WorldCreature[];
  foods?: readonly WorldFood[];
  fieldItems?: readonly WorldFieldItemPickup[];
  trainers?: readonly WorldTrainer[];
  portals?: readonly WorldPortal[];
  selectedWildId?: string | null;
  tick?: number;
  effects?: readonly WorldMoveEffect[];
  /** Today's mass outbreak in this region, which townsfolk pass on. */
  outbreak?: { locationId: string; speciesId: number };
};

export type WorldSample = {
  height: number;
  /** The sampler already interpolates the local rendered triangle grid. */
  exactHeight?: boolean;
  biome: 'meadow' | 'forest' | 'lake' | 'rock';
  /** Visual landform layered over the encounter biome without changing spawn tables. */
  surface?: 'mountain' | 'snow' | 'desert' | 'marsh';
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
  /** Selects manual control before a click-to-move route begins; false (a gate the badges have not opened) cancels it. */
  onNavigationStart?: (destination?: WorldPoint) => boolean | void;
  /** Active keyboard or route input, including attempts blocked by terrain. */
  onMovementInput?: () => boolean | void;
  /** Called once when held movement or a click route stops. */
  onMovementEnd?: () => void;
  /** Camera forward heading: north = PI, east = PI/2, south = 0. */
  onCameraHeading?: (radians: number) => void;
  onSelect: (instanceId: string | null) => void;
  onInteract?: (instanceId: string) => void;
  onCollectItem?: (pickupId: string) => void;
  onTrainer?: (trainerId: string) => void;
  onPortal?: (portalId: string) => void;
  /** Clicked a gym building; the panel walks to its door or enters. */
  onGymEnter?: (locationId: string) => void;
  /** Clicked the league stadium; the panel walks to its entrance or enters. */
  onLeagueEnter?: (locationId: string) => void;
  onGymExit?: () => void;
  onGymChallenge?: () => void;
  /** A road trainer the partner walked up to challenges it. */
  onTrainerChallenge?: (id: string) => void;
  /** Lets the simulation quarantine a visible creature until its real model is usable. */
  onModelStatus?: (creatureId: string, status: WorldModelStatus, speciesId: number) => void;
  modelUrl?: (speciesId: number) => string;
  spriteUrl?: (speciesId: number) => string;
  sampleWorld?: (x: number, z: number) => WorldSample;
  /** Story rules for one step of a click-to-move route (closed gates, gated places), passed to findWorldPath. */
  navigationStep?: (from: WorldPoint, to: WorldPoint) => boolean;
  /** Fired once keyboard listeners are installed and the Canvas has rendered a frame. */
  onReady?: () => void;
  onLoadProgress?: (percent: number, detail: string) => void;
  onLoadError?: (error: unknown) => void;
  /** GPU/context loss invalidates all model readiness until a new renderer draws them. */
  onRendererLost?: () => void;
  terrainUrl?: string;
  terrainTransform?: Partial<Pick<OpenWorldProp, 'x' | 'y' | 'z' | 'rotationY' | 'scale'>>;
  props?: readonly OpenWorldProp[];
};

export type OpenWorldView = {
  retryModels(): void;
  update(snapshot?: OpenWorldRenderSnapshot): void;
  navigateTo(point: WorldPoint): boolean;
  setCameraHeading(radians: number): void;
  destroy(): void;
};
