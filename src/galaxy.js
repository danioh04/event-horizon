// Procedural barred spiral galaxy. Everything is generated once on the CPU from a seeded RNG;
// motion happens in the vertex shader (see POINT_VS in shaders.js).
//
// Units: kpc. Each particle stores (r, theta0, y, mode) in aOrbit, where mode is
//   0  disk star or disk glow: differential rotation on a flat rotation curve
//   1  bulge star or bulge glow: same curve, slower
//   2  locked to the spiral pattern (arms, bar, nebulae, dust)
//   3  fixed star on the far sky sphere (uses `position` directly)
import * as THREE from 'three';

const TAU = Math.PI * 2;
const ARM_START = 1.7; // arms leave from the ends of the bar

export const COUNTS = {
  disk: 78000, bulge: 20000, bar: 9000, arm: 42000, sky: 16000,
  nebula: 2800, diskGlow: 1800, bulgeGlow: 420, nucleus: 90, farGalaxies: 90,
  dust: 14000, clusters: 700,
};

export function blackbody(T) {
  const t = Math.min(Math.max(T, 1000), 40000) / 100;
  const r = t <= 66 ? 1 : 1.29293618 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 0.39008157876 * Math.log(t) - 0.63184144378 : 1.12989086 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : 0.54320678911 * Math.log(t - 10) - 1.19625408914;
  const lin = (x) => Math.pow(Math.min(Math.max(x, 0), 1), 2.2);
  return [lin(r), lin(g), lin(b)];
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ParticleBuffer {
  constructor(n) {
    this.i = 0;
    this.pos = new Float32Array(n * 3);
    this.orb = new Float32Array(n * 4);
    this.col = new Float32Array(n * 3);
    this.prop = new Float32Array(n * 2);
  }

  // p0/p1: stars use (luminosity, unused); sprites use (world size, intensity or opacity).
  add(r, th, y, mode, c, p0, p1, sky) {
    const i = this.i++;
    if (sky) this.pos.set(sky, i * 3);
    else { this.pos[i * 3] = r * Math.cos(th); this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = r * Math.sin(th); }
    this.orb[i * 4] = r; this.orb[i * 4 + 1] = th; this.orb[i * 4 + 2] = y; this.orb[i * 4 + 3] = mode;
    this.col.set(c, i * 3);
    this.prop[i * 2] = p0; this.prop[i * 2 + 1] = p1;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aOrbit', new THREE.BufferAttribute(this.orb, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aProp', new THREE.BufferAttribute(this.prop, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    return g;
  }
}

export function buildGalaxy({ seed, arms, pitch }) {
  const rnd = mulberry32(Math.imul(seed, 2654435761) >>> 0);
  const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rnd()); };
  const tanP = Math.tan(pitch * Math.PI / 180);
  const armTheta = (r, k) => k * TAU / arms + Math.log(r / ARM_START) / tanP;
  const armR = () => { let r; do { r = ARM_START * 0.92 - 5.5 * Math.log(1 - rnd() * 0.9); } while (r > 14.5); return r; };
  const expDisk = (h, min) => { let r; do { r = -h * Math.log(1 - rnd() * 0.988); } while (r < min); return r; };
  const bulgeRadius = (a, min, max) => { let r; do { const s = Math.sqrt(rnd()); r = a * s / (1 - s); } while (r < min || r > max); return r; };
  const onSphere = (R) => {
    const ct = rnd() * 2 - 1, sn = Math.sqrt(1 - ct * ct), ph = rnd() * TAU;
    return [R * sn * Math.cos(ph), R * ct, R * sn * Math.sin(ph)];
  };

  const C = COUNTS;

  // Young stars form in clumps: OB associations strung along the arms, lit by their own H II regions.
  const clusters = [];
  for (let k = 0; k < C.clusters; k++) {
    const r = armR(), a = Math.floor(rnd() * arms);
    clusters.push({ r, th: armTheta(r, a) + gauss() * (0.22 + 0.03 * r) / r, s: 0.06 + Math.pow(rnd(), 2) * 0.22 });
  }
  const inCluster = () => {
    const c = clusters[Math.floor(rnd() * clusters.length)];
    return [Math.max(0.8, c.r + gauss() * c.s), c.th + gauss() * c.s / c.r, c.s];
  };
  const stars = new ParticleBuffer(C.disk + C.bulge + C.bar + C.arm + C.sky);
  const clouds = new ParticleBuffer(C.nebula + C.diskGlow + C.bulgeGlow + C.nucleus + C.farGalaxies);
  const dust = new ParticleBuffer(C.dust);

  // Old thin disk: exponential profile, smooth in azimuth, flows through the arms.
  for (let k = 0; k < C.disk; k++) {
    const r = expDisk(3.3, 0.75);
    const T = rnd() < 0.06 ? 7000 + rnd() * 5000 : 3000 + Math.pow(rnd(), 1.5) * 3600;
    stars.add(r, rnd() * TAU, gauss() * (0.07 + 0.012 * r), 0, blackbody(T), 0.16 + Math.pow(rnd(), 7) * 2.6, 0);
  }
  // Bulge: flattened Hernquist-like cloud of old stars, hollowed out around the hole.
  for (let k = 0; k < C.bulge; k++) {
    const [x, y, z] = onSphere(bulgeRadius(0.8, 0.6, 4.2));
    stars.add(Math.hypot(x, z), Math.atan2(z, x), y * 0.6, 1, blackbody(2900 + rnd() * 1900), 0.07 + Math.pow(rnd(), 8) * 1.4, 0);
  }
  // Bar: rotates rigidly with the spiral pattern.
  for (let k = 0; k < C.bar; k++) {
    let x, y, z; do { x = gauss() * 1.15; z = gauss() * 0.36; y = gauss() * 0.2; } while (x * x + y * y + z * z < 0.36);
    stars.add(Math.hypot(x, z), Math.atan2(z, x), y, 2, blackbody(3300 + rnd() * 2200), 0.09 + Math.pow(rnd(), 8) * 1.6, 0);
  }
  // Arm stars: logarithmic spirals, half in clusters and half spread across the arm.
  // Mostly hot and blue, with some red supergiants.
  for (let k = 0; k < C.arm; k++) {
    let r, th;
    if (rnd() < 0.5) [r, th] = inCluster();
    else {
      const r0 = armR(), w = 0.34 + 0.045 * r0;
      th = armTheta(r0, Math.floor(rnd() * arms)) + gauss() * w / r0;
      r = Math.max(0.8, r0 + gauss() * 0.16);
    }
    const old = rnd() < 0.22;
    const T = old ? 3300 + rnd() * 1500 : 6500 + Math.pow(rnd(), 2.2) * 24000;
    const lum = old ? 0.25 + Math.pow(rnd(), 4) * 1.2 : 0.3 + Math.pow(rnd(), 5) * 5.0;
    stars.add(r, th, gauss() * (0.1 + 0.005 * r), 2, blackbody(T), lum, 0);
  }
  // Foreground and background stars on a far sphere.
  for (let k = 0; k < C.sky; k++) {
    stars.add(0, 0, 0, 3, blackbody(2800 + Math.pow(rnd(), 1.3) * 9000), 0.09 + Math.pow(rnd(), 7) * 2.6, 0, onSphere(900));
  }

  // Nebulae: H-alpha pink around the clusters, reflection blue, and broad glow along each arm.
  for (let k = 0; k < C.nebula; k++) {
    const t = rnd();
    let r, th, c, size, I;
    if (t < 0.8) [r, th] = inCluster();
    else {
      const r0 = armR(), w = 0.3 + 0.03 * r0;
      th = armTheta(r0, Math.floor(rnd() * arms)) + gauss() * w / r0;
      r = r0 + gauss() * 0.1;
    }
    if (t < 0.62) { c = [1.0, 0.3, 0.44]; size = 0.1 + Math.pow(rnd(), 2) * 0.36; I = 0.04 + rnd() * 0.07; }
    else if (t < 0.8) { c = [0.32, 0.52, 1.0]; size = 0.16 + rnd() * 0.3; I = 0.03 + rnd() * 0.05; }
    else { c = [0.66, 0.76, 1.0]; size = 0.8 + rnd() * 1.2; I = 0.012 + rnd() * 0.014; }
    clouds.add(r, th, gauss() * 0.07, 2, c, size, I);
  }
  // Unresolved starlight: large faint sprites that fill the disk and bulge with a smooth glow.
  const diskLight = [1.0, 0.84, 0.68], bulgeLight = [1.0, 0.76, 0.52];
  for (let k = 0; k < C.diskGlow; k++) {
    const r = expDisk(3.0, 0.9);
    clouds.add(r, rnd() * TAU, gauss() * 0.08, 0, diskLight, 1.0 + rnd() * 1.4, 0.006 + rnd() * 0.005);
  }
  for (let k = 0; k < C.bulgeGlow; k++) {
    const [x, y, z] = onSphere(bulgeRadius(0.7, 0.55, 2.4));
    clouds.add(Math.hypot(x, z), Math.atan2(z, x), y * 0.55, 1, bulgeLight, 0.6 + rnd() * 0.7, 0.005 + rnd() * 0.005);
  }

  // Nuclear glow: fills the bulge's hollow core so the nucleus reads bright from afar. These sprites
  // fade out as the camera closes in (see the near-fade in POINT_VS), leaving the hole's surroundings clear.
  for (let k = 0; k < C.nucleus; k++) {
    const [x, y, z] = onSphere(0.12 + Math.pow(rnd(), 0.7) * 0.5);
    clouds.add(Math.hypot(x, z), Math.atan2(z, x), y * 0.6, 1, [1.0, 0.8, 0.58], 0.3 + rnd() * 0.35, 0.02 + rnd() * 0.02);
  }

  // Faint smudges of other galaxies far beyond the star field.
  for (let k = 0; k < C.farGalaxies; k++) {
    const c = rnd() < 0.6 ? [1.0, 0.86, 0.7] : [0.72, 0.82, 1.0];
    clouds.add(0, 0, 0, 3, c, 3 + Math.pow(rnd(), 3) * 12, 0.07 + rnd() * 0.1, onSphere(950));
  }

  // Dust on the inner (concave) edge of each arm, plus a patchy ring around the bar.
  // The colour is an extinction coefficient: blue light is absorbed more than red.
  const extinction = [0.72, 0.84, 1.0];
  const ringClumps = Array.from({ length: 40 }, () => ({ r: 1.5 + gauss() * 0.25, th: rnd() * TAU }));
  for (let k = 0; k < C.dust; k++) {
    let r, th;
    if (rnd() < 0.06) {
      const c = ringClumps[Math.floor(rnd() * ringClumps.length)];
      r = c.r + gauss() * 0.12; th = c.th + gauss() * 0.18;
    } else {
      const r0 = armR(), a = Math.floor(rnd() * arms);
      th = armTheta(r0, a) + gauss() * (0.14 + 0.018 * r0) / r0;
      r = r0 - (0.3 + 0.035 * r0) + gauss() * 0.08;
    }
    dust.add(Math.max(r, 0.9), th, gauss() * 0.03, 2, extinction, 0.16 + rnd() * 0.34, rnd() < 0.15 ? 0.14 + rnd() * 0.12 : 0.03 + rnd() * 0.05);
  }

  return {
    stars: stars.toGeometry(),
    clouds: clouds.toGeometry(),
    dust: dust.toGeometry(),
    total: stars.i + clouds.i + dust.i,
  };
}
