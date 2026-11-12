import type { BattleSimulation } from './simulation.ts';
import { WEAPON_ID } from './config.ts';
import { TURRET_EFFECT } from './vehicle-types.ts';
import { readSetting, writeSetting } from './settings-store.ts';

export const SOUND_EFFECTS = [
  { id: 'laser', label: 'Weapon firing', volume: 30, duration: 0.18, interval: 0.045 },
  { id: 'plutonianHit', label: 'Plutonian hit', volume: 55, duration: 0.24, interval: 0.075 },
  { id: 'sectoidHit', label: 'Sectoid hit', volume: 55, duration: 0.27, interval: 0.075 },
  { id: 'plutonianDeath', label: 'Plutonian dying', volume: 70, duration: 0.65, interval: 0.12 },
  { id: 'sectoidDeath', label: 'Sectoid dying', volume: 70, duration: 0.76, interval: 0.12 },
] as const;
export type SoundId = typeof SOUND_EFFECTS[number]['id'];
const STORAGE_KEY = 'pluto-battle.sound-volumes.v1';

/** Original, reusable PCM effects. No downloads or per-shot synthesis. */
export function synthesizeEffect(id: SoundId, sampleRate: number): Float32Array {
  const duration = SOUND_EFFECTS.find(effect => effect.id === id)!.duration;
  const samples = new Float32Array(Math.ceil(duration * sampleRate));
  let phase = 0, lowNoise = 0, seed = 74319, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate, progress = t / duration;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    lowNoise += (noise - lowNoise) * 0.13;
    let frequency: number, value: number;
    if (id === 'laser') {
      frequency = 190 + 1900 * Math.exp(-t * 24);
      phase += Math.PI * 2 * frequency / sampleRate;
      value = (Math.sin(phase) * 0.75 + Math.sin(phase * 2.01) * 0.18 + noise * 0.07) * Math.exp(-t * 23);
    } else if (id === 'plutonianHit' || id === 'plutonianDeath') {
      const dying = id === 'plutonianDeath';
      frequency = dying ? 145 - progress * 75 : 150 - progress * 48;
      phase += Math.PI * 2 * frequency / sampleRate;
      // Low, rough vocal harmonics under a short armor impact.
      const voice = (Math.sin(phase) + Math.sin(phase * 2) * 0.5 + Math.sin(phase * 3) * 0.3)
        * (0.7 + 0.3 * Math.sin(t * 82)) * 0.42;
      const impact = lowNoise * Math.exp(-t * 45) * 2.5;
      value = (voice + lowNoise * 0.32 + impact) * Math.exp(-progress * (dying ? 2.7 : 4.5));
    } else {
      const dying = id === 'sectoidDeath';
      frequency = (dying ? 730 - progress * 520 : 880 - progress * 430)
        + Math.sin(t * (dying ? 100 : 140)) * (dying ? 95 : 60);
      phase += Math.PI * 2 * frequency / sampleRate;
      // Nasal, warbling alien cry with a chittering, noisy attack.
      const cry = Math.sin(phase + Math.sin(phase * 0.49) * 1.8) * 0.7 + Math.sin(phase * 1.51) * 0.2;
      value = (cry * (0.72 + 0.28 * Math.sin(t * 125)) + noise * Math.exp(-t * 35) * 0.25)
        * Math.exp(-progress * (dying ? 2.8 : 4));
    }
    const envelope = Math.min(1, t / 0.005) * Math.min(1, (duration - t) / 0.035);
    samples[i] = value * envelope; peak = Math.max(peak, Math.abs(samples[i]));
  }
  // Common headroom makes the five independent volume controls predictable.
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] *= 0.7 / peak;
  return samples;
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; id: SoundId };

export class BattleAudio {
  private context?: AudioContext;
  private output?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private channels = new Map<SoundId, GainNode>();
  private buffers = new Map<SoundId, AudioBuffer>();
  private voices = new Set<Voice>();
  private nextPlay = new Map<SoundId, number>();
  private simulation?: BattleSimulation;
  private cursor = 0;
  private unavailable = false;
  private isMuted = false;
  private disposed = false;
  private volumes = Object.fromEntries(SOUND_EFFECTS.map(effect => [effect.id, effect.volume])) as Record<SoundId, number>;
  private played = Object.fromEntries(SOUND_EFFECTS.map(effect => [effect.id, 0])) as Record<SoundId, number>;
  private onStateChange: () => void;

  constructor(onStateChange: () => void = () => {}) {
    this.onStateChange = onStateChange;
    try {
      const saved = JSON.parse(readSetting(STORAGE_KEY) ?? 'null');
      for (const { id } of SOUND_EFFECTS) {
        if (typeof saved?.[id] === 'number' && Number.isFinite(saved[id])) this.volumes[id] = Math.round(Math.max(0, Math.min(100, saved[id])));
      }
    } catch { /* Storage may be disabled; the mixer still works for this visit. */ }
  }

