import type {
  BasketballCadenceId,
  FoleySceneAudioTrigger,
  FoleySceneConfig,
  FootstepTerrainId,
  RoomMaterialId,
  Vec3,
} from './types';

export const BALL_RADIUS_M = 0.22;
const GRAVITY = 9.81;

export interface BasketballSimState {
  ballPos: Vec3;
  ballVel: Vec3;
  ballRotX: number;
  ballRotZ: number;
  squashY: number; // < 1.0 on impact compression, > 1.0 on stretch
  handPos: Vec3;
  handPitch: number;
  handSide: -1 | 1; // switches in fast_crossover
  cycleTime: number;
  freeThrowPhase: 'launch' | 'bouncing';
  freeThrowBounces: number;
  bounceCount: number;
  lastImpactVelocity: number;
}

export interface FootPose {
  x: number;
  y: number;
  z: number;
  pitch: number; // negative = heel down (dorsiflexion), positive = toe-off push
}

export interface FootstepsSimState {
  gaitPhase: number; // 0 .. 1 full L+R cycle
  leftFoot: FootPose;
  rightFoot: FootPose;
  stepCount: number;
  lastTerrain: FootstepTerrainId;
}

export interface DrumstickPose {
  pivotX: number;
  pivotY: number;
  pivotZ: number;
  yaw: number;
  pitch: number; // 0 = horizontal strike, negative = raised back
  target: 'snare' | 'cymbal' | 'woodblock';
}

export interface PercussionSimState {
  beatClockSec: number;
  stepIndex: number; // 0..7 eighth-note groove
  stickL: DrumstickPose;
  stickR: DrumstickPose;
  snareHitEnergy: number;
  cymbalHitEnergy: number;
  cymbalWobblePhase: number;
  woodblockHitEnergy: number;
  hitCount: number;
  lastInstrument: 'snare' | 'cymbal' | 'woodblock';
}

export interface FoleySceneSimState {
  basketball: BasketballSimState;
  footsteps: FootstepsSimState;
  percussion: PercussionSimState;
  activeSourcePos: Vec3;
  lastEventLabel: string;
}

export const PERCUSSION_POSITIONS = {
  snare: { x: -0.64, y: 0.78, z: 0.22 } as Vec3,
  cymbal: { x: 0.68, y: 1.16, z: -0.14 } as Vec3,
  woodblock: { x: 0.02, y: 0.86, z: -0.44 } as Vec3,
};

// Musical 8-step 8th-note groove across snare, cymbal, and woodblock
interface GrooveStep {
  hand: 'L' | 'R';
  target: 'snare' | 'cymbal' | 'woodblock';
  intensity: number;
}

const PERCUSSION_GROOVE: GrooveStep[] = [
  { hand: 'R', target: 'cymbal', intensity: 0.92 },
  { hand: 'L', target: 'woodblock', intensity: 0.72 },
  { hand: 'L', target: 'snare', intensity: 1.0 },
  { hand: 'R', target: 'cymbal', intensity: 0.68 },
  { hand: 'R', target: 'woodblock', intensity: 0.86 },
  { hand: 'L', target: 'snare', intensity: 0.62 },
  { hand: 'R', target: 'cymbal', intensity: 0.95 },
  { hand: 'L', target: 'snare', intensity: 0.9 },
];

export const DEFAULT_FOLEY_SCENE_CONFIG: FoleySceneConfig = {
  enabled: false,
  sceneId: 'basketball',
  playing: true,
  basketballCadence: 'slow_dribble',
  basketballFloor: 'wood',
  footstepTerrain: 'gravel_branches',
  footstepSpeed: 0.38,
  percussionBpm: 112,
};

