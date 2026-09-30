// Generative soundscape, synthesized live with the Web Audio API (no audio files).
//
//   pad       a slow D-minor drone of detuned saw and triangle voices through a lowpass filter
//   wind      band-passed noise drifting through the spectrum
//   sub       a deep sine and a low noise throb that pulses once per orbit of the disk's inner edge
//   sparkles  soft, reverberant bell tones in D minor pentatonic, like distant stars
//
// Distance to the black hole drives the mix: the filter opens, the sub and throb swell, sparkles thin
// out, and everything is pitched down by the gravitational redshift factor sqrt(1 - rs/r).
const PAD_NOTES = [73.42, 110.0, 146.83, 174.61, 220.0, 329.63]; // D2 A2 D3 F3 A3 E4
const SPARKLE_NOTES = [587.33, 698.46, 783.99, 880.0, 1046.5, 1174.66, 1396.91]; // D minor pentatonic
const ISCO_PERIOD = 8; // seconds, matches the disk animation

const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

function impulseResponse(ctx, seconds, decay) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

function noiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let brown = 0;
  for (let i = 0; i < data.length; i++) {
    // Mostly brown noise (warmer than white), with a little white on top.
    brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = brown * 3.5 + (Math.random() * 2 - 1) * 0.08;
  }
  return buffer;
}

export class SpaceAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.near = 0;
    this.detune = 0;
    this.sparkleTimer = 0;
  }

  get supported() { return !!(window.AudioContext || window.webkitAudioContext); }

  build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    const now = ctx.currentTime;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(compressor);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulseResponse(ctx, 7, 2.6);
    const wet = ctx.createGain(); wet.gain.value = 0.6;
    reverb.connect(wet).connect(this.master);
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    dry.connect(this.master);
    this.reverb = reverb;
    this.dry = dry;

    const lfo = (rate, depth, target, offset = 0) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = rate;
      const g = ctx.createGain();
      g.gain.value = depth;
      osc.connect(g).connect(target);
      osc.start(now + offset);
      return osc;
    };

    // Pad.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 520;
    this.padFilter.Q.value = 0.6;
    lfo(0.023, 180, this.padFilter.frequency);
    this.padFilter.connect(dry);
    this.padFilter.connect(reverb);
    this.oscillators = [];
    PAD_NOTES.forEach((freq, i) => {
      const voice = ctx.createGain();
      voice.gain.value = i === PAD_NOTES.length - 1 ? 0.018 : 0.04;
      lfo(0.03 + i * 0.011, voice.gain.value * 0.6, voice.gain, i * 0.7); // slow breathing
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i % 2 ? 1 : -1) * (0.15 + 0.1 * i);
      voice.connect(pan).connect(this.padFilter);
      for (const [type, cents] of [['sawtooth', -7], ['sawtooth', 7], ['triangle', 0]]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = cents;
        osc.connect(voice);
        osc.start(now);
        this.oscillators.push({ osc, base: cents });
      }
    });

    // Wind.
    const noise = noiseBuffer(ctx, 6);
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noise; windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 380;
    this.windFilter.Q.value = 0.9;
    lfo(0.017, 220, this.windFilter.frequency);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.05;
    windSrc.connect(this.windFilter).connect(this.windGain);
    this.windGain.connect(dry);
    this.windGain.connect(reverb);
    windSrc.start(now);

    // Sub and disk throb.
    const sub = ctx.createOscillator();
    sub.frequency.value = 36.71; // D1
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    sub.connect(this.subGain).connect(dry);
    sub.start(now);
    this.oscillators.push({ osc: sub, base: 0 });

    const throbSrc = ctx.createBufferSource();
    throbSrc.buffer = noise; throbSrc.loop = true; throbSrc.playbackRate.value = 0.5;
    const throbFilter = ctx.createBiquadFilter();
    throbFilter.type = 'lowpass';
    throbFilter.frequency.value = 160;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    lfo(1 / ISCO_PERIOD, 0.5, pulse.gain);
    this.throbGain = ctx.createGain();
    this.throbGain.gain.value = 0;
    throbSrc.connect(throbFilter).connect(pulse).connect(this.throbGain);
    this.throbGain.connect(dry);
    this.throbGain.connect(reverb);
    throbSrc.start(now);
  }

  sparkle() {
    const ctx = this.ctx;
    if (!this.enabled || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    const freq = SPARKLE_NOTES[Math.floor(Math.random() * SPARKLE_NOTES.length)] * (Math.random() < 0.25 ? 0.5 : 1);
    const level = (0.02 + Math.random() * 0.03) * (1 - 0.7 * this.near);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    env.connect(pan);
    pan.connect(this.reverb);
    const direct = ctx.createGain();
    direct.gain.value = 0.25;
    pan.connect(direct).connect(this.dry);

    // A bell: fundamental plus a quiet inharmonic partial.
    for (const [ratio, amp] of [[1, 1], [2.76, 0.18]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq * ratio;
      osc.detune.value = this.detune;
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g).connect(env);
      osc.start(t);
      osc.stop(t + 3.6);
    }
  }

  scheduleSparkles() {
    clearTimeout(this.sparkleTimer);
    if (!this.enabled) return;
    this.sparkle();
    // Denser among the stars, sparse near the hole.
    const wait = (900 + Math.random() * 2600) * (1 + 2 * this.near);
    this.sparkleTimer = setTimeout(() => this.scheduleSparkles(), wait);
  }

  async setEnabled(on) {
    if (!this.supported) return false;
    if (on && !this.ctx) this.build();
    if (!this.ctx) return false;
    this.enabled = on;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    if (on) {
      await this.ctx.resume();
      this.master.gain.linearRampToValueAtTime(0.85, this.ctx.currentTime + 2.5);
      this.scheduleSparkles();
    } else {
      clearTimeout(this.sparkleTimer);
      this.master.gain.linearRampToValueAtTime(0, t + 0.8);
      setTimeout(() => { if (!this.enabled) this.ctx.suspend(); }, 900);
    }
    return on;
  }

  // distanceRs: camera distance from the hole in Schwarzschild radii.
  update(distanceRs) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const near = smoothstep(400, 10, distanceRs);
    this.near = near;
    // Gravitational redshift, in cents.
    this.detune = 1200 * Math.log2(Math.sqrt(Math.max(1 - 1 / Math.max(distanceRs, 1.01), 0.05)));
    for (const { osc, base } of this.oscillators) osc.detune.setTargetAtTime(base + this.detune, t, 0.4);
    this.padFilter.frequency.setTargetAtTime(520 + 900 * near, t, 0.8);
    this.windFilter.frequency.setTargetAtTime(380 + 500 * near, t, 0.8);
    this.windGain.gain.setTargetAtTime(0.05 + 0.08 * near, t, 0.8);
    this.subGain.gain.setTargetAtTime(0.16 * near, t, 0.8);
    this.throbGain.gain.setTargetAtTime(0.22 * near * near, t, 0.8);
  }
}
