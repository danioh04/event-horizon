import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildGalaxy } from './galaxy.js';
import { SoftBloomPass } from './bloom.js';
import { SpaceAudio } from './audio.js';
import { POINT_VS, POINT_FS, LENS_FS, FINISH_FS, FULLSCREEN_VS } from './shaders.js';

const $ = (id) => document.getElementById(id);
const deg = THREE.MathUtils.degToRad;
const RS = 0.02;               // drawn Schwarzschild radius in kpc (real Sgr A*: ~4.1e-10 kpc)
const KMS_KPC = 1.0227e-3;     // 1 km/s/kpc in rad/Myr
const V_FLAT = 220, R_CORE = 1.1; // rotation curve: v(r) = V_FLAT * (1 - exp(-r / R_CORE)) km/s
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const P = {
  seed: 7, arms: 3, pitch: 16,
  rate: reduceMotion ? 0.5 : 1,
  bend: 1, disk: 1, bloom: 1.2,
  dust: true, drift: !reduceMotion,
};

const HOME = { r: 26, polar: deg(70), az: deg(35) }; // 20° above the disk
const DIVE = { r: 0.7, polar: deg(84) };
// Back the camera off on portrait screens so the whole disk fits across.
const homeR = () => HOME.r * Math.max(1, 1.1 / camera.aspect);

function fail(msg) {
  $('fallbackMsg').textContent = msg;
  $('fallback').hidden = false;
}

// ---------- renderer ----------
const canvas = $('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  fail('WebGL is turned off or unsupported in this browser, so the galaxy cannot be drawn.');
  throw e;
}
renderer.setClearColor(0x000000, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const gl = renderer.getContext();
const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
const MAX_POINT_SIZE = Math.min(pointRange ? pointRange[1] : 64, 380);

// Pixel ratio is capped for the ray-traced pass, and lowered or raised to hold a smooth frame rate.
const PR_MIN = 0.75, PR_STEP = 0.25;
const maxPixelRatio = () => Math.min(window.devicePixelRatio || 1, 1.5);
let pr = maxPixelRatio();
renderer.setPixelRatio(pr);
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.002, 5000);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 0.1;
controls.maxDistance = 70;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.9;

// ---------- camera drift ----------
// A slow, wandering fly-around. It circles the galaxy in the same direction the stars travel (so it
// reads as the camera moving, not the galaxy spinning faster), and its pace, height and distance
// wander smoothly and unpredictably. It runs only while time runs, and yields to the user while
// they drag or zoom; offsets are applied as changes, so it always continues from where they left it.
const DRIFT_SPEED = 0.02;   // rad/s around the axis on average, about 5 minutes per lap

// Smooth, non-repeating wander in [-1, 1]: a few sines at unrelated frequencies (Hz) with phases
// rolled fresh on every visit.
function wander(freqs) {
  const phases = freqs.map(() => Math.random() * 2 * Math.PI);
  return (t) => freqs.reduce((sum, f, i) => sum + Math.sin(2 * Math.PI * f * t + phases[i]), 0) / freqs.length;
}
const pace = wander([0.011, 0.023, 0.041]);   // speeds up and slows down
const height = wander([0.009, 0.017, 0.029]); // rises and dips
const reach = wander([0.007, 0.019]);         // eases in and out a little

const driftSph = new THREE.Spherical();
let driftTime = 0, userControlling = false;
controls.addEventListener('start', () => { userControlling = true; });
controls.addEventListener('end', () => { userControlling = false; });
function drift(dt) {
  if (!P.drift || P.rate <= 0 || userControlling) return;
  const t0 = driftTime;
  driftTime += dt;
  driftSph.setFromVector3(camera.position);
  driftSph.theta += DRIFT_SPEED * Math.max(0.2, 1 + pace(driftTime)) * dt;                  // 0.2x to 2x pace
  driftSph.phi = THREE.MathUtils.clamp(driftSph.phi + 0.2 * (height(driftTime) - height(t0)), 0.08, Math.PI - 0.08); // up to about ±11°
  driftSph.radius *= Math.exp(0.1 * (reach(driftTime) - reach(t0)));                    // up to about ±10%
  camera.position.setFromSpherical(driftSph);
}

// ---------- galaxy ----------
const shared = {
  uTime: { value: 0 },
  uOmegaP: { value: 25 * KMS_KPC },  // spiral pattern speed, 25 km/s/kpc
  uV0: { value: V_FLAT },
  uRc: { value: R_CORE },
  uViewportH: { value: 1000 },
  uRef: { value: 20 },
  uExposure: { value: 0.46 },
  uMaxPS: { value: MAX_POINT_SIZE },
};

