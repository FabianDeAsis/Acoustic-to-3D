import { resolvePbrMaterialSpec, ROOM_MATERIALS, ROOM_SIZE_PRESETS } from './materials';
import { computeContactUvFromPose, sampleRoughnessPixel } from './modelImporter';
import type {
  AcousticRay,
  ContactEvent,
  ObjectPhysicsConfig,
  PbrMaterialId,
  PbrMaterialSpec,
  PhysicsBodyState,
  RoomAcousticConfig,
  RoomAcousticMetrics,
  RoomDimensions,
  RoughnessPixelMap,
  Vec3,
} from './types';

export const GRAVITY_MPS2 = 9.81;
export const SPEED_OF_SOUND_MPS = 343.2;

export function getEffectiveRoomDimensions(config: RoomAcousticConfig): RoomDimensions {
  const preset = ROOM_SIZE_PRESETS[config.sizePreset].dimensions;
  const s = Math.max(0.5, Math.min(2.0, config.scaleMultiplier));
  return {
    width: Number((preset.width * s).toFixed(2)),
    height: Number((preset.height * s).toFixed(2)),
    depth: Number((preset.depth * s).toFixed(2)),
  };
}

/**
 * Computes physically grounded room acoustics via Eyring-Sabine reverberation equation.
 */
export function computeRoomAcousticMetrics(config: RoomAcousticConfig): RoomAcousticMetrics {
  const dimensions = getEffectiveRoomDimensions(config);
  const { width, height, depth } = dimensions;
  const volumeM3 = width * height * depth;
  const surfaceAreaM2 = 2 * (width * height + width * depth + height * depth);

  const roomSpec = ROOM_MATERIALS[config.materialId];
  // Blend slider wallAbsorption with material's characteristic floor/ceiling behavior
  const alpha = Math.max(0.03, Math.min(0.96, config.wallAbsorption));
  const floorCeilingAlpha = Math.max(0.04, Math.min(0.92, (roomSpec.defaultAbsorption + alpha) * 0.5));
  const wallArea = 2 * (width + depth) * height;
  const floorCeilingArea = 2 * width * depth;
  const meanAbsorption =
    (wallArea * alpha + floorCeilingArea * floorCeilingAlpha) / Math.max(1e-6, surfaceAreaM2);

  // Eyring formula: RT60 = 0.161 * V / (-S * ln(1 - alpha_bar))
  const clampedAlpha = Math.min(0.96, Math.max(0.02, meanAbsorption));
  const effectiveAbsorptionArea = -surfaceAreaM2 * Math.log(1 - clampedAlpha);
  const rawRt60 = (0.161 * volumeM3) / Math.max(0.25, effectiveAbsorptionArea);
  const rt60Seconds = Math.max(0.09, Math.min(6.5, rawRt60));

  const meanFreePath = (4 * volumeM3) / Math.max(1e-6, surfaceAreaM2);
  const earlyReflectionMs = (meanFreePath / SPEED_OF_SOUND_MPS) * 1000;

  // Critical distance Dc = 0.057 * sqrt(V / RT60)
  const criticalDistanceM = 0.057 * Math.sqrt(volumeM3 / Math.max(0.08, rt60Seconds));

  return {
    dimensions,
    volumeM3,
    surfaceAreaM2,
    rt60Seconds,
    earlyReflectionMs,
    criticalDistanceM,
    meanAbsorption: clampedAlpha,
  };
}

/**
 * Deterministic 2D micro-roughness heightfield matching our procedural floor & PBR maps.
 * Returns normalized height (0..1) and local asperity gradient for continuous friction synthesis.
 */
