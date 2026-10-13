/**
 * The leaderboard film's soundtrack, made in the browser with the Web Audio API (no audio files): a short score in
 * A minor that resolves to C major on the winner, on a 120 bpm grid the picture is cut to, with its effects
 * (whooshes, hits, pops, ticks, a drumroll, chimes, a fanfare and confetti sparkle). Every sound is scheduled at an
 * exact time on the audio clock, so picture and sound stay together however the page's frames fall.
 */

const SOUND_KEY = "vso-leaderboard-sound";
const LEVEL = 0.8;

/** Sound is on unless this browser turned it off; the choice is a convenience, so storage failures mean on. */
export function filmSoundEnabled() {
  try { return window.localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; }
}
function rememberFilmSound(on: boolean) {
  try { window.localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* It still applies to this film. */ }
}

/** A sound at a moment of the film (seconds from its start). */
export type Cue = { at: number; play: (synth: FilmSynth, when: number) => void };

/** Two octaves of A minor pentatonic, for pops and sparkle that always sit in the key. */
export const PENTATONIC = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];
/** The chords under each scene, low to high. */
export const CHORDS = {
  am: [110, 164.81, 220, 261.63, 329.63],
  f: [87.31, 130.81, 174.61, 220, 261.63],
  g: [98, 146.83, 196, 246.94, 293.66],
  c: [130.81, 196, 261.63, 329.63, 392],
} as const;

/** A MIDI note's frequency (69 is the A above middle C, 440 Hz). */
export const noteHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/** Every voice of the film: each method plays one sound at an exact audio-clock time. Works offline too, for testing. */
export class FilmSynth {
  readonly master: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly noise: AudioBuffer;
  private readonly drive: WaveShaperNode;