function pointMaterial(kind, blending) {
  return new THREE.ShaderMaterial({
    defines: { [kind]: '' },
    uniforms: shared,
    vertexShader: POINT_VS,
    fragmentShader: POINT_FS,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    ...blending,
  });
}
const ADD = { blending: THREE.AdditiveBlending };
// Extinction: destination * (1 - source colour).
const ABSORB = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor };
// Draw order matters without depth testing: light first, then dust dims what's behind it.
const LAYERS = [
  ['stars', pointMaterial('STARS', ADD)],
  ['clouds', pointMaterial('CLOUDS', ADD)],
  ['dust', pointMaterial('DUST', ABSORB)],
];
const points = {};
LAYERS.forEach(([name, material], i) => {
  const p = new THREE.Points(new THREE.BufferGeometry(), material);
  p.frustumCulled = false;
  p.renderOrder = i;
  scene.add(p);
  points[name] = p;
});

function rebuild() {
  const g = buildGalaxy(P);
  for (const [name] of LAYERS) {
    points[name].geometry.dispose();
    points[name].geometry = g[name];
  }
  points.dust.visible = P.dust;
}
rebuild();

// The sky as seen from the black hole, for strongly bent rays that leave the screen.
const CUBE_SIZE = 256;
const cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(0.002, 5000, cubeRT);

// ---------- post-processing ----------
const composer = new EffectComposer(renderer);
composer.setPixelRatio(pr);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));

const lensPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tCube: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uRs: { value: RS },
    uTime: { value: 0 },
    uBend: { value: P.bend },
    uDisk: { value: P.disk },
    uLs: { value: 2.5 },
  },
  vertexShader: FULLSCREEN_VS,
  fragmentShader: LENS_FS,
});
const LU = lensPass.uniforms;
LU.tCube.value = cubeRT.texture; // ShaderPass clones uniforms, which drops render-target textures
composer.addPass(lensPass);

const bloom = new SoftBloomPass({ strength: P.bloom, threshold: 0.3, scatter: 0.75 });
composer.addPass(bloom);

const finishPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAspect: { value: innerWidth / innerHeight } },
  vertexShader: FULLSCREEN_VS,
  fragmentShader: FINISH_FS,
});
composer.addPass(finishPass);
composer.addPass(new OutputPass());

const bufSize = new THREE.Vector2();
function syncViewport() {
  renderer.getDrawingBufferSize(bufSize);
  shared.uViewportH.value = bufSize.y;
}
function resize() {
  const cap = maxPixelRatio();
  if (pr > cap) setPixelRatio(cap);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  finishPass.uniforms.uAspect.value = camera.aspect;
  syncViewport();
}
function setPixelRatio(value) {
  pr = value;
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
}
addEventListener('resize', resize);
resize();

// ---------- camera flights ----------
let flight = null;
const sph = new THREE.Spherical();
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

// Leftover drag/zoom momentum would carry on after a flight and pull the camera off its target.
// OrbitControls keeps it in private fields (three r169); clear them if present.
function stopMomentum() {
  controls._sphericalDelta?.set(0, 0, 0);
  controls._panOffset?.set(0, 0, 0);
  if ('_scale' in controls) controls._scale = 1;
}

// Radius is interpolated in log space so a 26 kpc -> 14 pc dive feels even all the way down.
// Flights sweep against the galaxy's rotation (negative azOffset): sweeping with it, the galaxy's own
// spin shows first while the flight eases in, then reverses on screen as the camera overtakes it.
function flyTo(r, polar, azOffset, dur) {
  stopMomentum();
  sph.setFromVector3(camera.position);
  flight = {
    t: 0, dur: reduceMotion ? 0.01 : dur,
    r0: Math.log(sph.radius), r1: Math.log(r),
    p0: sph.phi, p1: polar,
    a0: sph.theta, a1: sph.theta + azOffset,
  };
  controls.enabled = false;
}
function endFlight() {
  flight = null;
  stopMomentum();
  controls.enabled = true;
  controls.update();
}
function stepFlight(dt) {
  flight.t = Math.min(flight.t + dt / flight.dur, 1);
  const e = ease(flight.t);
  const L = THREE.MathUtils.lerp;
  camera.position.setFromSphericalCoords(Math.exp(L(flight.r0, flight.r1, e)), L(flight.p0, flight.p1, e), L(flight.a0, flight.a1, e));
  camera.lookAt(0, 0, 0);
  if (flight.t >= 1) endFlight();
}
// Grabbing the view hands control back immediately. Capture phase runs before OrbitControls' listeners.
for (const type of ['pointerdown', 'wheel']) {
  canvas.addEventListener(type, () => { if (flight) endFlight(); }, { capture: true, passive: true });
}