export function sampleRoughnessMap(
  x: number,
  z: number,
  materialId: PbrMaterialId,
  baseRoughness: number
): { roughness: number; asperity: number } {
  // Material-specific spatial frequency grain (concrete: coarse aggregate, metal: fine brush, wood: directional grain, glass: ultra-smooth)
  const freqMap: Record<string, [number, number]> = {
    concrete: [6.5, 19.2],
    wood: [3.2, 14.5],
    metal: [11.4, 28.0],
    glass: [2.0, 5.5],
  };
  const fallbackF1 = 2.4 + baseRoughness * 9.0;
  const fallbackF2 = 6.5 + baseRoughness * 20.0;
  const [f1, f2] = freqMap[materialId] ?? [fallbackF1, fallbackF2];

  const waveA = Math.sin(x * f1 + Math.cos(z * f1 * 0.7) * 1.4);
  const waveB = Math.cos(z * f2 * 0.85 - x * f2 * 0.35);
  const microGrain = Math.sin((x * 37.1 + z * 29.7) * 1.15) * Math.cos((x * 18.3 - z * 41.2));

  const combined = 0.5 + 0.25 * waveA + 0.15 * waveB + 0.1 * microGrain;
  const clampedBase = Math.max(0.02, Math.min(1.0, baseRoughness));
  const localRoughness = Math.max(0.02, Math.min(1.0, clampedBase * (0.65 + 0.7 * combined)));

  // Derivative magnitude approximates stick-slip impulse density
  const asperity = Math.abs(waveB * 0.5 + microGrain * 0.5) * clampedBase;
  return { roughness: localRoughness, asperity };
}

export function createInitialBodyState(): PhysicsBodyState {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0.35, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    isGrounded: true,
    isDragging: false,
    autoDragPhase: 0,
    impactCount: 0,
    lastImpactVelocity: 0,
    currentFrictionSpeed: 0,
    currentLocalRoughness: 0.24,
  };
}

export function prepareDropState(state: PhysicsBodyState, dropHeightMeters: number): PhysicsBodyState {
  const safeHeight = Math.max(0.6, Math.min(4.5, dropHeightMeters));
  return {
    ...state,
    position: {
      x: state.position.x * 0.4,
      y: safeHeight,
      z: state.position.z * 0.4,
    },
    velocity: {
      x: (Math.sin(state.impactCount * 1.7 + 0.5) * 0.35),
      y: -0.25,
      z: (Math.cos(state.impactCount * 2.1 + 0.2) * 0.35),
    },
    angularVelocity: {
      x: 1.8 * Math.cos(state.impactCount + 0.4),
      y: 0.9,
      z: 1.4 * Math.sin(state.impactCount + 1.1),
    },
    isGrounded: false,
    isDragging: false,
  };
}

export interface PhysicsStepResult {
  state: PhysicsBodyState;
  events: ContactEvent[];
}

/**
 * Pure single-step rigid body + floor contact & continuous friction physics.
 * Object pivot is at bottom-center (y = 0 sits flush on the acoustic chamber floor).
 */