  constructor(readonly context: BaseAudioContext, destination: AudioNode = context.destination) {
    this.master = context.createGain();
    this.master.gain.value = LEVEL;
    // A gentle compressor holds the hits and the chords together without clipping.
    const glue = context.createDynamicsCompressor();
    glue.threshold.value = -14; glue.knee.value = 10; glue.ratio.value = 4; glue.attack.value = 0.004; glue.release.value = 0.22;
    this.master.connect(glue).connect(destination);
    // A generated hall: decaying stereo noise as the impulse response.
    this.reverb = context.createConvolver();
    const length = Math.round(context.sampleRate * 2.4);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index++) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 3.2);
    }
    this.reverb.buffer = impulse;
    const wet = context.createGain(); wet.gain.value = 0.3;
    this.reverb.connect(wet).connect(this.master);
    this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = this.noise.getChannelData(0);
    for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
    // Soft saturation adds harmonics, so low hits still come through laptop and phone speakers.
    this.drive = context.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let index = 0; index < curve.length; index++) { const x = (index / (curve.length - 1)) * 2 - 1; curve[index] = Math.tanh(2.6 * x) / Math.tanh(2.6); }
    this.drive.curve = curve;
    this.drive.connect(this.master);
  }

  private out(node: AudioNode, { send = 0, pan = 0, drive = false }: { send?: number; pan?: number; drive?: boolean } = {}) {
    let tail = node;
    if (pan) { const panner = this.context.createStereoPanner(); panner.pan.value = Math.max(-1, Math.min(1, pan)); tail.connect(panner); tail = panner; }
    tail.connect(drive ? this.drive : this.master);
    if (send) { const amount = this.context.createGain(); amount.gain.value = send; tail.connect(amount).connect(this.reverb); }
  }
  private osc(type: OscillatorType, frequency: number, when: number, stop: number) {
    const oscillator = this.context.createOscillator();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.start(when); oscillator.stop(stop);
    return oscillator;
  }
  private hiss(when: number, stop: number) {
    const source = this.context.createBufferSource();
    source.buffer = this.noise; source.loop = true;
    source.start(when, Math.random() * 1.5); source.stop(stop);
    return source;
  }
  private filter(type: BiquadFilterType, frequency: number, q = 0.7) {
    const filter = this.context.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    return filter;
  }
  /** A gain that rises to `peak` in `attack` seconds and dies away over `decay`. */
  private hit(when: number, attack: number, peak: number, decay: number) {
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    return gain;
  }

  /** A dark swell under the cold open. */
  drone(when: number, duration: number) {
    const level = this.context.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.exponentialRampToValueAtTime(0.22, when + duration * 0.55);
    level.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    const filter = this.filter("lowpass", 180, 0.9);
    filter.frequency.setValueAtTime(160, when);
    filter.frequency.exponentialRampToValueAtTime(950, when + duration * 0.6);
    for (const [frequency, detune] of [[55, -7], [55, 7], [82.41, 0], [110, 4]] as const) {
      const voice = this.osc("sawtooth", frequency, when, when + duration + 0.05);
      voice.detune.value = detune; voice.connect(filter);
    }
    filter.connect(level); this.out(level, { send: 0.3 });
  }

  /** Rising noise and a climbing tone, pulling into a hit. */
  riser(when: number, duration: number, peak = 0.2) {
    const band = this.filter("bandpass", 350, 3.2);
    band.frequency.setValueAtTime(350, when);
    band.frequency.exponentialRampToValueAtTime(6500, when + duration);
    const level = this.context.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.exponentialRampToValueAtTime(peak, when + duration * 0.97);
    level.gain.linearRampToValueAtTime(0.0001, when + duration + 0.03);
    this.hiss(when, when + duration + 0.05).connect(band).connect(level);
    this.out(level, { send: 0.35 });
    const tone = this.osc("sine", 190, when, when + duration + 0.05);
    tone.frequency.exponentialRampToValueAtTime(760, when + duration);
    const toneLevel = this.context.createGain();
    toneLevel.gain.setValueAtTime(0.0001, when);
    toneLevel.gain.exponentialRampToValueAtTime(peak * 0.22, when + duration * 0.97);
    toneLevel.gain.linearRampToValueAtTime(0.0001, when + duration + 0.03);
    tone.connect(toneLevel); this.out(toneLevel, { send: 0.2 });
  }

  /** Air moving past, panned from one side to the other. */
  whoosh(when: number, { duration = 0.5, from = -0.5, to = 0.5, peak = 0.26, high = 2400 }: { duration?: number; from?: number; to?: number; peak?: number; high?: number } = {}) {
    const band = this.filter("bandpass", 320, 0.9);
    band.frequency.setValueAtTime(320, when);
    band.frequency.exponentialRampToValueAtTime(high, when + duration * 0.45);
    band.frequency.exponentialRampToValueAtTime(420, when + duration);
    const level = this.context.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.exponentialRampToValueAtTime(peak, when + duration * 0.42);
    level.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    const panner = this.context.createStereoPanner();
    panner.pan.setValueAtTime(from, when); panner.pan.linearRampToValueAtTime(to, when + duration);
    this.hiss(when, when + duration + 0.05).connect(band).connect(level).connect(panner);
    this.out(panner, { send: 0.15 });
  }

  /** A cinematic hit: a falling boom, a sub tail, and a crack on top. */
  impact(when: number, size = 1) {
    const body = this.osc("sine", 150, when, when + 1.2);
    body.frequency.exponentialRampToValueAtTime(40, when + 0.3);
    body.connect(this.hit(when, 0.004, 0.75 * size, 0.85 * Math.max(0.5, size))).connect(this.drive);
    const sub = this.osc("sine", 46, when, when + 1.7);
    const subLevel = this.hit(when, 0.012, 0.3 * size, 1.4);
    sub.connect(subLevel); this.out(subLevel);
    const crack = this.filter("lowpass", 3200, 0.6);
    const crackLevel = this.hit(when, 0.002, 0.42 * size, 0.22);
    this.hiss(when, when + 0.4).connect(crack).connect(crackLevel);
    this.out(crackLevel, { send: 0.35 });
  }

  /** A small bright click. */
  tick(when: number, frequency = 2200, peak = 0.06, pan = 0) {
    const level = this.hit(when, 0.002, peak, 0.05);
    this.osc("triangle", frequency, when, when + 0.08).connect(level);
    this.out(level, { send: 0.06, pan });
  }

  /** A bubbly pop, for someone appearing. */
  pop(when: number, frequency: number, pan = 0, peak = 0.12) {
    const voice = this.osc("sine", frequency * 0.75, when, when + 0.22);
    voice.frequency.exponentialRampToValueAtTime(frequency * 1.3, when + 0.06);
    const level = this.hit(when, 0.004, peak, 0.15);
    voice.connect(level); this.out(level, { send: 0.14, pan });
    const overtone = this.osc("triangle", frequency * 2, when, when + 0.1);
    const overtoneLevel = this.hit(when, 0.002, peak * 0.18, 0.05);
    overtone.connect(overtoneLevel); this.out(overtoneLevel, { pan });
  }

  kick(when: number, peak = 0.45) {
    const voice = this.osc("sine", 125, when, when + 0.4);
    voice.frequency.exponentialRampToValueAtTime(46, when + 0.13);
    voice.connect(this.hit(when, 0.003, peak, 0.3)).connect(this.drive);
  }
  hat(when: number, peak = 0.035, open = false) {
    const level = this.hit(when, 0.001, peak, open ? 0.2 : 0.045);
    this.hiss(when, when + (open ? 0.3 : 0.08)).connect(this.filter("highpass", 7200, 0.6)).connect(level);
    this.out(level, { pan: 0.22 });
  }
  snare(when: number, peak = 0.16, length = 0.14) {
    const level = this.hit(when, 0.001, peak, length);
    this.hiss(when, when + length + 0.05).connect(this.filter("bandpass", 1900, 0.7)).connect(level);
    this.out(level, { send: 0.14 });
    const body = this.osc("triangle", 190, when, when + 0.12);
    body.connect(this.hit(when, 0.001, peak * 0.45, 0.08)).connect(this.master);
  }
  /** A plucked, filtered bass note. */
  bass(when: number, frequency: number, duration = 0.42, peak = 0.13) {
    const filter = this.filter("lowpass", 900, 2);
    filter.frequency.setValueAtTime(950, when);
    filter.frequency.exponentialRampToValueAtTime(260, when + duration);
    const level = this.hit(when, 0.008, peak, duration);
    this.osc("sawtooth", frequency, when, when + duration + 0.05).connect(filter).connect(level);
    this.out(level);
  }
  /** A soft chord of detuned saws. */
  pad(when: number, duration: number, frequencies: readonly number[], peak = 0.024) {
    const filter = this.filter("lowpass", 1100, 0.4);
    const level = this.context.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.linearRampToValueAtTime(peak, when + 0.18);
    level.gain.setValueAtTime(peak, when + Math.max(0.2, duration - 0.35));
    level.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    for (const frequency of frequencies) for (const detune of [-8, 8]) {
      const voice = this.osc("sawtooth", frequency, when, when + duration + 0.05);
      voice.detune.value = detune; voice.connect(filter);
    }
    filter.connect(level); this.out(level, { send: 0.35 });
  }
  /** A struck bell: a few inharmonic partials, each ringing out at its own rate. */
  chime(when: number, frequency: number, peak = 0.09, pan = 0) {
    for (const [ratio, amount, decay] of [[1, 1, 1.8], [2.76, 0.42, 1], [5.4, 0.2, 0.55], [8.93, 0.08, 0.3]] as const) {
      const level = this.hit(when, 0.003, peak * amount, decay);
      this.osc("sine", frequency * ratio, when, when + decay + 0.05).connect(level);
      this.out(level, { send: 0.5, pan });
    }
  }
  crash(when: number, peak = 0.16) {
    const level = this.hit(when, 0.002, peak, 2.1);
    this.hiss(when, when + 2.3).connect(this.filter("highpass", 5200, 0.5)).connect(level);
    this.out(level, { send: 0.3 });
  }
  /** Glints scattered over a moment, in key, across the stereo field. */
  sparkle(when: number, duration: number, count = 14, peak = 0.04) {
    for (let index = 0; index < count; index++) {
      const at = when + Math.random() * duration;
      const frequency = PENTATONIC[5 + Math.floor(Math.random() * 5)]! * (Math.random() < 0.4 ? 2 : 1);
      const level = this.hit(at, 0.002, peak * (0.5 + Math.random() * 0.5), 0.28);
      this.osc("sine", frequency, at, at + 0.32).connect(level);
      this.out(level, { send: 0.5, pan: Math.random() * 1.6 - 0.8 });
    }
  }
  /** A drumroll that speeds up and swells into `when + duration`. */
  drumroll(when: number, duration: number) {
    for (let at = when; at < when + duration - 0.02;) {
      const progress = (at - when) / duration;
      this.snare(at, 0.05 + 0.3 * progress * progress, 0.07);
      at += 0.08 - 0.045 * progress;
    }
  }
  /** A hand clap: a few quick bursts of filtered noise, slightly apart, like several hands. */
  clap(when: number, peak = 0.14) {
    for (const [offset, share] of [[0, 0.7], [0.011, 0.85], [0.022, 1]] as const) {
      const at = when + offset;
      const level = this.hit(at, 0.001, peak * share, offset === 0.022 ? 0.16 : 0.02);
      this.hiss(at, at + 0.22).connect(this.filter("bandpass", 1300, 1.1)).connect(level);
      this.out(level, { send: 0.18, pan: -0.12 });
    }
  }
  /** A short, bright chord hit, for the cuts of a montage. */
  stab(when: number, frequencies: readonly number[], length = 0.22, peak = 0.05) {
    const filter = this.filter("lowpass", 900, 1.4);
    filter.frequency.setValueAtTime(3200, when);
    filter.frequency.exponentialRampToValueAtTime(700, when + length);
    const level = this.hit(when, 0.005, 1, length);
    for (const frequency of frequencies) for (const detune of [-7, 7]) {
      const voice = this.osc("sawtooth", frequency, when, when + length + 0.05);
      voice.detune.value = detune;
      const voiceLevel = this.context.createGain(); voiceLevel.gain.value = peak;
      voice.connect(voiceLevel).connect(filter);
    }
    filter.connect(level); this.out(level, { send: 0.25 });
  }
  /** A plucked note, for arpeggios. */
  pluck(when: number, frequency: number, peak = 0.06, pan = 0) {
    const filter = this.filter("lowpass", 2600, 2);
    filter.frequency.setValueAtTime(3400, when);
    filter.frequency.exponentialRampToValueAtTime(600, when + 0.25);
    const level = this.hit(when, 0.003, peak, 0.28);
    this.osc("square", frequency, when, when + 0.32).connect(filter).connect(level);
    this.out(level, { send: 0.3, pan });
  }

  /** The winner's chord: brassy saws through a filter that opens on the hit. */
  fanfare(when: number) {
    const filter = this.filter("lowpass", 500, 1.1);
    filter.frequency.setValueAtTime(500, when);
    filter.frequency.exponentialRampToValueAtTime(3800, when + 0.06);
    filter.frequency.exponentialRampToValueAtTime(1500, when + 0.9);
    const level = this.context.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.exponentialRampToValueAtTime(1, when + 0.02);
    level.gain.exponentialRampToValueAtTime(0.55, when + 0.4);
    level.gain.exponentialRampToValueAtTime(0.0001, when + 2);
    for (const frequency of [130.81, 261.63, 329.63, 392, 523.25]) for (const detune of [-6, 6]) {
      const voice = this.osc("sawtooth", frequency, when, when + 2.05);
      voice.detune.value = detune;
      const voiceLevel = this.context.createGain(); voiceLevel.gain.value = 0.045;
      voice.connect(voiceLevel).connect(filter);
    }
    filter.connect(level); this.out(level, { send: 0.4 });
  }
}