const diveBtn = $('dive');
const isNear = () => camera.position.length() < 4;
diveBtn.addEventListener('click', () => {
  if (isNear()) flyTo(homeR(), HOME.polar, -0.6, 5);
  else flyTo(DIVE.r, DIVE.polar, -1.0, 6.5);
});
// Reset returns to the absolute default view (the one the opening glide lands on), by the shortest turn.
function turnToHome() {
  sph.setFromVector3(camera.position);
  const d = HOME.az - sph.theta;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
$('reset').addEventListener('click', () => flyTo(homeR(), HOME.polar, turnToHome(), 3));

// Opening shot: #horizon links straight to the black hole; otherwise glide in from a wide, low angle.
if (location.hash === '#horizon') {
  camera.position.setFromSphericalCoords(DIVE.r, DIVE.polar, HOME.az);
} else if (reduceMotion) {
  camera.position.setFromSphericalCoords(homeR(), HOME.polar, HOME.az);
} else {
  camera.position.setFromSphericalCoords(homeR() * 1.45, deg(77), HOME.az + 0.9);
  flyTo(homeR(), HOME.polar, -0.9, 5.5); // lands exactly on HOME
}
camera.lookAt(0, 0, 0);

// ---------- controls panel ----------
function bindRange(id, format, apply) {
  const el = $(id), out = $(id + 'Out');
  const update = () => {
    const v = parseFloat(el.value);
    out.textContent = format(v);
    el.style.setProperty('--fill', ((v - +el.min) / (+el.max - +el.min)) * 100 + '%');
    apply(v);
  };
  el.addEventListener('input', update);
  update();
}
let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => { rebuildQueued = false; rebuild(); });
}

$('rate').value = P.rate;
$('drift').checked = P.drift;
bindRange('rate', (v) => (v === 0 ? 'Paused' : `${v} Myr/s`), (v) => { P.rate = v; });
bindRange('pitch', (v) => `${v}°`, (v) => { if (v !== P.pitch) { P.pitch = v; queueRebuild(); } });
bindRange('bend', (v) => (v === 100 ? '100% · GR' : `${v}%`), (v) => { P.bend = v / 100; LU.uBend.value = P.bend; });
bindRange('disk', (v) => `${v}%`, (v) => { P.disk = v / 100; LU.uDisk.value = P.disk; });
bindRange('bloom', (v) => v.toFixed(2), (v) => { P.bloom = v; bloom.strength = v; });
document.querySelectorAll('input[name="arms"]').forEach((el) => {
  el.addEventListener('change', () => { P.arms = +el.value; queueRebuild(); });
});
$('dust').addEventListener('change', (e) => { P.dust = e.target.checked; points.dust.visible = P.dust; });
$('drift').addEventListener('change', (e) => { P.drift = e.target.checked; });
// New galaxy rolls every setting except the time rate (and camera drift, which is about the camera).
// Ranges stay inside what looks good; the controls follow.
$('reseed').addEventListener('click', () => {
  const pick = (min, max, step) => min + Math.round((Math.random() * (max - min)) / step) * step;
  const setRange = (id, value) => { const el = $(id); el.value = value; el.dispatchEvent(new Event('input')); };
  P.seed = 1 + Math.floor(Math.random() * 99999);
  P.arms = 2 + Math.floor(Math.random() * 3);
  P.pitch = pick(13, 28, 1);
  $('arms' + P.arms).checked = true;
  setRange('pitch', P.pitch); // refreshes the readout; no rebuild since P.pitch already matches
  setRange('bend', pick(70, 140, 5));
  setRange('disk', pick(60, 180, 5));
  setRange('bloom', pick(0.7, 2, 0.05).toFixed(2));
  const dust = $('dust');
  dust.checked = Math.random() < 0.8;
  dust.dispatchEvent(new Event('change'));
  rebuild();
});

const panel = $('panel'), toggle = $('panelToggle');
function setPanel(open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
}
setPanel(false);
toggle.addEventListener('click', () => setPanel(panel.hidden));

function updateDiveLabel() {
  const near = isNear();
  const label = near ? 'Pull back' : 'Dive in';
  if (diveBtn.textContent !== label) {
    diveBtn.textContent = label;
    diveBtn.setAttribute('aria-pressed', String(near));
  }
}

// ---------- immersive mode ----------
// Hides every overlay (and goes full screen where allowed). H, Esc, or a double-click/tap brings it back.
const toast = $('toast');
const touchFirst = matchMedia('(pointer: coarse)').matches;
if (touchFirst) $('hint').textContent = 'Drag to orbit · Pinch to zoom';
let immersive = false, toastTimer = 0;