export function createInitialFoleySceneState(): FoleySceneSimState {
  return {
    basketball: {
      ballPos: { x: 0, y: 1.18, z: 0 },
      ballVel: { x: 0, y: -1.8, z: 0 },
      ballRotX: 0,
      ballRotZ: 0,
      squashY: 1.0,
      handPos: { x: 0, y: 1.48, z: 0 },
      handPitch: 0.15,
      handSide: 1,
      cycleTime: 0,
      freeThrowPhase: 'bouncing',
      freeThrowBounces: 0,
      bounceCount: 0,
      lastImpactVelocity: 0,
    },
    footsteps: {
      gaitPhase: 0,
      leftFoot: { x: -0.22, y: 0.04, z: 0, pitch: 0 },
      rightFoot: { x: 0.22, y: 0.04, z: 0, pitch: 0 },
      stepCount: 0,
      lastTerrain: 'gravel_branches',
    },
    percussion: {
      beatClockSec: 0,
      stepIndex: 0,
      stickL: {
        pivotX: -0.45,
        pivotY: 1.06,
        pivotZ: 0.78,
        yaw: 0.28,
        pitch: -0.35,
        target: 'snare',
      },
      stickR: {
        pivotX: 0.45,
        pivotY: 1.12,
        pivotZ: 0.78,
        yaw: -0.28,
        pitch: -0.35,
        target: 'cymbal',
      },
      snareHitEnergy: 0,
      cymbalHitEnergy: 0,
      cymbalWobblePhase: 0,
      woodblockHitEnergy: 0,
      hitCount: 0,
      lastInstrument: 'cymbal',
    },
    activeSourcePos: { x: 0, y: 0.35, z: 0 },
    lastEventLabel: 'Listo',
  };
}

export function getFootstepCadenceHz(footstepSpeed: number): number {
  const s = Math.max(0, Math.min(1, footstepSpeed));
  // 1.35 steps/s (leisurely walk) -> 3.85 steps/s (fast run)
  return Number((1.35 + s * 2.5).toFixed(2));
}

function getCadenceParams(cadence: BasketballCadenceId): {
  apexY: number;
  downPushVel: number;
  restitution: number;
  crossoverSpanX: number;
} {
  if (cadence === 'fast_crossover') {
    return {
      apexY: 0.76,
      downPushVel: -6.8,
      restitution: 0.86,
      crossoverSpanX: 0.64,
    };
  }
  if (cadence === 'free_throw') {
    return {
      apexY: 2.25,
      downPushVel: -2.2,
      restitution: 0.78,
      crossoverSpanX: 0,
    };
  }
  // slow_dribble
  return {
    apexY: 1.24,
    downPushVel: -4.4,
    restitution: 0.85,
    crossoverSpanX: 0.08,
  };
}