/**
 * Plays the film's cues live. Browsers only start sound once someone has clicked or typed on the page, so the context
 * may wait; cues are then scheduled from the moment it starts, never late. Muting keeps the schedule and silences it.
 */
export function createFilmAudio(clock: () => number) {
  let context: AudioContext | null = null;
  let synth: FilmSynth | null = null;
  let enabled = filmSoundEnabled();
  let stopped = false;
  const cues: (Cue & { done: boolean })[] = [];

  const sync = () => {
    if (!context || !synth || context.state !== "running" || stopped) return;
    const now = clock();
    const base = context.currentTime + 0.03;
    for (const cue of cues) {
      if (cue.done) continue;
      cue.done = true;
      // A moment late (the browser starting sound) still plays, at once; anything older is skipped, never played late.
      if (cue.at < now - 0.25) continue;
      try { cue.play(synth, Math.max(context.currentTime + 0.005, base + (cue.at - now))); } catch { /* Sound is optional. */ }
    }
  };
  const start = () => {
    if (stopped || !enabled) return;
    try {
      context ??= new AudioContext({ latencyHint: "interactive" });
      synth ??= new FilmSynth(context);
      if (context.state === "running") sync();
      else void context.resume().then(sync, () => undefined);
    } catch { /* Sound is optional when the browser or device disallows it. */ }
  };
  return {
    start,
    add(list: Cue[]) { for (const cue of list) cues.push({ ...cue, done: false }); sync(); },
    /** Whether sound is actually coming out (on, and the browser let it start). */
    playing: () => enabled && !stopped && context?.state === "running",
    enabled: () => enabled,
    /** A sound right now, for things only known as they happen (someone overtaking). */
    live(play: Cue["play"]) {
      if (!enabled || stopped || !context || !synth || context.state !== "running") return;
      try { play(synth, context.currentTime + 0.01); } catch { /* Sound is optional. */ }
    },
    setEnabled(on: boolean) {
      enabled = on; rememberFilmSound(on);
      if (context && synth) { const now = context.currentTime; synth.master.gain.cancelScheduledValues(now); synth.master.gain.setTargetAtTime(on ? LEVEL : 0, now, 0.03); }
      if (on) start();
    },
    stop(fade = 0.3) {
      if (stopped) return;
      stopped = true;
      const current = context;
      if (!current) return;
      try {
        if (synth) { const now = current.currentTime; synth.master.gain.cancelScheduledValues(now); synth.master.gain.setTargetAtTime(0, now, fade / 4); }
      } catch { /* Closing below stops it anyway. */ }
      window.setTimeout(() => { void current.close().catch(() => undefined); }, fade * 1000 + 120);
    },
  };
}
export type FilmAudio = ReturnType<typeof createFilmAudio>;
