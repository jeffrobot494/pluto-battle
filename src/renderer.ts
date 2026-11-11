import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONFIG, TEAM_COLORS, WEAPON_ID, WEAPONS } from './config.ts';
import { BattleSimulation } from './simulation.ts';
import { CameraTwist } from './camera-twist.ts';
import { DEFAULT_TUNING, type TuningValues } from './tuning.ts';
import { Terrain } from './terrain.ts';
import { addTerrainWorld, loadBedrockDetail, paletteOf } from './terrain-renderer.ts';
import type { GroundPoint } from './battle-input.ts';
import { UPGRADES } from './upgrades.ts';
import { CorpseRenderer, type CorpseArmor } from './corpse-renderer.ts';
import { SoldierPose, setGunScale } from './soldier-pose.ts';

const teamColors = TEAM_COLORS.map(c => new THREE.Color(c));
const bodyColors = [new THREE.Color('#20242b'), new THREE.Color('#925b3b')];
const upgradeColors = WEAPONS.map((_, w) => new THREE.Color(UPGRADES.find(u => u.weapon === w)?.color ?? '#ffffff'));
const PULSE_SECONDS = 0.7;
// Ability zone mesh resolution: a polar grid draped over the terrain.
const ZONE_RINGS = 40, ZONE_SEGMENTS = 128;