function stepBasketball(
  prev: BasketballSimState,
  config: FoleySceneConfig,
  dt: number
): { next: BasketballSimState; triggers: FoleySceneAudioTrigger[] } {
  const s: BasketballSimState = {
    ...prev,
    ballPos: { ...prev.ballPos },
    ballVel: { ...prev.ballVel },
    handPos: { ...prev.handPos },
  };
  const triggers: FoleySceneAudioTrigger[] = [];
  const params = getCadenceParams(config.basketballCadence);
  const floorMat: RoomMaterialId = config.basketballFloor === 'wood' ? 'wood' : 'concrete';

  s.cycleTime += dt;

  // Exponential recovery of squash-and-stretch back to spherical (1.0)
  s.squashY += (1.0 - s.squashY) * Math.min(1, dt * 16);

  // Gravity integration
  s.ballVel.y -= GRAVITY * dt;
  s.ballPos.x += s.ballVel.x * dt;
  s.ballPos.y += s.ballVel.y * dt;
  s.ballPos.z += s.ballVel.z * dt;

  // Natural basketball spin from lateral & vertical motion
  s.ballRotZ -= s.ballVel.x * dt * 2.6;
  s.ballRotX += (config.basketballCadence === 'free_throw' ? -3.4 : 1.4) * dt;

  // Floor collision (y <= BALL_RADIUS_M) -> Cavity 850Hz bounce + Squash deformation
  if (s.ballPos.y <= BALL_RADIUS_M) {
    s.ballPos.y = BALL_RADIUS_M;
    const impactSpeed = Math.abs(s.ballVel.y);

    if (impactSpeed > 0.65) {
      // Visual squash proportional to vertical impact velocity (0.64 .. 0.88)
      const squashAmount = Math.min(0.34, impactSpeed * 0.045);
      s.squashY = Math.max(0.64, 1.0 - squashAmount);
      s.bounceCount += 1;
      s.lastImpactVelocity = Number(impactSpeed.toFixed(2));

      const floorRest = config.basketballFloor === 'concrete' ? params.restitution * 1.02 : params.restitution;
      s.ballVel.y = Math.max(1.4, impactSpeed * floorRest);

      if (config.basketballCadence === 'fast_crossover') {
        s.handSide = s.handSide === 1 ? -1 : 1;
        // Rebound sharply across toward opposite hand
        const targetX = s.handSide * params.crossoverSpanX;
        s.ballVel.x = (targetX - s.ballPos.x) * 4.4;
      } else if (config.basketballCadence === 'free_throw') {
        s.freeThrowBounces += 1;
        s.ballVel.x *= 0.82;
        s.ballVel.z *= 0.78;
      } else {
        s.ballVel.x *= 0.5;
      }

      triggers.push({
        kind: 'basketball_bounce',
        position: { x: s.ballPos.x, y: 0.04, z: s.ballPos.z },
        velocity: impactSpeed,
        surfaceMaterial: floorMat,
        intensity: Math.min(1.4, Math.max(0.28, impactSpeed / 5.4)),
        label: `Bote ${impactSpeed.toFixed(1)} m/s (${config.basketballFloor === 'wood' ? 'Parqué' : 'Concreto'})`,
      });
    } else {
      // Re-launch free throw after natural bounces settle
      s.ballVel.y = 6.4;
      s.ballVel.z = 0;
      s.ballPos.x = 0;
      s.ballPos.z = 0;
      s.freeThrowBounces = 0;
    }
  }

  // Upper hand actuator control per cadence
  if (config.basketballCadence === 'free_throw') {
    // After 3 natural decaying bounces, launch a fresh parabolic free-throw arc
    if (s.freeThrowBounces >= 3 && s.ballVel.y < 0.2 && s.ballPos.y < 0.65) {
      s.freeThrowBounces = 0;
      s.ballPos.y = 1.25;
      s.ballPos.x = 0;
      s.ballPos.z = 0.55;
      s.ballVel.y = 5.4;
      s.ballVel.z = -0.82;
      s.ballVel.x = 0;
      s.squashY = 1.12;
      triggers.push({
        kind: 'basketball_hand_catch',
        position: { x: s.ballPos.x, y: s.ballPos.y, z: s.ballPos.z },
        velocity: 2.2,
        surfaceMaterial: floorMat,
        intensity: 0.48,
        label: 'Lanzamiento Libre',
      });
    }
    // Hand follows shooter release zone smoothly
    const targetHandX = 0;
    const targetHandY = Math.max(1.38, Math.min(2.0, s.ballPos.y + 0.26));
    const targetHandZ = Math.max(-0.2, Math.min(0.62, s.ballPos.z + 0.14));
    s.handPos.x += (targetHandX - s.handPos.x) * Math.min(1, dt * 8);
    s.handPos.y += (targetHandY - s.handPos.y) * Math.min(1, dt * 8);
    s.handPos.z += (targetHandZ - s.handPos.z) * Math.min(1, dt * 8);
    s.handPitch = -0.25 + Math.sin(s.cycleTime * 2.2) * 0.15;
  } else {
    // Dribble / Crossover: upper palm catches ball near apex and drives it cleanly downward
    const hitApex = s.ballPos.y >= params.apexY && s.ballVel.y > -0.4;
    const stalledMidAir = s.ballPos.y >= params.apexY * 0.85 && s.ballVel.y <= 0 && s.ballVel.y > -1.2;
    if (hitApex || stalledMidAir) {
      s.ballPos.y = Math.min(s.ballPos.y, params.apexY + 0.04);
      s.ballVel.y = params.downPushVel;
      s.squashY = 1.14; // Brief vertical stretch on whip downward drive
      if (config.basketballCadence === 'fast_crossover') {
        const targetX = -s.handSide * params.crossoverSpanX;
        s.ballVel.x = (targetX - s.ballPos.x) * 3.6;
      } else {
        s.ballVel.x = -s.ballPos.x * 2.5;
      }
      s.ballVel.z = -s.ballPos.z * 3.0;
      triggers.push({
        kind: 'basketball_hand_catch',
        position: { x: s.ballPos.x, y: s.ballPos.y + BALL_RADIUS_M, z: s.ballPos.z },
        velocity: Math.abs(params.downPushVel) * 0.38,
        surfaceMaterial: floorMat,
        intensity: 0.36,
        label: config.basketballCadence === 'fast_crossover' ? 'Crossover' : 'Palma Dribble',
      });
    }

    const followX = s.ballPos.x;
    const followY = Math.max(
      params.apexY * 0.72 + BALL_RADIUS_M,
      Math.min(params.apexY + BALL_RADIUS_M + 0.18, s.ballPos.y + BALL_RADIUS_M + 0.11)
    );
    s.handPos.x += (followX - s.handPos.x) * Math.min(1, dt * 18);
    s.handPos.y += (followY - s.handPos.y) * Math.min(1, dt * 18);
    s.handPos.z += (s.ballPos.z - s.handPos.z) * Math.min(1, dt * 12);
    // Wrist flexes downward when pushing, lifts up when receiving rebound
    const targetPitch = s.ballVel.y < 0 ? 0.36 : -0.18;
    s.handPitch += (targetPitch - s.handPitch) * Math.min(1, dt * 15);
  }

  // Keep ball safely within center court zone
  s.ballPos.x = Math.max(-1.1, Math.min(1.1, s.ballPos.x));
  s.ballPos.z = Math.max(-1.1, Math.min(1.1, s.ballPos.z));

  return { next: s, triggers };
}

