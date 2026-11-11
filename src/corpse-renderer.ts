import * as THREE from 'three';
import { CONFIG, NO_WEAPON, WEAPON_ID } from './config.ts';
import type { BattleSimulation, RetiredCorpse } from './simulation.ts';
import type { Terrain } from './terrain.ts';

const CAPACITY = CONFIG.retainedCorpses;
const UP = new THREE.Vector3(0, 1, 0);
const FLAT_SHADOW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

function changed(attribute: THREE.BufferAttribute, index: number) {
  attribute.addUpdateRange(index * attribute.itemSize, attribute.itemSize);
  attribute.needsUpdate = true;
}

function instances(source: THREE.InstancedMesh, name: string, options: { colors?: boolean; material?: THREE.Material; geometry?: THREE.BufferGeometry } = {}) {
  const mesh = new THREE.InstancedMesh(options.geometry ?? source.geometry, options.material ?? source.material, CAPACITY);
  mesh.name = name;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = source.renderOrder;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage).onUpload(() => mesh.instanceMatrix.clearUpdateRanges());
  if (options.colors) {
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
    colors.onUpload(() => colors.clearUpdateRanges());
    mesh.instanceColor = colors;
  }
  return mesh;
}

/** Body meshes use dense indices even when the archive ring mixes basic bodies and armor. */
class CorpseBodies {
  private readonly indexBySlot = new Int16Array(CAPACITY).fill(-1);
  private readonly slotByIndex = new Uint16Array(CAPACITY);
  readonly mesh: THREE.InstancedMesh;
  private readonly rankAttribute?: THREE.InstancedBufferAttribute;

  constructor(mesh: THREE.InstancedMesh, rankAttribute?: THREE.InstancedBufferAttribute) {
    this.mesh = mesh;
    this.rankAttribute = rankAttribute;
  }

  add(slot: number, color: THREE.Color, rank: number) {
    let index = this.indexBySlot[slot];
    if (index < 0) {
      index = this.mesh.count++;
      this.indexBySlot[slot] = index;
      this.slotByIndex[index] = slot;
    }
    if (this.rankAttribute) {
      this.rankAttribute.setX(index, rank);
      changed(this.rankAttribute, index);
    } else {
      this.mesh.setColorAt(index, color);
      changed(this.mesh.instanceColor!, index);
    }
  }

  remove(slot: number) {
    const index = this.indexBySlot[slot];
    if (index < 0) return;
    this.indexBySlot[slot] = -1;
    const last = --this.mesh.count;
    if (index === last) return;
    const moved = this.slotByIndex[last];
    this.slotByIndex[index] = moved;
    this.indexBySlot[moved] = index;
    for (const attr of [this.mesh.instanceMatrix, this.mesh.instanceColor, this.rankAttribute]) {
      if (!attr) continue;
      attr.copyAt(index, attr, last);
      changed(attr, index);
    }
  }

  setMatrix(slot: number, matrix: THREE.Matrix4) {
    const index = this.indexBySlot[slot];
    this.mesh.setMatrixAt(index, matrix);
    changed(this.mesh.instanceMatrix, index);
  }
}

export interface CorpseArmor {
  readonly mesh: THREE.InstancedMesh;
  readonly indexCountByLevel: readonly number[];
}

interface Landing {
  corpse: RetiredCorpse;
  body: CorpseBodies;
  tilt: THREE.Quaternion;
  startY: number;
  restY: number;
  groundY: number;
  duration: number;
  initialSpeed: number;
  progress: number;
}

export function setGunScale(scale: THREE.Vector3, weapon: number, size: number) {
  if (weapon === NO_WEAPON) scale.setScalar(0);
  else if (weapon === WEAPON_ID.sniper) scale.set(size * 0.8, size * 0.85, size * 1.7);
  else if (weapon === WEAPON_ID.shotgun) scale.set(size * 1.8, size * 1.25, size * 0.7);
  else if (weapon === WEAPON_ID.rocket) scale.set(size * 1.6, size * 1.4, size * 1.25);
  else scale.setScalar(size);
}