export function stepPhysics(
  prev: PhysicsBodyState,
  config: ObjectPhysicsConfig,
  roomDims: RoomDimensions,
  dt: number,
  options: {
    autoDragActive: boolean;
    dragTarget?: Vec3 | null;
    nowMs: number;
    materialSpec?: PbrMaterialSpec;
    roughnessPixelMap?: RoughnessPixelMap | null;
    contactUvBounds?: { minU: number; maxU: number; minV: number; maxV: number };
  }
): PhysicsStepResult {
  const clampedDt = Math.max(0.001, Math.min(0.05, dt));
  const events: ContactEvent[] = [];
  const matSpec = options.materialSpec ?? resolvePbrMaterialSpec(config.materialId);

  const halfW = Math.max(0.9, roomDims.width * 0.5 - 0.65);
  const halfD = Math.max(0.9, roomDims.depth * 0.5 - 0.65);

  const pos = { ...prev.position };
  const vel = { ...prev.velocity };
  const rot = { ...prev.rotation };
  const angVel = { ...prev.angularVelocity };

  // Helper that samples either the imported 3D model's PBR Roughness texture pixels at the contact UV
  // or falls back to the procedural PBR roughness heightfield.
  const sampleContactRoughness = (
    contactPos: Vec3,
    bodyRot: Vec3
  ): {
    roughness: number;
    asperity: number;
    source: 'procedural' | 'pbr_texture';
    uv?: { u: number; v: number };
  } => {
    if (options.roughnessPixelMap) {
      const uv = computeContactUvFromPose(contactPos, bodyRot, options.contactUvBounds);
      // Scale slightly around slider relative to 0.5 neutral so user can still fine-tune intensity
      const sliderScale = 0.55 + config.roughness * 0.9;
      const px = sampleRoughnessPixel(options.roughnessPixelMap, uv.u, uv.v, sliderScale);
      return {
        roughness: px.roughness,
        asperity: px.asperity,
        source: 'pbr_texture',
        uv,
      };
    }
    const proc = sampleRoughnessMap(contactPos.x, contactPos.z, config.materialId, config.roughness);
    return {
      roughness: proc.roughness,
      asperity: proc.asperity,
      source: 'procedural',
    };
  };

  let isGrounded = prev.isGrounded;
  let isDragging = Boolean(options.dragTarget);
  let autoDragPhase = prev.autoDragPhase;
  let impactCount = prev.impactCount;
  let lastImpactVelocity = prev.lastImpactVelocity;
  let currentFrictionSpeed = 0;

  if (options.dragTarget) {
    // Manual drag on floor plane: spring-coupled target tracking for authentic tangential velocity
    const targetX = Math.max(-halfW, Math.min(halfW, options.dragTarget.x));
    const targetZ = Math.max(-halfD, Math.min(halfD, options.dragTarget.z));
    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;

    const stiffness = 18.0;
    vel.x = dx * stiffness;
    vel.z = dz * stiffness;
    vel.y = 0;

    pos.x += vel.x * clampedDt;
    pos.z += vel.z * clampedDt;
    pos.y = 0;
    isGrounded = true;

    // Subtle tilt in direction of drag based on roughness resistance
    rot.x = Math.max(-0.18, Math.min(0.18, vel.z * 0.04 * (0.4 + config.roughness)));
    rot.z = Math.max(-0.18, Math.min(0.18, -vel.x * 0.04 * (0.4 + config.roughness)));
    angVel.x = 0;
    angVel.y = 0;
    angVel.z = 0;
  } else if (options.autoDragActive) {
    // Calibrated figure-eight acoustic friction sweep across the floor
    isDragging = true;
    isGrounded = true;
    autoDragPhase += clampedDt * 1.45;
    const radiusX = Math.min(1.85, halfW * 0.72);
    const radiusZ = Math.min(1.25, halfD * 0.62);

    const nextX = Math.sin(autoDragPhase) * radiusX;
    const nextZ = Math.sin(autoDragPhase * 2) * 0.5 * radiusZ;

    vel.x = (nextX - pos.x) / clampedDt;
    vel.z = (nextZ - pos.z) / clampedDt;
    vel.y = 0;

    pos.x = nextX;
    pos.y = 0;
    pos.z = nextZ;

    const heading = Math.atan2(vel.x, vel.z);
    rot.y = heading;
    rot.x = 0.05 * Math.sin(autoDragPhase * 8) * config.roughness;
    rot.z = 0.05 * Math.cos(autoDragPhase * 7) * config.roughness;
    angVel.x = 0;
    angVel.y = 0;
    angVel.z = 0;
  } else {
    // Free ballistic + floor bounce + sliding friction physics
    if (!isGrounded || pos.y > 0.001 || vel.y > 0.001) {
      vel.y -= GRAVITY_MPS2 * clampedDt;
    }

    pos.x += vel.x * clampedDt;
    pos.y += vel.y * clampedDt;
    pos.z += vel.z * clampedDt;

    rot.x += angVel.x * clampedDt;
    rot.y += angVel.y * clampedDt;
    rot.z += angVel.z * clampedDt;

    // Floor collision (y = 0)
    if (pos.y <= 0) {
      pos.y = 0;
      const impactSpeed = Math.abs(vel.y);

      if (impactSpeed > 0.35) {
        impactCount += 1;
        lastImpactVelocity = impactSpeed;
        const sampled = sampleContactRoughness(pos, rot);
        events.push({
          type: 'impact',
          velocity: impactSpeed,
          position: { x: pos.x, y: 0, z: pos.z },
          normal: { x: 0, y: 1, z: 0 },
          contactArea:
            config.shapeId === 'resonator_block'
              ? 0.85
              : config.shapeId === 'acoustic_cylinder'
              ? 0.62
              : config.shapeId === 'imported_mesh'
              ? 0.74
              : 0.38,
          localRoughness: sampled.roughness,
          asperityImpulse: sampled.asperity,
          roughnessSource: sampled.source,
          contactUv: sampled.uv,
          timestampMs: options.nowMs,
        });

        // Restitution bounce modulated by elasticity and mass damping
        const restitution = Math.max(0.05, Math.min(0.88, config.elasticity));
        const nextVy = impactSpeed * restitution;
        if (nextVy > 0.42) {
          vel.y = nextVy;
          isGrounded = false;
          // Angular kick on bounce
          angVel.x *= 0.65;
          angVel.z *= 0.65;
          angVel.y *= 0.8;
        } else {
          vel.y = 0;
          isGrounded = true;
        }
      } else {
        vel.y = 0;
        isGrounded = true;
      }
    }

    // Wall collisions (X and Z bounds)
    if (Math.abs(pos.x) > halfW) {
      const sign = Math.sign(pos.x);
      pos.x = sign * halfW;
      const wallSpeed = Math.abs(vel.x);
      if (wallSpeed > 0.45) {
        impactCount += 1;
        lastImpactVelocity = wallSpeed;
        const sampled = sampleContactRoughness(pos, rot);
        events.push({
          type: 'impact',
          velocity: wallSpeed,
          position: { x: pos.x, y: pos.y + 0.25, z: pos.z },
          normal: { x: -sign, y: 0, z: 0 },
          contactArea: 0.55,
          localRoughness: sampled.roughness,
          asperityImpulse: sampled.asperity,
          roughnessSource: sampled.source,
          contactUv: sampled.uv,
          timestampMs: options.nowMs,
        });
      }
      vel.x = -vel.x * Math.max(0.15, config.elasticity * 0.75);
    }

    if (Math.abs(pos.z) > halfD) {
      const sign = Math.sign(pos.z);
      pos.z = sign * halfD;
      const wallSpeed = Math.abs(vel.z);
      if (wallSpeed > 0.45) {
        impactCount += 1;
        lastImpactVelocity = wallSpeed;
        const sampled = sampleContactRoughness(pos, rot);
        events.push({
          type: 'impact',
          velocity: wallSpeed,
          position: { x: pos.x, y: pos.y + 0.25, z: pos.z },
          normal: { x: 0, y: 0, z: -sign },
          contactArea: 0.55,
          localRoughness: sampled.roughness,
          asperityImpulse: sampled.asperity,
          roughnessSource: sampled.source,
          contactUv: sampled.uv,
          timestampMs: options.nowMs,
        });
      }
      vel.z = -vel.z * Math.max(0.15, config.elasticity * 0.75);
    }

    // Grounded damping & upright settling
    if (isGrounded) {
      const mu = matSpec.frictionCoeff * (0.45 + config.roughness * 0.9);
      const decay = Math.exp(-mu * 5.2 * clampedDt);
      vel.x *= decay;
      vel.z *= decay;
      if (Math.hypot(vel.x, vel.z) < 0.015) {
        vel.x = 0;
        vel.z = 0;
      }

      // Smoothly settle tilt back upright on flat base
      const settle = Math.exp(-10 * clampedDt);
      rot.x *= settle;
      rot.z *= settle;
      angVel.x *= settle;
      angVel.y *= Math.exp(-4 * clampedDt);
      angVel.z *= settle;
    }
  }

  // Sample PBR roughness (either imported texture pixels at contact UV or procedural heightfield)
  const sampled = sampleContactRoughness(pos, rot);
  const tangentialSpeed = Math.hypot(vel.x, vel.z);

  if (isGrounded && tangentialSpeed > 0.04) {
    currentFrictionSpeed = tangentialSpeed;
    events.push({
      type: 'friction',
      velocity: tangentialSpeed,
      position: { x: pos.x, y: 0, z: pos.z },
      normal: { x: 0, y: 1, z: 0 },
      contactArea: config.shapeId === 'resonator_block' ? 0.9 : config.shapeId === 'imported_mesh' ? 0.78 : 0.65,
      localRoughness: sampled.roughness,
      asperityImpulse: sampled.asperity,
      roughnessSource: sampled.source,
      contactUv: sampled.uv,
      timestampMs: options.nowMs,
    });
  }

  return {
    state: {
      position: pos,
      velocity: vel,
      rotation: rot,
      angularVelocity: angVel,
      isGrounded,
      isDragging,
      autoDragPhase,
      impactCount,
      lastImpactVelocity,
      currentFrictionSpeed,
      currentLocalRoughness: sampled.roughness,
      currentContactUv: sampled.uv,
      currentRoughnessSource: sampled.source,
    },
    events,
  };
}