function terrainToSurfaceMaterial(terrain: FootstepTerrainId): RoomMaterialId {
  if (terrain === 'wood') return 'wood';
  if (terrain === 'glass') return 'glass';
  return 'concrete';
}

function computeFootPose(phase: number, sideX: number, speedNorm: number): FootPose {
  // phase in [0, 1): 0.0..0.52 stance (heel strike -> flat -> toe-off), 0.52..1.0 swing arc
  const p = ((phase % 1) + 1) % 1;
  const strideHalfZ = 0.24 + speedNorm * 0.24;
  const liftHeight = 0.16 + speedNorm * 0.2;

  if (p < 0.52) {
    // Stance phase: foot rolls heel-to-toe while gliding backward relative to body
    const u = p / 0.52;
    const z = strideHalfZ * (1 - 2 * u);
    let pitch = 0;
    let y = 0.045;
    if (u < 0.24) {
      // Heel strike rolling down to flat foot
      const h = 1 - u / 0.24;
      pitch = -0.34 * h;
      y = 0.045 + h * 0.025;
    } else if (u > 0.72) {
      // Toe-off plantar flexion push
      const t = (u - 0.72) / 0.28;
      pitch = 0.42 * t;
      y = 0.045 + t * 0.04;
    }
    return { x: sideX, y, z, pitch };
  }

  // Swing phase: parabolic clearance arc forward
  const u = (p - 0.52) / 0.48;
  const z = -strideHalfZ + 2 * strideHalfZ * u;
  const arc = Math.sin(u * Math.PI);
  const y = 0.045 + arc * liftHeight;
  const pitch = 0.42 * (1 - u) - 0.34 * u;
  return { x: sideX, y, z, pitch };
}

function crossedPhase(prev: number, next: number, threshold: number): boolean {
  if (prev <= next) {
    return prev < threshold && next >= threshold;
  }
  // Wrapped around 1.0 -> 0.0
  return prev < threshold || next >= threshold;
}