/** The archive owns the poses. These meshes upload only newly retired or still falling bodies. */
export class CorpseRenderer {
  private readonly scene: THREE.Scene;
  private readonly bodyColors: readonly THREE.Color[];
  private readonly teamColors: readonly THREE.Color[];
  private readonly bodies: CorpseBodies;
  private armor: CorpseBodies | null = null;
  private maxRank = 0;
  private readonly guns: THREE.InstancedMesh;
  private readonly visors: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;
  private readonly pending = new Map<number, Landing>();
  private readonly dummy = new THREE.Object3D();
  private readonly tilt = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();
  private cursor = 0;

  constructor(scene: THREE.Scene, source: {
    bodies: THREE.InstancedMesh; guns: THREE.InstancedMesh; visors: THREE.InstancedMesh; shadows: THREE.InstancedMesh;
  }, bodyColors: readonly THREE.Color[], teamColors: readonly THREE.Color[]) {
    this.scene = scene;
    this.bodyColors = bodyColors;
    this.teamColors = teamColors;
    // The static capsule uses the same surface material without the live hit-flash shader.
    const material = (source.bodies.material as THREE.MeshStandardMaterial).clone();
    this.bodies = new CorpseBodies(instances(source.bodies, 'Retained corpses', { colors: true, material }));
    this.guns = instances(source.guns, 'Retained corpse weapons');
    this.visors = instances(source.visors, 'Retained corpse visors', { colors: true });
    this.shadows = instances(source.shadows, 'Retained corpse shadows');
    scene.add(this.bodies.mesh, this.guns, this.visors, this.shadows);
  }

  update(sim: BattleSimulation, time: number, armor?: CorpseArmor, ranks?: ReadonlyMap<number, number>) {
    if (!sim.tuning.keepCorpses) {
      this.setVisible(false);
      return 0;
    }
    const end = sim.retiredCorpseCount;
    for (let n = Math.max(this.cursor, end - CAPACITY); n < end; n++) {
      const slot = n % CAPACITY, corpse = sim.retiredCorpses[slot];
      const rank = ranks?.get(corpse.id) ?? 0;
      let body = this.bodies;
      if (rank && armor) {
        this.bodies.remove(slot);
        body = this.rankBodies(armor);
        if (rank > this.maxRank) {
          this.maxRank = rank;
          body.mesh.geometry.setDrawRange(0, armor.indexCountByLevel[rank]);
        }
      } else this.armor?.remove(slot);
      body.add(slot, this.bodyColors[corpse.team], rank);
      this.visors.setColorAt(slot, this.teamColors[corpse.team]);
      changed(this.visors.instanceColor!, slot);
      this.pending.set(slot, this.landing(sim.terrain, corpse, body));
    }
    this.cursor = end;
    this.guns.count = this.visors.count = this.shadows.count = sim.retiredCorpses.length;
    for (const [slot, landing] of this.pending) {
      const progress = landing.duration ? THREE.MathUtils.clamp((time - landing.corpse.at) / landing.duration, 0, 1) : 1;
      if (progress === landing.progress) continue;
      landing.progress = progress;
      this.setPose(slot, landing, progress);
      if (progress === 1) this.pending.delete(slot);
    }
    this.setVisible(true);
    return sim.retiredCorpses.length;
  }