/** Instanced capsule renderer. Hit feedback matches Pluto's emissive white pulse. */
export class BattleRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 350);
  readonly webgl: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly twist: CameraTwist;
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
  readonly blastSpheres: THREE.InstancedMesh;
  readonly blastSparks: THREE.InstancedMesh;
  readonly blastTimes: THREE.InstancedBufferAttribute;
  readonly blastPreview: THREE.Mesh;
  readonly rocketBodies: THREE.InstancedMesh;
  readonly rocketFlames: THREE.InstancedMesh;
  readonly smokePuffs: THREE.InstancedMesh;
  readonly smokeTimes: THREE.InstancedBufferAttribute;
  readonly selectionRing: THREE.Mesh;
  readonly upgradePulses: THREE.InstancedMesh;
  readonly zoneFill: THREE.Mesh;
  readonly zoneEdge: THREE.Mesh;
  /** Soldier ID highlighted by the selection ring; 0 for none. */
  selectedId = 0;
  private upgradeSeen = new Uint16Array(CONFIG.capacity);
  private pulseAt = new Float64Array(CONFIG.capacity).fill(-Infinity);
  private pulseSim: BattleSimulation | null = null;
  private corpseRenderer: CorpseRenderer | null = null;
  private corpseArmor?: CorpseArmor;
  private readonly corpseRanks = new Map<number, number>();
  private readonly projected = new THREE.Vector3();
  activeExplosions = 0;
  readonly hitAttribute: THREE.InstancedBufferAttribute;
  readonly uniforms = { time: { value: 0 }, duration: { value: Number(CONFIG.hit.duration) }, intensity: { value: Number(CONFIG.hit.intensity) } };
  readonly resizeObserver: ResizeObserver;
  quality: 'balanced' | 'low' = 'balanced';
  activeEffects = 0;
  visibleUnits = 0;
  private width = 1;
  private height = 1;
  private cameraOffset = new THREE.Vector3();
  private readonly soldierPose = new SoldierPose();
  private axis = new THREE.Vector3(1, 0, 0);
  private shadowTexture: THREE.CanvasTexture;
  private readonly bedrockDetail: ReturnType<typeof loadBedrockDetail>;
  private fxColor = new THREE.Color();
  private worldHalfWidth: number;
  private worldHalfDepth: number;
  private bodyRadius: number;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly groundPoint = new THREE.Vector3();

  constructor(readonly host: HTMLElement, initial: TuningValues = DEFAULT_TUNING) {
    this.worldHalfWidth = initial.halfWidth; this.worldHalfDepth = initial.halfDepth; this.bodyRadius = initial.radius;
    this.scene.add(this.world);
    this.webgl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
    this.bedrockDetail = loadBedrockDetail();
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.15;
    this.webgl.setClearColor('#9a7886');
    this.webgl.domElement.setAttribute('aria-label', 'Live battlefield: black Plutonians versus brown Sectoids');
    this.webgl.domElement.setAttribute('role', 'img');
    host.append(this.webgl.domElement);
    this.scene.background = new THREE.Color('#9a7886');
    this.scene.fog = new THREE.Fog('#9a7886', 95, 185);
    this.hemi = new THREE.HemisphereLight('#e5d8f5', '#68313b', 2.3); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffd8b9', 3.0); this.sun.position.set(-25, 50, 10); this.scene.add(this.sun);
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
    const blastGeometry = new THREE.IcosahedronGeometry(1, 1);
    this.blastTimes = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.explosion.effects), 1);
    this.blastTimes.setUsage(THREE.DynamicDrawUsage); blastGeometry.setAttribute('aBlastAt', this.blastTimes);
    const blastMaterial = new THREE.MeshBasicMaterial({ color: '#ffd184', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    blastMaterial.onBeforeCompile = shader => {
      shader.uniforms.uBattleTime = this.uniforms.time;
      shader.vertexShader = 'attribute float aBlastAt; varying float vBlastAt;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlastAt = aBlastAt;');
      shader.fragmentShader = 'uniform float uBattleTime; varying float vBlastAt;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.a *= pow(clamp(1.0 - (uBattleTime - vBlastAt) / ${CONFIG.explosion.duration}, 0.0, 1.0), 2.0);`);
    };
    blastMaterial.customProgramCacheKey = () => 'pluto-blast-v1';
    this.blastSpheres = this.instances(blastGeometry, blastMaterial, CONFIG.explosion.effects);
    this.blastSparks = this.instances(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#ffb058', toneMapped: false }), CONFIG.explosion.effects * 8);
    // Rockets: a small finned-less body (lathe profile, nose toward +Z) and an additive exhaust flame. One draw call each.
    const rocketShape = new THREE.LatheGeometry([new THREE.Vector2(0, -0.2), new THREE.Vector2(0.05, -0.2), new THREE.Vector2(0.05, 0.1), new THREE.Vector2(0.035, 0.17), new THREE.Vector2(0, 0.22)], 6).rotateX(Math.PI / 2);
    this.rocketBodies = this.instances(rocketShape, new THREE.MeshStandardMaterial({ color: '#ddd5cc', roughness: 0.5, metalness: 0.35 }), CONFIG.rocket.maxInFlight);
    this.rocketFlames = this.instances(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), CONFIG.rocket.maxInFlight);
    this.rocketFlames.renderOrder = 3;
    // Smoke fades in the shader from a per-puff birth time, so puffs never need colour uploads.
    const smokeGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.smokeTimes = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.rocket.smoke), 1);
    this.smokeTimes.setUsage(THREE.DynamicDrawUsage); smokeGeometry.setAttribute('aSmokeAt', this.smokeTimes);
    const smokeMaterial = new THREE.MeshBasicMaterial({ color: '#cbbfc6', transparent: true, opacity: 0.5, depthWrite: false });
    smokeMaterial.onBeforeCompile = shader => {
      shader.uniforms.uBattleTime = this.uniforms.time;
      shader.vertexShader = 'attribute float aSmokeAt; varying float vSmokeAt;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSmokeAt = aSmokeAt;');
      shader.fragmentShader = 'uniform float uBattleTime; varying float vSmokeAt;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\nfloat smokeLife = clamp((uBattleTime - vSmokeAt) / ${CONFIG.rocket.smokeLife.toFixed(3)}, 0.0, 1.0);\ndiffuseColor.rgb *= 1.0 - 0.35 * (1.0 - smokeLife);\ndiffuseColor.a *= (1.0 - smokeLife) * (1.0 - smokeLife);`);
    };
    smokeMaterial.customProgramCacheKey = () => 'pluto-smoke-v1';
    this.smokePuffs = this.instances(smokeGeometry, smokeMaterial, CONFIG.rocket.smoke);
    this.smokePuffs.renderOrder = 2;
    this.blastSpheres.renderOrder = 3;
    this.blastPreview = new THREE.Mesh(new THREE.RingGeometry(0.98, 1, 64), new THREE.MeshBasicMaterial({ color: '#ffd184', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    this.blastPreview.rotation.x = -Math.PI / 2; this.blastPreview.visible = false; this.scene.add(this.blastPreview);
    this.selectionRing = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.selectionRing.rotation.x = -Math.PI / 2; this.selectionRing.visible = false; this.selectionRing.renderOrder = 2; this.scene.add(this.selectionRing);
    this.upgradePulses = this.instances(new THREE.RingGeometry(0.8, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), CONFIG.capacity * 2);
    this.upgradePulses.renderOrder = 3;
    const fill = new THREE.BufferGeometry(), fillIndex: number[] = [];
    fill.setAttribute('position', new THREE.BufferAttribute(new Float32Array((1 + ZONE_RINGS * ZONE_SEGMENTS) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const at = (ring: number, seg: number) => 1 + (ring - 1) * ZONE_SEGMENTS + seg;
    for (let s = 0; s < ZONE_SEGMENTS; s++) {
      const n = (s + 1) % ZONE_SEGMENTS;
      fillIndex.push(0, at(1, n), at(1, s));
      for (let r = 1; r < ZONE_RINGS; r++) fillIndex.push(at(r, s), at(r, n), at(r + 1, s), at(r, n), at(r + 1, n), at(r + 1, s));
    }
    fill.setIndex(fillIndex);
    const zoneMaterial = (opacity: number) => new THREE.MeshBasicMaterial({ transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.zoneFill = new THREE.Mesh(fill, zoneMaterial(0.13));
    const edge = new THREE.BufferGeometry(), edgeIndex: number[] = [], edgePoints = ZONE_SEGMENTS * 2;
    edge.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgePoints * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    for (let s = 0; s < edgePoints; s++) { const n = (s + 1) % edgePoints; edgeIndex.push(s * 2, n * 2, s * 2 + 1, n * 2, n * 2 + 1, s * 2 + 1); }
    edge.setIndex(edgeIndex);
    this.zoneEdge = new THREE.Mesh(edge, zoneMaterial(0.9));
    for (const mesh of [this.zoneFill, this.zoneEdge]) { mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 5; this.scene.add(mesh); }
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
    this.twist = new CameraTwist(this.webgl.domElement, this.camera, this.controls);
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
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private buildWorld() {
    addTerrainWorld(this.world, this.terrain ?? Terrain.flat(this.worldHalfWidth, this.worldHalfDepth), this.bedrockDetail);
    // Each map carries its own sky, fog and light colours.
    const palette = paletteOf(this.terrain), relief = Math.max(0, this.terrain?.maxHeight ?? 0);
    (this.scene.background as THREE.Color).set(palette.sky); this.webgl.setClearColor(palette.sky);
    const fog = this.scene.fog as THREE.Fog; fog.color.set(palette.sky); fog.near = 110 + relief * 3; fog.far = 220 + relief * 5;
    this.hemi.color.set(palette.hemiSky); this.hemi.groundColor.set(palette.hemiGround);
    this.sun.color.set(palette.sun); this.sun.intensity = palette.sunIntensity;
  }

  private framingDistance(aspect: number) {
    const halfHeight = Math.max(this.worldHalfDepth * 0.92, this.worldHalfWidth * 0.82 / aspect) + Math.max(0, this.terrain?.maxHeight ?? 0) * 1.1;
    return halfHeight / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }
  resetCamera() {
    // Flush orbit/pan inertia and any coasting twist before restoring the initial perspective view.
    this.twist.stop();
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    this.controls.target.set(0, (this.terrain?.maxHeight ?? 0) * 0.3, 0);
    this.camera.position.set(11, 58, 40).setLength(this.framingDistance(this.camera.aspect)); this.camera.zoom = 1;
    this.camera.lookAt(0, 0, 0); this.camera.updateProjectionMatrix(); this.controls.update(); this.controls.enableDamping = damping;
  }
  zoom(factor: number) {
    this.cameraOffset.copy(this.camera.position).sub(this.controls.target);
    this.cameraOffset.setLength(THREE.MathUtils.clamp(this.cameraOffset.length() / factor, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(this.cameraOffset); this.controls.update();
  }
  project(x: number, y: number, z: number) { return new THREE.Vector3(x, y, z).project(this.camera); }
  pickGround(clientX: number, clientY: number, sim: BattleSimulation): GroundPoint | null {
    const rect = this.webgl.domElement.getBoundingClientRect();
    this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray, top = Math.max(0, sim.terrain.maxHeight), bottom = Math.min(0, sim.terrain.minHeight);
    if (ray.direction.y >= -1e-6) return null;
    // March from the terrain's highest level down to its lowest, then bisect the first surface crossing.
    let near = Math.max(0, (top - ray.origin.y) / ray.direction.y), far = Math.max(near, (bottom - ray.origin.y) / ray.direction.y);
    const above = (t: number) => { ray.at(t, this.groundPoint); return this.groundPoint.y > sim.terrain.heightAt(this.groundPoint.x, this.groundPoint.z); };
    if (top > bottom) {
      const samples = 96, span = far - near;
      for (let n = 1; n <= samples; n++) { const t = near + span * n / samples; if (!above(t)) { far = t; near = t - span / samples; break; } }
      for (let n = 0; n < 24; n++) { const mid = (near + far) / 2; if (above(mid)) near = mid; else far = mid; }
    }
    ray.at(far, this.groundPoint);
    const { x, z } = this.groundPoint;
    return Math.abs(x) <= sim.grid.halfWidth && Math.abs(z) <= sim.grid.halfDepth ? { x, y: sim.terrain.heightAt(x, z), z } : null;
  }
  /** Nearest living soldier whose body is within `tolerance` CSS pixels of a screen point, or -1. */
  pickSoldier(clientX: number, clientY: number, sim: BattleSimulation, tolerance = 30) {
    const rect = this.webgl.domElement.getBoundingClientRect();
    let best = -1, bestDistance = tolerance;
    this.camera.updateMatrixWorld();
    for (let i = 0; i < sim.used; i++) {
      if (sim.hp[i] <= 0) continue;
      // Test both the chest and the feet so foreshortened capsules remain easy to hit.
      for (const height of [CONFIG.soldier.height * 0.55, 0.15]) {
        this.projected.set(sim.x[i], sim.y[i] + height, sim.z[i]).project(this.camera);
        if (this.projected.z > 1) continue;
        const d = Math.hypot(rect.left + (this.projected.x + 1) / 2 * rect.width - clientX, rect.top + (1 - this.projected.y) / 2 * rect.height - clientY);
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
    }
    return best;
  }
  /** Screen position (CSS pixels relative to the canvas) above a soldier's head, or null when behind the camera. */
  soldierScreen(sim: BattleSimulation, slot: number, height = CONFIG.soldier.height + 0.15) {
    this.projected.set(sim.x[slot], sim.y[slot] + height, sim.z[slot]).project(this.camera);
    if (this.projected.z > 1) return null;
    return { x: (this.projected.x + 1) / 2 * this.width, y: (1 - this.projected.y) / 2 * this.height };
  }
  /** Draws the ability zone draped over the terrain; pass null to hide it. */
  setZone(point: GroundPoint | null, radius = 0, color = '#ffffff', opacity = 1) {
    const visible = !!point && radius > 0 && opacity > 0;
    this.zoneFill.visible = this.zoneEdge.visible = visible;
    if (!visible || !point) return;
    const ground = this.terrain ?? Terrain.flat(this.worldHalfWidth, this.worldHalfDepth);
    const height = (x: number, z: number) => ground.heightAt(x, z) + 0.12;
    const fill = this.zoneFill.geometry.getAttribute('position') as THREE.BufferAttribute;
    fill.setXYZ(0, point.x, height(point.x, point.z), point.z);
    for (let r = 1; r <= ZONE_RINGS; r++) for (let s = 0; s < ZONE_SEGMENTS; s++) {
      const angle = s / ZONE_SEGMENTS * Math.PI * 2, d = radius * r / ZONE_RINGS;
      const x = point.x + Math.cos(angle) * d, z = point.z + Math.sin(angle) * d;
      fill.setXYZ(1 + (r - 1) * ZONE_SEGMENTS + s, x, height(x, z), z);
    }
    fill.needsUpdate = true;
    const edge = this.zoneEdge.geometry.getAttribute('position') as THREE.BufferAttribute, width = 0.14 + radius * 0.006, edgePoints = ZONE_SEGMENTS * 2;
    for (let s = 0; s < edgePoints; s++) {
      const angle = s / edgePoints * Math.PI * 2, c = Math.cos(angle), n = Math.sin(angle);
      const inner = radius - width, outer = radius + width * 0.4;
      edge.setXYZ(s * 2, point.x + c * inner, height(point.x + c * inner, point.z + n * inner), point.z + n * inner);
      edge.setXYZ(s * 2 + 1, point.x + c * outer, height(point.x + c * outer, point.z + n * outer), point.z + n * outer);
    }
    edge.needsUpdate = true;
    for (const mesh of [this.zoneFill, this.zoneEdge]) (mesh.material as THREE.MeshBasicMaterial).color.set(color);
    (this.zoneFill.material as THREE.MeshBasicMaterial).opacity = 0.13 * opacity;
    (this.zoneEdge.material as THREE.MeshBasicMaterial).opacity = 0.9 * opacity;
  }
  setExplosionPreview(point: GroundPoint | null, radius: number) {
    this.blastPreview.visible = !!point;
    if (point) { this.blastPreview.position.set(point.x, point.y + 0.025, point.z); this.blastPreview.scale.setScalar(radius); }
  }
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
    if (this.pulseSim !== sim || this.bodyRadius !== sim.tuning.radius) {
      this.corpseRenderer?.dispose();
      this.corpseRenderer = null;
    }
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
    let count = 0, pulses = 0;
    const now = performance.now() / 1000;
    if (this.pulseSim !== sim) { this.pulseSim = sim; this.upgradeSeen.set(sim.upgrades.subarray(0, CONFIG.capacity)); this.pulseAt.fill(-Infinity); }
    this.selectionRing.visible = false;
    for (let i = 0; i < sim.used; i++) {
      const upgraded = sim.upgrades[i];
      // Real time, not battle time, so feedback still plays when an upgrade lands while paused.
      if (upgraded !== this.upgradeSeen[i]) { this.pulseAt[i] = upgraded > this.upgradeSeen[i] ? now : -Infinity; this.upgradeSeen[i] = upgraded; }
      const dead = sim.hp[i] <= 0, age = dead ? visualTime - sim.diedAt[i] : 0;
      if (dead && age >= CONFIG.corpseLifetime) continue;
      const x = THREE.MathUtils.lerp(sim.previousX[i], sim.x[i], alpha), z = THREE.MathUtils.lerp(sim.previousZ[i], sim.z[i], alpha);
      const surface = sim.terrain.heightAt(x, z);
      // Grounded soldiers follow the interpolated terrain; airborne bodies and corpses use simulated height.
      const groundY = sim.hp[i] > 0 && sim.grounded[i] ? surface : THREE.MathUtils.lerp(sim.previousY[i], sim.y[i], alpha);
      const fall = dead ? THREE.MathUtils.clamp(age / 0.32, 0, 1) : 0;
      const fade = dead && !(sim.tuning.keepCorpses && sim.pendingCorpse[i]) ? Math.min(1, (CONFIG.corpseLifetime - age) / 0.45) : 1;
      const bob = !dead && sim.grounded[i] && sim.moving[i] ? Math.sin(sim.time * 17 + i * 3.7) * 0.025 : 0;
      const radius = sim.radius[i], halfHeight = CONFIG.soldier.height / 2;
      const height = dead ? radius + (halfHeight - radius) * Math.cos(fall * Math.PI / 2) : halfHeight;
      const pose = this.soldierPose;
      pose.set(x, groundY + height + bob, z, sim.facing[i], fall, sim.deathFallOffset[i], sim.deathRoll[i]);
      this.dummy.position.copy(pose.center);
      this.dummy.quaternion.copy(pose.rotation);
      this.dummy.scale.setScalar(fade);
      this.dummy.updateMatrix(); this.bodies.setMatrixAt(count, this.dummy.matrix); this.bodies.setColorAt(count, bodyColors[sim.team[i]]);
      this.hitAttribute.setX(count, Number.isFinite(sim.lastHit[i]) ? sim.lastHit[i] : -10000);

      const size = radius / CONFIG.soldier.radius;
      pose.gun(this.dummy, radius, sim.aimPitch[i]);
      setGunScale(this.dummy.scale, sim.weapon[i], fade);
      this.dummy.updateMatrix(); this.guns.setMatrixAt(count, this.dummy.matrix);
      pose.visor(this.dummy, radius);
      this.dummy.scale.setScalar(fade);
      this.dummy.updateMatrix(); this.visors.setMatrixAt(count, this.dummy.matrix); this.visors.setColorAt(count, teamColors[sim.team[i]]);
      const aboveGround = Math.max(0, groundY - surface);
      this.dummy.position.set(x, surface + 0.025, z);
      const gx = (sim.terrain.heightAt(x + 0.12, z) - sim.terrain.heightAt(x - 0.12, z)) / 0.24;
      const gz = (sim.terrain.heightAt(x, z + 0.12) - sim.terrain.heightAt(x, z - 0.12)) / 0.24;
      this.dummy.rotation.set(-Math.PI / 2 + Math.atan(gz), -Math.atan(gx), 0); this.dummy.scale.setScalar(fade * size / (1 + aboveGround * 0.35));
      this.dummy.updateMatrix(); this.shadows.setMatrixAt(count, this.dummy.matrix);
      if (this.selectedId && sim.id[i] === this.selectedId) {
        this.selectionRing.visible = true; this.selectionRing.position.set(x, surface + 0.04, z); this.selectionRing.scale.setScalar(size * fade);
        (this.selectionRing.material as THREE.MeshBasicMaterial).color.copy(dead ? this.fxColor.set('#8b8190') : teamColors[sim.team[i]]);
      }
      const pulseAge = now - this.pulseAt[i];
      if (!dead && pulseAge >= 0 && pulseAge < PULSE_SECONDS) {
        // Two rings sweep up the body in the new weapon's colour.
        for (let k = 0; k < 2; k++) {
          const p = (pulseAge - k * 0.12) / (PULSE_SECONDS - 0.12); if (p < 0 || p > 1) continue;
          this.dummy.position.set(x, groundY + 0.05 + p * CONFIG.soldier.height, z); this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.setScalar(size * (0.75 - p * 0.35) * (k ? 0.8 : 1)); this.dummy.updateMatrix();
          this.upgradePulses.setMatrixAt(pulses, this.dummy.matrix);
          this.upgradePulses.setColorAt(pulses++, this.fxColor.copy(upgradeColors[sim.upgradeWeapon[i]] ?? teamColors[sim.team[i]]).multiplyScalar(1 - p * 0.6));
        }
      }
      count++;
    }
    for (const mesh of [this.bodies, this.guns, this.visors, this.shadows]) {
      mesh.count = count; this.upload(mesh);
    }
    this.hitAttribute.clearUpdateRanges(); this.hitAttribute.addUpdateRange(0, count); this.hitAttribute.needsUpdate = true;
    if (!this.corpseRenderer && sim.tuning.keepCorpses && sim.retiredCorpses.length) {
      this.corpseRenderer = new CorpseRenderer(this.scene, this, bodyColors, teamColors);
    }
    const retained = this.corpseRenderer?.update(sim, visualTime, this.corpseArmor, this.corpseRanks) ?? 0;
    this.visibleUnits = count + retained;
    this.upgradePulses.count = pulses; if (pulses) this.upload(this.upgradePulses);

    let beams = 0, sparks = 0, flashes = 0;
    const events = sim.shots;
    for (let i = 0; i < events.capacity; i++) {
      const age = visualTime - events.at[i]; if (age < 0 || age > 0.24) continue;
      const dx = events.endX[i] - events.x[i], dz = events.endZ[i] - events.z[i], dy = events.endY[i] - events.y[i], length = Math.hypot(dx, dy, dz);
      const color = teamColors[events.team[i]];
      const sniper = events.weapon[i] === WEAPON_ID.sniper, shotgun = events.weapon[i] === WEAPON_ID.shotgun;
      const beamWidth = sniper ? 0.032 : shotgun ? 0.16 : 0.055, beamLife = sniper ? 0.12 : shotgun ? 0.045 : 0.075;
      if (age < beamLife) {
        this.dummy.position.set((events.x[i] + events.endX[i]) / 2, (events.y[i] + events.endY[i]) / 2, (events.z[i] + events.endZ[i]) / 2);
        this.beamDirection.set(dx, dy, dz).normalize(); this.dummy.quaternion.setFromUnitVectors(this.beamAxis, this.beamDirection); this.dummy.scale.set(beamWidth, beamWidth, length); this.dummy.updateMatrix();
        this.beams.setMatrixAt(beams, this.dummy.matrix); this.beams.setColorAt(beams, this.fxColor.copy(color));
        this.dummy.scale.set(beamWidth * 3, beamWidth * 3, length); this.dummy.updateMatrix(); this.beamGlows.setMatrixAt(beams, this.dummy.matrix); this.beamGlows.setColorAt(beams, color); beams++;
      }
      if (age < 0.07) {
        this.dummy.position.set(events.x[i], events.y[i], events.z[i]); this.dummy.rotation.set(0, age * 30 + i, Math.PI / 4);
        this.dummy.scale.setScalar((shotgun ? 0.23 : sniper ? 0.16 : 0.13) * (1 - age / 0.07)); this.dummy.updateMatrix(); this.flashes.setMatrixAt(flashes, this.dummy.matrix); this.flashes.setColorAt(flashes++, color);
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
    let blasts = 0, debris = 0;
    for (let i = 0; i < sim.explosions.capacity; i++) {
      const e = sim.explosions, age = visualTime - e.at[i];
      if (age < 0 || age >= CONFIG.explosion.duration) continue;
      const progress = age / CONFIG.explosion.duration, radius = e.radius[i] * Math.min(1, 0.12 + progress * 3);
      this.dummy.position.set(e.x[i], e.y[i], e.z[i]); this.dummy.rotation.set(0, i * 2.399, 0); this.dummy.scale.setScalar(radius);
      this.dummy.updateMatrix(); this.blastSpheres.setMatrixAt(blasts, this.dummy.matrix); this.blastTimes.setX(blasts++, e.at[i]);
      if (this.quality !== 'low') for (let p = 0; p < 8; p++) {
        const angle = p * Math.PI / 4 + i * 2.399, reach = e.radius[i] * progress;
        this.dummy.position.set(e.x[i] + Math.cos(angle) * reach, e.y[i] + Math.sin(p * 1.7) ** 2 * reach + 0.1, e.z[i] + Math.sin(angle) * reach);
        this.dummy.rotation.set(angle, age * 8, angle); this.dummy.scale.setScalar(0.11 * (1 - progress));
        this.dummy.updateMatrix(); this.blastSparks.setMatrixAt(debris++, this.dummy.matrix);
      }
    }
    this.blastSpheres.count = blasts; this.blastSparks.count = debris; this.activeExplosions = blasts;
    if (blasts) { this.blastTimes.clearUpdateRanges(); this.blastTimes.addUpdateRange(0, blasts); this.blastTimes.needsUpdate = true; this.upload(this.blastSpheres); }
    if (debris) this.upload(this.blastSparks);
    const rockets = sim.rockets;
    for (let n = 0; n < rockets.count; n++) {
      const dx = rockets.dx[n], dy = rockets.dy[n], dz = rockets.dz[n];
      const x = THREE.MathUtils.lerp(rockets.previousX[n], rockets.x[n], alpha), y = THREE.MathUtils.lerp(rockets.previousY[n], rockets.y[n], alpha), z = THREE.MathUtils.lerp(rockets.previousZ[n], rockets.z[n], alpha);
      this.beamDirection.set(dx, dy, dz); this.dummy.quaternion.setFromUnitVectors(this.beamAxis, this.beamDirection);
      this.dummy.position.set(x, y, z); this.dummy.scale.setScalar(1); this.dummy.updateMatrix(); this.rocketBodies.setMatrixAt(n, this.dummy.matrix);
      const flicker = 0.075 + 0.03 * Math.sin(visualTime * 70 + n * 1.9);
      this.dummy.position.set(x - dx * 0.25, y - dy * 0.25, z - dz * 0.25); this.dummy.scale.set(flicker, flicker, flicker * 2.2);
      this.dummy.updateMatrix(); this.rocketFlames.setMatrixAt(n, this.dummy.matrix);
    }
    this.rocketBodies.count = this.rocketFlames.count = rockets.count;
    if (rockets.count) { this.upload(this.rocketBodies); this.upload(this.rocketFlames); }
    let puffs = 0;
    const smoke = sim.smoke, life = CONFIG.rocket.smokeLife, thin = this.quality === 'low';
    // Only scan when puffs can still be alive; an idle battle skips the loop entirely.
    if (visualTime - smoke.at[(smoke.cursor + smoke.capacity - 1) % smoke.capacity] < life) for (let i = 0; i < smoke.capacity; i++) {
      const age = visualTime - smoke.at[i];
      if (age < 0 || age >= life || (thin && i % 2)) continue;
      this.dummy.position.set(smoke.x[i], smoke.y[i] + age * 0.35, smoke.z[i]); this.dummy.rotation.set(i * 0.7, i * 2.399, 0);
      this.dummy.scale.setScalar(0.09 + age * 0.5); this.dummy.updateMatrix();
      this.smokePuffs.setMatrixAt(puffs, this.dummy.matrix); this.smokeTimes.setX(puffs++, smoke.at[i]);
    }
    this.smokePuffs.count = puffs;
    if (puffs) { this.smokeTimes.clearUpdateRanges(); this.smokeTimes.addUpdateRange(0, puffs); this.smokeTimes.needsUpdate = true; this.upload(this.smokePuffs); }
    this.activeEffects = beams + sparks + flashes + blasts + debris + rockets.count * 2 + puffs;
    this.twist.settings = sim.tuning; this.twist.update();
    this.controls.update();
    if (this.terrain && Math.abs(this.camera.position.x) <= this.worldHalfWidth && Math.abs(this.camera.position.z) <= this.worldHalfDepth) {
      const minimum = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 1.25;
      if (this.camera.position.y < minimum) { this.camera.position.y = minimum; this.camera.lookAt(this.controls.target); }
    }
    this.webgl.render(this.scene, this.camera);
  }

  dispose() {
    this.corpseRenderer?.dispose();
    this.resizeObserver.disconnect(); this.twist.dispose(); this.controls.dispose();
    this.bedrockDetail.texture.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    this.scene.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.geometry) geometries.add(mesh.geometry); if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); this.shadowTexture.dispose(); this.webgl.dispose();
  }
}