function stepFootsteps(
  prev: FootstepsSimState,
  config: FoleySceneConfig,
  dt: number
): { next: FootstepsSimState; triggers: FoleySceneAudioTrigger[] } {
  const speedNorm = Math.max(0, Math.min(1, config.footstepSpeed));
  const stepsPerSec = getFootstepCadenceHz(speedNorm);
  // 1 full cycle = 2 steps (Left + Right)
  const cyclesPerSec = stepsPerSec * 0.5;
  const prevPhase = prev.gaitPhase;
  const nextPhase = (prevPhase + dt * cyclesPerSec) % 1;

  const leftFoot = computeFootPose(nextPhase, -0.22, speedNorm);
  const rightFoot = computeFootPose((nextPhase + 0.5) % 1, 0.22, speedNorm);
  const triggers: FoleySceneAudioTrigger[] = [];
  let stepCount = prev.stepCount;

  const terrainNames: Record<FootstepTerrainId, string> = {
    wood: 'Madera',
    gravel_branches: 'Grava/Ramas',
    metal: 'Metal',
    glass: 'Vidrio',
  };
  const terrainLabel = terrainNames[config.footstepTerrain];
  const surfaceMaterial = terrainToSurfaceMaterial(config.footstepTerrain);
  const baseVel = 2.0 + speedNorm * 4.4;

  // Left heel strike at phase 0.02, Left toe roll/push at 0.17
  if (crossedPhase(prevPhase, nextPhase, 0.02)) {
    stepCount += 1;
    triggers.push({
      kind: 'footstep_heel',
      position: { x: leftFoot.x, y: 0.05, z: leftFoot.z },
      velocity: baseVel,
      surfaceMaterial,
      terrain: config.footstepTerrain,
      intensity: 0.65 + speedNorm * 0.55,
      label: `Talón Izq · ${terrainLabel}`,
    });
  }
  if (crossedPhase(prevPhase, nextPhase, 0.16)) {
    triggers.push({
      kind: 'footstep_toe',
      position: { x: leftFoot.x, y: 0.05, z: leftFoot.z - 0.08 },
      velocity: baseVel * 0.72,
      surfaceMaterial,
      terrain: config.footstepTerrain,
      intensity: 0.48 + speedNorm * 0.45,
      label: `Punta Izq · ${terrainLabel}`,
    });
  }

  // Right heel strike at phase 0.52, Right toe roll/push at 0.66
  if (crossedPhase(prevPhase, nextPhase, 0.52)) {
    stepCount += 1;
    triggers.push({
      kind: 'footstep_heel',
      position: { x: rightFoot.x, y: 0.05, z: rightFoot.z },
      velocity: baseVel,
      surfaceMaterial,
      terrain: config.footstepTerrain,
      intensity: 0.65 + speedNorm * 0.55,
      label: `Talón Der · ${terrainLabel}`,
    });
  }
  if (crossedPhase(prevPhase, nextPhase, 0.66)) {
    triggers.push({
      kind: 'footstep_toe',
      position: { x: rightFoot.x, y: 0.05, z: rightFoot.z - 0.08 },
      velocity: baseVel * 0.72,
      surfaceMaterial,
      terrain: config.footstepTerrain,
      intensity: 0.48 + speedNorm * 0.45,
      label: `Punta Der · ${terrainLabel}`,
    });
  }

  return {
    next: {
      gaitPhase: nextPhase,
      leftFoot,
      rightFoot,
      stepCount,
      lastTerrain: config.footstepTerrain,
    },
    triggers,
  };
}

function aimStickYaw(pivotX: number, pivotZ: number, target: Vec3): number {
  const dx = target.x - pivotX;
  const dz = target.z - pivotZ;
  // Stick extends along -Z in local frame
  return Math.atan2(-dx, -dz);
}

