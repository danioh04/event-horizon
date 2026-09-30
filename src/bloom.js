// Physically-inspired bloom: a mip chain downsampled with a 13-tap filter and upsampled with a
// 3x3 tent, as in Jimenez, "Next Generation Post Processing in Call of Duty" (SIGGRAPH 2014).
// Round, smooth halos at every scale, unlike three's UnrealBloomPass, whose blur kernels are cut
// off at one sigma and turn isolated stars into squares.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VS } from './shaders.js';

const DOWN_FS = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter;
uniform float uThreshold;
varying vec2 vUv;

vec3 tap(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Softened Karis average: down-weight very hot 2x2 blocks so lone pixels don't flare, while
// ordinary starlight (a few units bright) still feeds the glow.
float karis(vec3 c) { return 1.0 / (1.0 + luma(c) / 6.0); }

void main() {
  vec3 a = tap(-2.0, 2.0), b = tap(0.0, 2.0), c = tap(2.0, 2.0);
  vec3 d = tap(-2.0, 0.0), e = tap(0.0, 0.0), f = tap(2.0, 0.0);
  vec3 g = tap(-2.0, -2.0), h = tap(0.0, -2.0), i = tap(2.0, -2.0);
  vec3 j = tap(-1.0, 1.0), k = tap(1.0, 1.0), l = tap(-1.0, -1.0), m = tap(1.0, -1.0);

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
  vec3 col;
  if (uPrefilter > 0.5) {
    float w0 = karis(g0) * 0.5, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.125;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    // Soft-knee threshold.
    float br = max(max(col.r, col.g), col.b);
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - uThreshold) / max(br, 1e-4);
  } else {
    col = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const UP_FS = /* glsl */`
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;

vec3 tap(float x, float y) { return texture2D(tLow, vUv + vec2(x, y) * uTexel).rgb; }

void main() {
  vec3 up = (tap(-1.0, 1.0) + tap(1.0, 1.0) + tap(-1.0, -1.0) + tap(1.0, -1.0)
          + 2.0 * (tap(0.0, 1.0) + tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, -1.0))
          + 4.0 * tap(0.0, 0.0)) / 16.0;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, up, uScatter), 1.0);
}
`;

const COMPOSITE_FS = /* glsl */`
uniform sampler2D tBase;
uniform sampler2D tBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength, 1.0);
}
`;

const material = (uniforms, fragmentShader) =>
  new THREE.ShaderMaterial({ uniforms, vertexShader: FULLSCREEN_VS, fragmentShader, depthTest: false, depthWrite: false });

export class SoftBloomPass extends Pass {
  constructor({ strength = 1, threshold = 0.6, scatter = 0.72, levels = 7 } = {}) {
    super();
    this.strength = strength;
    this.levels = levels;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.down = Array.from({ length: levels }, () => new THREE.WebGLRenderTarget(1, 1, opts));
    this.up = Array.from({ length: levels - 1 }, () => new THREE.WebGLRenderTarget(1, 1, opts));

    this.downMat = material({
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uPrefilter: { value: 0 }, uThreshold: { value: threshold },
    }, DOWN_FS);
    this.upMat = material({
      tLow: { value: null }, tHigh: { value: null },
      uTexel: { value: new THREE.Vector2() }, uScatter: { value: scatter },
    }, UP_FS);
    this.compositeMat = material({ tBase: { value: null }, tBloom: { value: null }, uStrength: { value: strength } }, COMPOSITE_FS);
    this.quad = new FullScreenQuad();
  }

  setSize(width, height) {
    let w = width, h = height;
    for (let i = 0; i < this.levels; i++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      this.down[i].setSize(w, h);
      if (i < this.levels - 1) this.up[i].setSize(w, h);
    }
  }

  draw(renderer, mat, target) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const D = this.downMat.uniforms, U = this.upMat.uniforms, C = this.compositeMat.uniforms;

    let src = readBuffer;
    for (let i = 0; i < this.levels; i++) {
      D.tSrc.value = src.texture;
      D.uTexel.value.set(1 / src.width, 1 / src.height);
      D.uPrefilter.value = i === 0 ? 1 : 0;
      this.draw(renderer, this.downMat, this.down[i]);
      src = this.down[i];
    }

    let low = this.down[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      U.tLow.value = low.texture;
      U.tHigh.value = this.down[i].texture;
      U.uTexel.value.set(1 / low.width, 1 / low.height);
      this.draw(renderer, this.upMat, this.up[i]);
      low = this.up[i];
    }

    C.tBase.value = readBuffer.texture;
    C.tBloom.value = low.texture;
    C.uStrength.value = this.strength;
    this.draw(renderer, this.compositeMat, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    [...this.down, ...this.up].forEach((t) => t.dispose());
    [this.downMat, this.upMat, this.compositeMat].forEach((m) => m.dispose());
    this.quad.dispose();
  }
}