/**
 * Computes direct path + first-order image-source acoustic reflection rays
 * between the sound source (contact point) and the studio measurement microphone.
 */
export function traceAcousticRays(
  source: Vec3,
  listener: Vec3,
  roomDims: RoomDimensions,
  wallAbsorption: number
): AcousticRay[] {
  const halfW = roomDims.width * 0.5;
  const halfD = roomDims.depth * 0.5;
  const height = roomDims.height;
  const reflectivity = Math.max(0.05, Math.sqrt(Math.max(0.02, 1 - wallAbsorption)));

  const dist = (a: Vec3, b: Vec3) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const rays: AcousticRay[] = [];

  // Direct path
  const directDist = dist(source, listener);
  rays.push({
    id: 'direct',
    order: 0,
    points: [source, listener],
    attenuation: Math.min(1, 1 / Math.max(0.8, directDist * 0.55)),
    delayMs: (directDist / SPEED_OF_SOUND_MPS) * 1000,
    surface: 'Directo',
  });

  // 5 first-order mirror images (Left, Right, Back, Front, Ceiling)
  const mirrors: Array<{ id: string; surface: string; image: Vec3; axis: 'x' | 'y' | 'z'; plane: number }> = [
    { id: 'left', surface: 'Pared Izquierda', image: { x: -2 * halfW - source.x, y: source.y, z: source.z }, axis: 'x', plane: -halfW },
    { id: 'right', surface: 'Pared Derecha', image: { x: 2 * halfW - source.x, y: source.y, z: source.z }, axis: 'x', plane: halfW },
    { id: 'back', surface: 'Pared Fondo', image: { x: source.x, y: source.y, z: -2 * halfD - source.z }, axis: 'z', plane: -halfD },
    { id: 'front', surface: 'Pared Frontal', image: { x: source.x, y: source.y, z: 2 * halfD - source.z }, axis: 'z', plane: halfD },
    { id: 'ceiling', surface: 'Techo', image: { x: source.x, y: 2 * height - source.y, z: source.z }, axis: 'y', plane: height },
  ];

  for (const m of mirrors) {
    const dx = listener.x - m.image.x;
    const dy = listener.y - m.image.y;
    const dz = listener.z - m.image.z;

    let t = 0.5;
    if (m.axis === 'x' && Math.abs(dx) > 1e-5) t = (m.plane - m.image.x) / dx;
    if (m.axis === 'y' && Math.abs(dy) > 1e-5) t = (m.plane - m.image.y) / dy;
    if (m.axis === 'z' && Math.abs(dz) > 1e-5) t = (m.plane - m.image.z) / dz;

    t = Math.max(0.05, Math.min(0.95, t));

    const hit: Vec3 = {
      x: Math.max(-halfW, Math.min(halfW, m.image.x + dx * t)),
      y: Math.max(0.05, Math.min(height, m.image.y + dy * t)),
      z: Math.max(-halfD, Math.min(halfD, m.image.z + dz * t)),
    };

    const totalDist = dist(source, hit) + dist(hit, listener);
    const attenuation = Math.min(1, (reflectivity * 1.15) / Math.max(1.0, totalDist * 0.45));

    rays.push({
      id: m.id,
      order: 1,
      points: [source, hit, listener],
      attenuation,
      delayMs: (totalDist / SPEED_OF_SOUND_MPS) * 1000,
      surface: m.surface,
    });
  }

  return rays;
}