function showToast(message, ms = 2800) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}
function setImmersive(on) {
  if (on === immersive) return;
  immersive = on;
  document.body.classList.toggle('immersive', on);
  if (on) {
    document.activeElement?.blur();
    showToast(touchFirst ? 'Double-tap to bring the controls back' : 'Press H or double-click to bring the controls back');
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    toast.classList.remove('show');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
}
$('immersive').addEventListener('click', () => setImmersive(true));

// Space pauses and resumes, remembering the rate.
let resumeRate = P.rate || 1;
function togglePause() {
  const rate = $('rate');
  if (P.rate > 0) { resumeRate = P.rate; rate.value = 0; } else rate.value = resumeRate;
  rate.dispatchEvent(new Event('input'));
  showToast(P.rate > 0 ? 'Resumed' : 'Paused · Space to resume', 1400);
}

// ---------- sound ----------
const audio = new SpaceAudio();
const soundBtn = $('sound');
if (!audio.supported) soundBtn.hidden = true;
async function toggleSound() {
  const on = await audio.setEnabled(!audio.enabled);
  soundBtn.setAttribute('aria-pressed', String(on));
  if (on) audio.update(camera.position.length() / RS);
}
soundBtn.addEventListener('click', toggleSound);

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'h' || e.key === 'H') setImmersive(!immersive);
  else if (e.key === 'm' || e.key === 'M') toggleSound();
  else if (e.key === ' ' && !e.target.closest('button, input, label')) { e.preventDefault(); togglePause(); }
  else if (e.key === 'Escape') setImmersive(false);
});
// Leaving full screen (the browser handles Esc there) also leaves immersive mode.
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setImmersive(false); });

// Double-click or double-tap without dragging. Works for touch, where dblclick is unreliable.
let downX = 0, downY = 0, downT = 0, lastTap = 0, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); });
canvas.addEventListener('pointerup', (e) => {
  if (!immersive) return;
  const now = performance.now();
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10 || now - downT > 300) { lastTap = 0; return; }
  if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 40) { lastTap = 0; setImmersive(false); }
  else { lastTap = now; lastX = e.clientX; lastY = e.clientY; }
});

// ---------- frame loop ----------
const clock = new THREE.Clock();
let simTime = 0, diskTime = 0, frame = 0;
let fpsAcc = 0, fpsCount = 0, fps = 60, slowSeconds = 0, fastSeconds = 0, hudAcc = 1;

function adaptResolution() {
  if (fps < 32) { slowSeconds++; fastSeconds = 0; }
  else if (fps > 57) { fastSeconds++; slowSeconds = 0; }
  else { slowSeconds = 0; fastSeconds = 0; }
  if (slowSeconds >= 2 && pr > PR_MIN) { setPixelRatio(Math.max(PR_MIN, pr - PR_STEP)); resize(); slowSeconds = 0; }
  if (fastSeconds >= 4 && pr < maxPixelRatio()) { setPixelRatio(Math.min(maxPixelRatio(), pr + PR_STEP)); resize(); fastSeconds = 0; }
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  simTime += dt * P.rate;
  if (P.rate > 0) diskTime += dt;
  shared.uTime.value = simTime;

  if (flight) stepFlight(dt); else { drift(dt); controls.update(dt); }
  camera.updateMatrixWorld();
  shared.uRef.value = THREE.MathUtils.clamp(camera.position.length(), 8, 40);

  if (frame % 4 === 0) {
    shared.uViewportH.value = CUBE_SIZE;
    cubeCam.update(renderer, scene);
    syncViewport();
  }

  LU.uInvProj.value.copy(camera.projectionMatrixInverse);
  LU.uCamWorld.value.copy(camera.matrixWorld);
  LU.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  LU.uCamPos.value.copy(camera.position);
  LU.uTime.value = diskTime;

  composer.render(dt);

  if (frame === 0) {
    if (renderer.info.programs.some((p) => p.diagnostics && !p.diagnostics.runnable)) {
      fail('A shader failed to compile on this graphics card. Try a current version of Chrome, Edge, Firefox or Safari.');
    }
    document.body.classList.add('ready'); // starts the HUD entrance now that the galaxy is on screen
  }
  frame++;

  fpsAcc += dt; fpsCount++;
  if (fpsAcc >= 1) {
    fps = fpsCount / fpsAcc; fpsAcc = 0; fpsCount = 0;
    adaptResolution();
  }
  hudAcc += dt;
  if (hudAcc > 0.1) { hudAcc = 0; updateDiveLabel(); audio.update(camera.position.length() / RS); }
}

// Mark as started now: background tabs don't run animation frames until they're shown.
window.__ehRunning = true;
renderer.setAnimationLoop(tick);