function stepPercussion(
  prev: PercussionSimState,
  config: FoleySceneConfig,
  dt: number
): { next: PercussionSimState; triggers: FoleySceneAudioTrigger[] } {
  const bpm = Math.max(70, Math.min(165, config.percussionBpm));
  const stepDurSec = 60 / bpm / 2; // eighth-note step duration

  const s: PercussionSimState = {
    ...prev,
    stickL: { ...prev.stickL },
    stickR: { ...prev.stickR },
  };
  const triggers: FoleySceneAudioTrigger[] = [];

  s.beatClockSec += dt;
  s.snareHitEnergy *= Math.exp(-14 * dt);
  s.cymbalHitEnergy *= Math.exp(-3.2 * dt);
  s.woodblockHitEnergy *= Math.exp(-18 * dt);
  s.cymbalWobblePhase += dt * 15;

  // Trigger next rhythmic strike when step clock crosses boundary
  if (s.beatClockSec >= stepDurSec) {
    s.beatClockSec -= stepDurSec;
    const step = PERCUSSION_GROOVE[s.stepIndex % PERCUSSION_GROOVE.length];
    s.stepIndex = (s.stepIndex + 1) % PERCUSSION_GROOVE.length;
    s.hitCount += 1;
    s.lastInstrument = step.target;

    const targetPos = PERCUSSION_POSITIONS[step.target];
    if (step.hand === 'L') {
      s.stickL.target = step.target;
      s.stickL.pitch = 0.08; // Downward strike impact contact
    } else {
      s.stickR.target = step.target;
      s.stickR.pitch = 0.08;
    }

    if (step.target === 'snare') {
      s.snareHitEnergy = 1.0;
      triggers.push({
        kind: 'percussion_snare',
        position: { ...targetPos },
        velocity: 4.2 + step.intensity * 2.8,
        surfaceMaterial: 'wood',
        intensity: step.intensity,
        label: 'Caja / Membrana',
      });
    } else if (step.target === 'cymbal') {
      s.cymbalHitEnergy = 1.0;
      triggers.push({
        kind: 'percussion_cymbal',
        position: { ...targetPos },
        velocity: 3.6 + step.intensity * 2.5,
        surfaceMaterial: 'concrete',
        intensity: step.intensity,
        label: 'Plato Metálico',
      });
    } else {
      s.woodblockHitEnergy = 1.0;
      triggers.push({
        kind: 'percussion_woodblock',
        position: { ...targetPos },
        velocity: 4.0 + step.intensity * 2.4,
        surfaceMaterial: 'wood',
        intensity: step.intensity,
        label: 'Bloque de Madera',
      });
    }
  }

  // Smoothly aim & animate anticipation lift for both L & R sticks
  const progress = Math.min(1, s.beatClockSec / Math.max(0.05, stepDurSec));
  const upcoming = PERCUSSION_GROOVE[s.stepIndex % PERCUSSION_GROOVE.length];

  const updateStick = (stick: DrumstickPose, isUpcoming: boolean) => {
    const targetKey = isUpcoming ? upcoming.target : stick.target;
    const targetPos = PERCUSSION_POSITIONS[targetKey];
    const desiredYaw = aimStickYaw(stick.pivotX, stick.pivotZ, targetPos);
    stick.yaw += (desiredYaw - stick.yaw) * Math.min(1, dt * 16);

    const desiredPivotY = targetKey === 'cymbal' ? 1.24 : 0.96;
    stick.pivotY += (desiredPivotY - stick.pivotY) * Math.min(1, dt * 12);

    // Whip-rebound curve: impact at 0 -> rebound up -> anticipation lift before next strike
    const targetPitch = isUpcoming
      ? progress < 0.72
        ? -0.44 - Math.sin(progress * Math.PI) * 0.14
        : -0.44 + ((progress - 0.72) / 0.28) * 0.52
      : -0.32;
    stick.pitch += (targetPitch - stick.pitch) * Math.min(1, dt * 22);
  };

  updateStick(s.stickL, upcoming.hand === 'L');
  updateStick(s.stickR, upcoming.hand === 'R');

  return { next: s, triggers };
}

/**
 * Pure fixed-substep simulator for all 3 animated Foley scenes.
 * Completely independent of Three.js / Web Audio so every physics rule & trigger is unit-testable.
 */
export function stepFoleyScene(
  prev: FoleySceneSimState,
  config: FoleySceneConfig,
  dt: number
): { next: FoleySceneSimState; triggers: FoleySceneAudioTrigger[] } {
  if (!config.enabled || !config.playing || dt <= 0) {
    return { next: prev, triggers: [] };
  }

  const clampedDt = Math.min(0.05, dt);

  if (config.sceneId === 'basketball') {
    const { next: basketball, triggers } = stepBasketball(prev.basketball, config, clampedDt);
    const activeSourcePos =
      triggers.length > 0
        ? triggers[0].position
        : {
            x: basketball.ballPos.x,
            y: Math.max(0.24, basketball.ballPos.y),
            z: basketball.ballPos.z,
          };
    return {
      next: {
        ...prev,
        basketball,
        activeSourcePos,
        lastEventLabel: triggers[0]?.label ?? prev.lastEventLabel,
      },
      triggers,
    };
  }

  if (config.sceneId === 'footsteps') {
    const { next: footsteps, triggers } = stepFootsteps(prev.footsteps, config, clampedDt);
    const activeSourcePos =
      triggers.length > 0
        ? triggers[0].position
        : {
            x: (footsteps.leftFoot.x + footsteps.rightFoot.x) * 0.5,
            y: 0.12,
            z: (footsteps.leftFoot.z + footsteps.rightFoot.z) * 0.5,
          };
    return {
      next: {
        ...prev,
        footsteps,
        activeSourcePos,
        lastEventLabel: triggers[0]?.label ?? prev.lastEventLabel,
      },
      triggers,
    };
  }

  const { next: percussion, triggers } = stepPercussion(prev.percussion, config, clampedDt);
  const lastPos = PERCUSSION_POSITIONS[percussion.lastInstrument];
  return {
    next: {
      ...prev,
      percussion,
      activeSourcePos: triggers[0]?.position ?? lastPos,
      lastEventLabel: triggers[0]?.label ?? prev.lastEventLabel,
    },
    triggers,
  };
}