  private rankBodies(source: CorpseArmor) {
    if (!this.armor) {
      const geometry = source.mesh.geometry.clone();
      geometry.setAttribute('aHitAt', new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY).fill(-10000), 1));
      const rank = new THREE.InstancedBufferAttribute(new Uint8Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
      rank.onUpload(() => rank.clearUpdateRanges());
      geometry.setAttribute('aRank', rank);
      const mesh = instances(source.mesh, 'Retained corpse armor', { geometry });
      this.scene.add(mesh);
      this.armor = new CorpseBodies(mesh, rank);
    }
    return this.armor;
  }

  private landing(terrain: Terrain, corpse: RetiredCorpse, body: CorpseBodies): Landing {
    const { x, y, z, radius, yaw, velocityY } = corpse;
    const groundY = terrain.heightAt(x, z);
    const slopeX = (terrain.heightAt(x + radius, z) - terrain.heightAt(x - radius, z)) / (2 * radius);
    const slopeZ = (terrain.heightAt(x, z + radius) - terrain.heightAt(x, z - radius)) / (2 * radius);
    const normal = this.offset.set(-slopeX, 1, -slopeZ).normalize();
    const tilt = new THREE.Quaternion().setFromUnitVectors(UP, normal);
    const clearance = radius / normal.y;
    const halfLength = CONFIG.soldier.height / 2 - radius;
    const end = this.offset.set(Math.sin(yaw) * halfLength, 0, Math.cos(yaw) * halfLength).applyQuaternion(tilt);
    const support = Math.max(groundY, terrain.heightAt(x + end.x, z + end.z) - end.y, terrain.heightAt(x - end.x, z - end.z) + end.y);
    const airHeight = Math.max(0, y - groundY), speed = Math.max(0, -velocityY);
    // Finish the visual descent even in zero-gravity tests and after the simulation stops.
    const fallTime = airHeight ? 2 * airHeight / (speed + Math.sqrt(speed * speed + 2 * CONFIG.physics.gravity * airHeight)) : 0;
    const duration = airHeight > 0.001 ? THREE.MathUtils.clamp(fallTime, 0.12, 1.6) : 0;
    const initialSpeed = duration ? Math.min(1, speed * duration / airHeight) : 0;
    return { corpse, body, tilt, startY: y + radius, restY: support + clearance, groundY, duration, initialSpeed, progress: -1 };
  }

  private setPose(slot: number, landing: Landing, progress: number) {
    const { corpse, body, tilt, startY, restY, groundY, initialSpeed } = landing;
    const { x, z, yaw, radius, aimPitch, weapon } = corpse;
    const fall = progress * (progress + initialSpeed * (1 - progress));
    const y = THREE.MathUtils.lerp(startY, restY, fall), size = radius / CONFIG.soldier.radius;
    const dummy = this.dummy, slope = this.tilt.identity().slerp(tilt, fall);
    dummy.position.set(x, y, z);
    dummy.rotation.set(Math.PI / 2, yaw, 0, 'YXZ');
    dummy.quaternion.premultiply(slope);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    body.setMatrix(slot, dummy.matrix);

    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    this.offset.set((sin * 0.34 + cos * 0.20) * size, 0.18 - radius, (cos * 0.34 - sin * 0.20) * size).applyQuaternion(slope);
    dummy.position.set(x + this.offset.x, y + this.offset.y, z + this.offset.z);
    dummy.rotation.set(-aimPitch, yaw, Math.PI / 2, 'YXZ');
    dummy.quaternion.premultiply(slope);
    setGunScale(dummy.scale, weapon, 1);
    this.write(this.guns, slot);

    this.offset.set(sin * 0.907 * radius, 0.17 - radius, cos * 0.907 * radius).applyQuaternion(slope);
    dummy.position.set(x + this.offset.x, y + this.offset.y, z + this.offset.z);
    dummy.rotation.set(Math.PI / 2, yaw, 0, 'YXZ');
    dummy.quaternion.premultiply(slope);
    dummy.scale.setScalar(1);
    this.write(this.visors, slot);

    dummy.position.set(x, groundY + 0.025, z);
    dummy.quaternion.copy(tilt).multiply(FLAT_SHADOW);
    dummy.scale.setScalar(size / (1 + Math.max(0, y - restY) * 0.35));
    this.write(this.shadows, slot);
  }

  private write(mesh: THREE.InstancedMesh, slot: number) {
    this.dummy.updateMatrix();
    mesh.setMatrixAt(slot, this.dummy.matrix);
    changed(mesh.instanceMatrix, slot);
  }

  private setVisible(visible: boolean) {
    for (const mesh of [this.bodies.mesh, this.armor?.mesh, this.guns, this.visors, this.shadows]) {
      if (mesh) mesh.visible = visible && mesh.count > 0;
    }
  }

  dispose() {
    for (const mesh of [this.bodies.mesh, this.armor?.mesh, this.guns, this.visors, this.shadows]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.dispose();
    }
    (this.bodies.mesh.material as THREE.Material).dispose();
    this.armor?.mesh.geometry.dispose();
  }
}