  get state() { return this.unavailable ? 'unavailable' : this.context?.state ?? 'locked'; }
  get muted() { return this.isMuted; }
  setMuted(muted: boolean) {
    if (this.isMuted === muted) return;
    this.isMuted = muted;
    if (muted) this.stop();
    this.onStateChange();
  }
  getVolume(id: SoundId) { return this.volumes[id]; }
  setVolume(id: SoundId, volume: number) {
    if (!Number.isFinite(volume)) return;
    this.volumes[id] = Math.round(Math.max(0, Math.min(100, volume)));
    const channel = this.channels.get(id);
    if (channel && this.context) channel.gain.setTargetAtTime(this.volumes[id] / 100, this.context.currentTime, 0.008);
    try { writeSetting(STORAGE_KEY, JSON.stringify(this.volumes)); } catch { /* Session-only settings. */ }
  }

  /** Called inside a pointer/key gesture, including the first touch on mobile. */
  async unlock() {
    if (this.disposed || this.unavailable || this.isMuted) return false;
    try {
      if (!this.context) {
        const context = this.context = new AudioContext({ latencyHint: 'interactive' });
        const compressor = this.compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -16; compressor.knee.value = 15; compressor.ratio.value = 5;
        compressor.attack.value = 0.003; compressor.release.value = 0.15;
        const output = this.output = context.createGain(); output.gain.value = 0.7;
        compressor.connect(output); output.connect(context.destination);
        for (const { id } of SOUND_EFFECTS) {
          const samples = synthesizeEffect(id, context.sampleRate);
          const buffer = context.createBuffer(1, samples.length, context.sampleRate);
          buffer.getChannelData(0).set(samples); this.buffers.set(id, buffer);
          const channel = context.createGain(); channel.gain.value = this.volumes[id] / 100;
          channel.connect(compressor); this.channels.set(id, channel);
        }
        context.onstatechange = () => this.onStateChange();
      }
      if (this.context.state !== 'running') await this.context.resume();
      this.onStateChange(); return this.context.state === 'running';
    } catch {
      this.unavailable = true; this.onStateChange(); return false;
    }
  }

  async preview(id: SoundId) {
    if (await this.unlock()) this.play(id, 0, true);
  }

  reset(sim: BattleSimulation) {
    this.stop(); this.simulation = sim; this.cursor = sim.events.cursor;
  }

  /** Consume once per rendered frame; old or paused events are never replayed. */
  update(sim: BattleSimulation, enabled = true) {
    if (this.simulation !== sim) { this.reset(sim); return; }
    const events = sim.events, end = events.cursor;
    const start = Math.max(this.cursor, end - events.capacity); this.cursor = end;
    if (!enabled || this.isMuted || this.context?.state !== 'running') return;
    // Reserve the mix for death cries before filling it with impacts and rifles.
    for (const kind of ['death', 'hit', 'shot'] as const) for (let n = start; n < end; n++) {
      const i = n % events.capacity;
      if (events.kind[i] !== kind || sim.time - events.at[i] > 0.15) continue;
      const id: SoundId = kind === 'shot' ? 'laser'
        : events.team[i] === 0 ? kind === 'death' ? 'plutonianDeath' : 'plutonianHit'
          : kind === 'death' ? 'sectoidDeath' : 'sectoidHit';
      const rate = kind !== 'shot' ? 1 : events.weapon[i] === WEAPON_ID.sniper ? 0.65 : events.weapon[i] === WEAPON_ID.shotgun ? 0.42 : events.weapon[i] === WEAPON_ID.rocket ? 0.3 : events.weapon[i] === TURRET_EFFECT ? 0.76 : 1;
      this.play(id, Math.max(-0.75, Math.min(0.75, events.x[i] / sim.grid.halfWidth)), false, rate);
    }
  }

  private play(id: SoundId, position: number, preview = false, rate = 1) {
    const context = this.context;
    if (this.disposed || this.isMuted || document.hidden || !context || context.state !== 'running' || this.volumes[id] === 0) return;
    const now = context.currentTime;
    if (!preview && now < (this.nextPlay.get(id) ?? 0)) return;
    // Keep both mobile CPU cost and a 1,000-soldier battle's mix bounded.
    if (this.voices.size >= 24) return;
    const source = context.createBufferSource(), gain = context.createGain(), pan = context.createStereoPanner();
    source.buffer = this.buffers.get(id)!;
    source.playbackRate.value = preview ? 1 : rate * (0.94 + Math.random() * 0.12);
    gain.gain.value = 0.48; pan.pan.value = position;
    source.connect(gain); gain.connect(pan); pan.connect(this.channels.get(id)!);
    const voice: Voice = { source, gain, pan, id }; this.voices.add(voice);
    source.onended = () => { source.disconnect(); gain.disconnect(); pan.disconnect(); this.voices.delete(voice); };
    source.start(); this.played[id]++;
    this.nextPlay.set(id, now + SOUND_EFFECTS.find(effect => effect.id === id)!.interval);
  }

  stop() {
    for (const voice of this.voices) { voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect(); }
    this.voices.clear(); this.nextPlay.clear();
  }

  snapshot() { return { state: this.state, activeVoices: this.voices.size, played: { ...this.played }, volumes: { ...this.volumes } }; }

  dispose() {
    this.disposed = true; this.stop();
    for (const channel of this.channels.values()) channel.disconnect();
    this.compressor?.disconnect(); this.output?.disconnect();
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); }
  }
}
