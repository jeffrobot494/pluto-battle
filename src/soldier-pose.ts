import * as THREE from 'three';
import { CONFIG, NO_WEAPON, WEAPON_ID } from './config.ts';

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const HALF_HEIGHT = CONFIG.soldier.height / 2;

/** A body and its attachments share the same fall direction and roll. */
export class SoldierPose {
  readonly center = new THREE.Vector3();
  readonly rotation = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();

  set(x: number, y: number, z: number, yaw: number, fall = 0, fallOffset = 0, roll = 0) {
    this.center.set(x, y, z);
    this.rotation.setFromAxisAngle(UP, yaw);
    if (fall > 0) {
      this.axis.set(Math.cos(fallOffset), 0, -Math.sin(fallOffset));
      this.rotation.multiply(this.turn.setFromAxisAngle(this.axis, fall * Math.PI / 2));
      this.rotation.multiply(this.turn.setFromAxisAngle(UP, fall * roll));
    }
  }

  gun(target: THREE.Object3D, size: number, aimPitch: number) {
    target.position.set(0.20 * size, 0.69 - HALF_HEIGHT, 0.34 * size)
      .applyQuaternion(this.rotation).add(this.center);
    target.quaternion.copy(this.rotation).multiply(this.turn.setFromAxisAngle(RIGHT, -aimPitch));
  }

  visor(target: THREE.Object3D, radius: number) {
    target.position.set(0, 0.88 - HALF_HEIGHT, 0.907 * radius)
      .applyQuaternion(this.rotation).add(this.center);
    target.quaternion.copy(this.rotation);
  }
}

export function setGunScale(scale: THREE.Vector3, weapon: number, size: number) {
  if (weapon === NO_WEAPON) scale.setScalar(0);
  else if (weapon === WEAPON_ID.sniper) scale.set(size * 0.8, size * 0.85, size * 1.7);
  else if (weapon === WEAPON_ID.shotgun) scale.set(size * 1.8, size * 1.25, size * 0.7);
  else if (weapon === WEAPON_ID.rocket) scale.set(size * 1.6, size * 1.4, size * 1.25);
  else scale.setScalar(size);
}
