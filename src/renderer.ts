import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONFIG, TEAM_COLORS } from './config.ts';
import { BattleSimulation } from './simulation.ts';
import { DEFAULT_TUNING, type TuningValues } from './tuning.ts';
import { Terrain } from './terrain.ts';
import { addTerrainWorld } from './terrain-renderer.ts';

const teamColors = TEAM_COLORS.map(c => new THREE.Color(c));
const bodyColors = [new THREE.Color('#20242b'), new THREE.Color('#925b3b')];

/** Instanced capsule renderer. Hit feedback matches Pluto's emissive white pulse. */
export class BattleRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 350);
  readonly webgl: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly dummy = new THREE.Object3D();
  private readonly world = new THREE.Group();
  readonly bodies: THREE.InstancedMesh;
  readonly guns: THREE.InstancedMesh;
  readonly visors: THREE.InstancedMesh;
  readonly shadows: THREE.InstancedMesh;
  readonly beams: THREE.InstancedMesh;
  readonly beamGlows: THREE.InstancedMesh;
  readonly sparks: THREE.InstancedMesh;
  readonly flashes: THREE.InstancedMesh;
  readonly hitAttribute: THREE.InstancedBufferAttribute;
  readonly uniforms = { time: { value: 0 }, duration: { value: Number(CONFIG.hit.duration) }, intensity: { value: Number(CONFIG.hit.intensity) } };
  readonly resizeObserver: ResizeObserver;
  quality: 'balanced' | 'low' = 'balanced';
  activeEffects = 0;
  visibleUnits = 0;
  private width = 1;
  private height = 1;
  private cameraOffset = new THREE.Vector3();
  private baseRotation = new THREE.Quaternion();
  private axis = new THREE.Vector3(1, 0, 0);
  private shadowTexture: THREE.CanvasTexture;
  private fxColor = new THREE.Color();
  private worldHalfWidth: number;
  private worldHalfDepth: number;
  private bodyRadius: number;

  constructor(readonly host: HTMLElement, initial: TuningValues = DEFAULT_TUNING) {
    this.worldHalfWidth = initial.halfWidth; this.worldHalfDepth = initial.halfDepth; this.bodyRadius = initial.radius;
    this.scene.add(this.world);
    this.webgl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.15;
    this.webgl.setClearColor('#9a7886');
    this.webgl.domElement.setAttribute('aria-label', 'Live battlefield: black Plutonians versus brown Sectoids');
    this.webgl.domElement.setAttribute('role', 'img');
    host.append(this.webgl.domElement);
    this.scene.background = new THREE.Color('#9a7886');
    this.scene.fog = new THREE.Fog('#9a7886', 95, 185);
    this.scene.add(new THREE.HemisphereLight('#e5d8f5', '#68313b', 2.3));
    const sun = new THREE.DirectionalLight('#ffd8b9', 3.0); sun.position.set(-25, 50, 10); this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#b7a0ff', 1.9); rim.position.set(25, 20, -35); this.scene.add(rim);

    const capsule = new THREE.CapsuleGeometry(initial.radius, CONFIG.soldier.height - initial.radius * 2, 2, 6);
    this.hitAttribute = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.capacity), 1);
    this.hitAttribute.setUsage(THREE.DynamicDrawUsage); capsule.setAttribute('aHitAt', this.hitAttribute);
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.18 });
    skin.onBeforeCompile = shader => {
      shader.uniforms.uBattleTime = this.uniforms.time;
      shader.uniforms.uFlashDuration = this.uniforms.duration;
      shader.uniforms.uFlashIntensity = this.uniforms.intensity;
      shader.vertexShader = 'attribute float aHitAt; varying float vHitAt;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvHitAt = aHitAt;');
      shader.fragmentShader = 'varying float vHitAt; uniform float uBattleTime; uniform float uFlashDuration; uniform float uFlashIntensity;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfloat hitAge = uBattleTime - vHitAt;\nfloat hitPulse = step(0.0, hitAge) * (1.0 - step(uFlashDuration, hitAge));\ntotalEmissiveRadiance += vec3(hitPulse * uFlashIntensity * 2.0);');
    };
    skin.customProgramCacheKey = () => 'pluto-instanced-hit-v1';
    this.bodies = this.instances(capsule, skin, CONFIG.capacity);
    this.guns = this.instances(new THREE.BoxGeometry(0.11, 0.13, 0.68), new THREE.MeshStandardMaterial({ color: '#33343b', roughness: 0.64, metalness: 0.5 }), CONFIG.capacity);
    this.visors = this.instances(new THREE.BoxGeometry(0.25, 0.055, 0.045), new THREE.MeshBasicMaterial({ toneMapped: false }), CONFIG.capacity);
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 64;
    const context = shadowCanvas.getContext('2d')!;
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(12,6,17,0.42)'); gradient.addColorStop(0.55, 'rgba(12,6,17,0.23)'); gradient.addColorStop(1, 'rgba(12,6,17,0)');
    context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
    this.shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    this.shadows = this.instances(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false, toneMapped: false }), CONFIG.capacity);
    this.shadows.renderOrder = 1;

    const beamGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.beams = this.instances(beamGeometry, new THREE.MeshBasicMaterial({ depthWrite: false, toneMapped: false }), CONFIG.maxEffects);
    this.beamGlows = this.instances(beamGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), CONFIG.maxEffects);
    this.sparks = this.instances(beamGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), CONFIG.maxEffects * 3);
    this.flashes = this.instances(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), CONFIG.maxEffects);
    this.beams.renderOrder = this.beamGlows.renderOrder = this.flashes.renderOrder = 2;
    this.buildWorld();
    this.controls = new OrbitControls(this.camera, this.webgl.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.enableRotate = true; this.controls.screenSpacePanning = false;
    this.controls.minDistance = 12; this.controls.maxDistance = 150;
    this.controls.minPolarAngle = 0.15; this.controls.maxPolarAngle = Math.PI / 2 - 0.12;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => {
      // Bound panning without letting camera and target diverge.
      const x = THREE.MathUtils.clamp(this.controls.target.x, -this.worldHalfWidth, this.worldHalfWidth), z = THREE.MathUtils.clamp(this.controls.target.z, -this.worldHalfDepth, this.worldHalfDepth);
      this.camera.position.x += x - this.controls.target.x; this.camera.position.z += z - this.controls.target.z;
      this.controls.target.x = x; this.controls.target.z = z;
    });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host); this.resize();
    this.resetCamera();
  }

  private instances(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(mesh);
    return mesh;
  }

  private upload(mesh: THREE.InstancedMesh) {
    // Upload occupied instances, rather than the entire reinforcement reserve.
    mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16); mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, mesh.count * 3); mesh.instanceColor.needsUpdate = true;
    }
  }

  private terrain: Terrain | null = null;
  private renderScale = 1;
  private adaptationFrames = 0;
  private adaptationTotal = 0;
  private beamDirection = new THREE.Vector3();
  private beamAxis = new THREE.Vector3(0, 0, 1);
  private buildWorld() {
    addTerrainWorld(this.world, this.terrain ?? Terrain.flat(this.worldHalfWidth, this.worldHalfDepth));
  }

  private framingDistance(aspect: number) {
    const halfHeight = Math.max(this.worldHalfDepth * 0.86, this.worldHalfWidth * 0.77 / aspect) + Math.max(0, this.terrain?.maxHeight ?? 0);
    return halfHeight / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }
  resetCamera() {
    // Flush orbit/pan inertia before restoring the initial perspective view.
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    this.controls.target.set(0, (this.terrain?.maxHeight ?? 0) * 0.3, 0);
    this.camera.position.set(13, 47, 43).setLength(this.framingDistance(this.camera.aspect)); this.camera.zoom = 1;
    this.camera.lookAt(0, 0, 0); this.camera.updateProjectionMatrix(); this.controls.update(); this.controls.enableDamping = damping;
  }
  zoom(factor: number) {
    this.cameraOffset.copy(this.camera.position).sub(this.controls.target);
    this.cameraOffset.setLength(THREE.MathUtils.clamp(this.cameraOffset.length() / factor, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(this.cameraOffset); this.controls.update();
  }
  project(x: number, y: number, z: number) { return new THREE.Vector3(x, y, z).project(this.camera); }
  resize() {
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
    const aspect = this.width / this.height;
    // Preserve the user's orbit and relative zoom when the viewport changes shape.
    if (this.controls && this.camera.aspect !== aspect) {
      this.cameraOffset.copy(this.camera.position).sub(this.controls.target);
      this.cameraOffset.multiplyScalar(this.framingDistance(aspect) / this.framingDistance(this.camera.aspect));
      this.cameraOffset.clampLength(this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(this.cameraOffset);
    }
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.webgl.setPixelRatio(Math.min(devicePixelRatio, this.quality === 'low' ? 1 : 1.5) * this.renderScale);
    this.webgl.setSize(this.width, this.height);
  }
  setQuality(quality: 'balanced' | 'low') { this.quality = quality; this.renderScale = 1; this.resize(); }
  adapt(elapsedMs: number) {
    if (elapsedMs > 100) return;
    this.adaptationTotal += elapsedMs; this.adaptationFrames++;
    if (this.adaptationFrames < 120) return;
    const mean = this.adaptationTotal / this.adaptationFrames;
    const next = mean > 18.5 ? Math.max(0.65, this.renderScale - 0.1) : mean < 16.8 ? Math.min(1, this.renderScale + 0.05) : this.renderScale;
    this.adaptationTotal = this.adaptationFrames = 0;
    if (Math.abs(next - this.renderScale) > 0.001) { this.renderScale = next; this.resize(); }
  }
  get resolutionScale() { return this.renderScale; }

  update(sim: BattleSimulation, alpha: number, visualTime: number) {
    if (this.terrain !== sim.terrain) {
      this.world.traverse(object => { const mesh = object as THREE.InstancedMesh; if (mesh.isInstancedMesh) mesh.dispose(); mesh.geometry?.dispose(); if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose(); });
      this.world.clear(); this.worldHalfWidth = sim.grid.halfWidth; this.worldHalfDepth = sim.grid.halfDepth; this.terrain = sim.terrain; this.buildWorld(); this.resetCamera();
    }
    if (this.bodyRadius !== sim.tuning.radius) {
      this.bodies.geometry.dispose(); this.bodyRadius = sim.tuning.radius;
      this.bodies.geometry = new THREE.CapsuleGeometry(this.bodyRadius, CONFIG.soldier.height - this.bodyRadius * 2, 2, 6);
      this.bodies.geometry.setAttribute('aHitAt', this.hitAttribute);
    }
    this.uniforms.time.value = visualTime;
    this.uniforms.duration.value = sim.tuning.flashDuration; this.uniforms.intensity.value = sim.tuning.flashIntensity;
    let count = 0;
    for (let i = 0; i < sim.used; i++) {
      const dead = sim.hp[i] <= 0, age = dead ? visualTime - sim.diedAt[i] : 0;
      if (dead && age >= CONFIG.corpseLifetime) continue;
      const x = THREE.MathUtils.lerp(sim.previousX[i], sim.x[i], alpha), z = THREE.MathUtils.lerp(sim.previousZ[i], sim.z[i], alpha);
      const groundY = sim.hp[i] > 0 ? sim.terrain.heightAt(x, z) : sim.y[i];
      const yaw = sim.facing[i], fall = dead ? Math.min(1, age / 0.32) : 0;
      const fade = dead ? Math.min(1, (CONFIG.corpseLifetime - age) / 0.45) : 1;
      const bob = !dead && sim.moving[i] ? Math.sin(sim.time * 17 + i * 3.7) * 0.025 : 0;
      this.dummy.position.set(x, groundY + CONFIG.soldier.height / 2 * (1 - fall) + sim.radius[i] * fall + bob, z);
      this.dummy.rotation.set(fall * Math.PI / 2, yaw, 0, 'YXZ'); this.dummy.scale.setScalar(fade);
      this.dummy.updateMatrix(); this.bodies.setMatrixAt(count, this.dummy.matrix); this.bodies.setColorAt(count, bodyColors[sim.team[i]]);
      this.hitAttribute.setX(count, Number.isFinite(sim.lastHit[i]) ? sim.lastHit[i] : -10000);

      this.baseRotation.setFromEuler(this.dummy.rotation);
      const size = sim.radius[i] / CONFIG.soldier.radius;
      this.dummy.position.set(x + (Math.sin(yaw) * 0.34 + Math.cos(yaw) * 0.20) * size, groundY + 0.69 * (1 - fall) + 0.18 * fall + bob, z + (Math.cos(yaw) * 0.34 - Math.sin(yaw) * 0.20) * size);
      this.dummy.rotation.set(-sim.aimPitch[i], yaw, fall * Math.PI / 2, 'YXZ'); this.dummy.updateMatrix(); this.guns.setMatrixAt(count, this.dummy.matrix);
      this.dummy.position.set(x + Math.sin(yaw) * 0.907 * sim.radius[i], groundY + 0.88 * (1 - fall) + 0.17 * fall + bob, z + Math.cos(yaw) * 0.907 * sim.radius[i]);
      this.dummy.quaternion.copy(this.baseRotation);
      this.dummy.updateMatrix(); this.visors.setMatrixAt(count, this.dummy.matrix); this.visors.setColorAt(count, teamColors[sim.team[i]]);
      this.dummy.position.set(x, groundY + 0.025, z);
      const gx = (sim.terrain.heightAt(x + 0.12, z) - sim.terrain.heightAt(x - 0.12, z)) / 0.24;
      const gz = (sim.terrain.heightAt(x, z + 0.12) - sim.terrain.heightAt(x, z - 0.12)) / 0.24;
      this.dummy.rotation.set(-Math.PI / 2 + Math.atan(gz), -Math.atan(gx), 0); this.dummy.scale.setScalar(fade * size);
      this.dummy.updateMatrix(); this.shadows.setMatrixAt(count, this.dummy.matrix);
      count++;
    }
    for (const mesh of [this.bodies, this.guns, this.visors, this.shadows]) {
      mesh.count = count; this.upload(mesh);
    }
    this.hitAttribute.clearUpdateRanges(); this.hitAttribute.addUpdateRange(0, count); this.hitAttribute.needsUpdate = true; this.visibleUnits = count;

    let beams = 0, sparks = 0, flashes = 0;
    const events = sim.shots;
    for (let i = 0; i < events.capacity; i++) {
      const age = visualTime - events.at[i]; if (age < 0 || age > 0.24) continue;
      const dx = events.endX[i] - events.x[i], dz = events.endZ[i] - events.z[i], dy = events.endY[i] - events.y[i], length = Math.hypot(dx, dy, dz);
      const color = teamColors[events.team[i]];
      if (age < 0.075) {
        this.dummy.position.set((events.x[i] + events.endX[i]) / 2, (events.y[i] + events.endY[i]) / 2, (events.z[i] + events.endZ[i]) / 2);
        this.beamDirection.set(dx, dy, dz).normalize(); this.dummy.quaternion.setFromUnitVectors(this.beamAxis, this.beamDirection); this.dummy.scale.set(0.055, 0.055, length); this.dummy.updateMatrix();
        this.beams.setMatrixAt(beams, this.dummy.matrix); this.beams.setColorAt(beams, this.fxColor.copy(color));
        this.dummy.scale.set(0.17, 0.17, length); this.dummy.updateMatrix(); this.beamGlows.setMatrixAt(beams, this.dummy.matrix); this.beamGlows.setColorAt(beams, color); beams++;
      }
      if (age < 0.07) {
        this.dummy.position.set(events.x[i], events.y[i], events.z[i]); this.dummy.rotation.set(0, age * 30 + i, Math.PI / 4);
        this.dummy.scale.setScalar(0.13 * (1 - age / 0.07)); this.dummy.updateMatrix(); this.flashes.setMatrixAt(flashes, this.dummy.matrix); this.flashes.setColorAt(flashes++, color);
      }
      if (this.quality !== 'low' && i % 3 === 0) for (let p = 0; p < 2; p++) {
        const angle = i * 2.399 + p * 2.094, speed = 1.8 + (i % 3) * 0.6;
        this.dummy.position.set(events.endX[i] + Math.cos(angle) * age * speed, events.endY[i] + age * 2 - age * age * 10, events.endZ[i] + Math.sin(angle) * age * speed);
        this.dummy.rotation.set(angle, angle, 0); this.dummy.scale.setScalar(0.045 * (1 - age / 0.24)); this.dummy.updateMatrix();
        this.sparks.setMatrixAt(sparks, this.dummy.matrix); this.sparks.setColorAt(sparks++, color);
      }
    }
    this.beams.count = this.beamGlows.count = beams; this.sparks.count = sparks; this.flashes.count = flashes;
    for (const mesh of [this.beams, this.beamGlows, this.sparks, this.flashes]) if (mesh.count > 0) this.upload(mesh);
    this.activeEffects = beams + sparks + flashes;
    this.controls.update();
    if (this.terrain && Math.abs(this.camera.position.x) <= this.worldHalfWidth && Math.abs(this.camera.position.z) <= this.worldHalfDepth) {
      const minimum = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 1.25;
      if (this.camera.position.y < minimum) { this.camera.position.y = minimum; this.camera.lookAt(this.controls.target); }
    }
    this.webgl.render(this.scene, this.camera);
  }

  dispose() {
    this.resizeObserver.disconnect(); this.controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    this.scene.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.geometry) geometries.add(mesh.geometry); if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); this.shadowTexture.dispose(); this.webgl.dispose();
  }
}
