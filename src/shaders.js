// GLSL for the star, cloud and dust point sprites, the black-hole lensing pass, and the final grade.

export const POINT_VS = /* glsl */`
uniform float uTime, uOmegaP, uV0, uRc, uViewportH, uRef, uExposure, uMaxPS;
attribute vec4 aOrbit;
attribute vec3 aColor;
attribute vec2 aProp;
varying vec3 vColor;
varying float vA;

vec3 orbitPos() {
  float mode = aOrbit.w;
  if (mode > 2.5) return position;
  float r = aOrbit.x;
  float ang = aOrbit.y;
  if (mode < 1.5) {
    float v = uV0 * (1.0 - exp(-r / uRc));       // rising, then flat rotation curve (km/s)
    float om = v * 1.0227e-3 / max(r, 0.05);     // rad per Myr
    if (mode > 0.5) om *= 0.55;
    ang -= om * uTime;
  } else {
    ang -= uOmegaP * uTime;
  }
  return vec3(r * cos(ang), aOrbit.z, r * sin(ang));
}

void main() {
  vec3 p = orbitPos();
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float ppr = projectionMatrix[1][1] * uViewportH * 0.5;   // pixels per radian
  float dist = max(length(mv.xyz), 1e-3);
#if defined(STARS)
  float I = aProp.x * uExposure;
  if (aOrbit.w < 2.5) I *= min(uRef * uRef / (dist * dist), 6.0);
  float ps = 0.0021 * ppr;                                  // fixed angular PSF
  float grow = clamp(sqrt(I), 1.0, 2.6);
  ps *= grow; I /= grow;
  if (ps < 1.5) { I *= ps * ps / 2.25; ps = 1.5; }          // conserve flux on small targets
  vColor = aColor * I;
  vA = 1.0;
#else
  float ps = aProp.x * ppr / dist;
  // Fade sprites that would swamp the view: any wider than ~a quarter of the screen, and any the
  // camera is inside of. Seen from within the galaxy they would only be fog, and costly to fill.
  float maxPs = min(uMaxPS, uViewportH * 0.28);
  float a = aProp.y * (1.0 - smoothstep(maxPs * 0.45, maxPs, ps)) * smoothstep(0.6, 2.2, dist / aProp.x);
  if (ps < 1.5) { a *= ps * ps / 2.25; ps = 1.5; }
  ps = min(ps, maxPs);
  vColor = aColor;
  vA = a;
  if (a < 1e-4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; } // cull
#endif
  gl_PointSize = ps;
}
`;

export const POINT_FS = /* glsl */`
varying vec3 vColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
#if defined(STARS)
  // Tight core plus a faint halo, like a telescope's point spread function.
  gl_FragColor = vec4(vColor * (0.8 * exp(-r2 * 7.0) + 0.2 * exp(-r2 * 1.8) * (1.0 - r2)), 1.0);
#elif defined(CLOUDS)
  gl_FragColor = vec4(vColor * vA * exp(-r2 * 3.2) * (1.0 - r2), 1.0);
#else
  // Dust absorbs: the blend multiplies what is behind by (1 - this colour).
  gl_FragColor = vec4(vColor * vA * exp(-r2 * 2.6) * (1.0 - r2), 1.0);
#endif
}
`;

export const LENS_FS = /* glsl */`
uniform sampler2D tDiffuse;
uniform samplerCube tCube;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uRs;
uniform float uTime;
uniform float uBend;
uniform float uDisk;
uniform float uLs;
varying vec2 vUv;

#define RMARCH 40.0
#define RIN 3.0
#define ROUT 16.0
#define TPEAK 7800.0
#define SPIN 4.08

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
vec2 rot(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
vec3 blackbody(float T) {
  float t = clamp(T, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : 1.29293618 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 0.39008157876 * log(t) - 0.63184144378 : 1.12989086 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.54320678911 * log(t - 10.0) - 1.19625408914);
  return pow(clamp(vec3(r, g, b), 0.0, 1.0), vec3(2.2));
}

// Light arriving along world direction d, having last been near world point xw.
vec3 background(vec3 xw, vec3 d) {
  vec3 cube = min(textureCube(tCube, d).rgb, vec3(4.0));
  vec4 c = uViewProj * vec4(xw + d * uLs, 1.0);
  if (c.w <= 0.0) return cube;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  vec2 outside = max(-uv, uv - 1.0);
  float onScreen = 1.0 - smoothstep(0.0, 0.06, max(max(outside.x, outside.y), 0.0));
  vec3 scr = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
  return mix(cube, scr, onScreen);
}

// Thin Keplerian disk: blackbody temperature profile, Doppler beaming, gravitational redshift.
vec4 disk(vec3 p, vec3 dir) {
  float r = length(p.xz);
  float om = SPIN * pow(r, -1.5);
  float T = 6.0;
  float f1 = fract(uTime / T);
  float f2 = fract(uTime / T + 0.5);
  float w1 = 1.0 - abs(2.0 * f1 - 1.0);
  vec2 q1 = rot(p.xz, om * f1 * T);
  vec2 q2 = rot(p.xz, om * f2 * T);
  float n1 = fbm(vec3(q1 * 1.1, r * 2.0));
  float n2 = fbm(vec3(q2 * 1.1 + 19.3, r * 2.0 + 4.0));
  float n = mix(n2, n1, w1);

  float temp = TPEAK * pow(r / RIN, -0.75);
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.6)), 0.92);
  float gam = inversesqrt(1.0 - beta * beta);
  vec3 vdir = normalize(vec3(p.z, 0.0, -p.x));
  float dop = 1.0 / (gam * (1.0 - beta * dot(vdir, -dir)));
  float g = dop * sqrt(max(1.0 - 1.0 / r, 0.0));

  float I = pow(temp / TPEAK, 2.2) * pow(g, 3.0) * (0.3 + 1.6 * n * n) * 1.7 * uDisk;
  float edge = smoothstep(RIN * 0.94, RIN * 1.12, r) * (1.0 - smoothstep(ROUT * 0.5, ROUT, r));
  float a = clamp(edge * (0.2 + 1.1 * n), 0.0, 0.95) * min(uDisk * 4.0, 1.0);
  return vec4(blackbody(temp * g) * I, a);
}

// Drop invalid values and roll off extreme highlights: single very bright pixels
// turn into blocky squares in the bloom pass's low-resolution levels.
vec4 finish(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec4(0.0, 0.0, 0.0, 1.0);
  float m = max(max(c.r, c.g), c.b);
  const float KNEE = 2.5;
  if (m > KNEE) c *= (KNEE + (m - KNEE) / (1.0 + (m - KNEE) / 4.0)) / m;
  return vec4(c, 1.0);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 pv = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(pv.xyz / pv.w, 0.0)).xyz);

  // Everything below is in units of the Schwarzschild radius, hole at the origin.
  vec3 ro = uCamPos / uRs;
  float lro = length(ro);
  float tca = -dot(ro, rd);
  if (tca < 0.0 && lro > RMARCH) { gl_FragColor = finish(texture2D(tDiffuse, vUv).rgb); return; }

  vec3 pca = ro + rd * tca;
  float b = length(pca);
  vec3 toward = b > 1e-5 ? -pca / b : vec3(0.0);

  // Weak field: point-lens deflection of 2 rs / b.
  if (b > RMARCH) {
    float al = 2.0 * uBend / b;
    vec3 d2 = normalize(rd * cos(al) + toward * sin(al));
    gl_FragColor = finish(background(pca * uRs, d2));
    return;
  }

  // Strong field: integrate the photon path, x'' = -1.5 h^2 x / r^5.
  vec3 x = ro;
  vec3 v = rd;
  if (lro > RMARCH) {
    x = ro + rd * (tca - sqrt(max(RMARCH * RMARCH - b * b, 0.0)));
    float ain = uBend / max(b, 1e-3) * (1.0 - sqrt(max(1.0 - b * b / (RMARCH * RMARCH), 0.0)));
    v = normalize(v * cos(ain) + toward * sin(ain));
  }
  vec3 hv = cross(x, v);
  float h2 = dot(hv, hv);

  vec3 acc = vec3(0.0);
  float aa = 0.0;
  float escaped = 0.0;
  for (int i = 0; i < 320; i++) {
    float r = length(x);
    if (r < 1.0) break;
    if (r > RMARCH && dot(x, v) > 0.0) { escaped = 1.0; break; }
    float dt = clamp(0.055 * r, 0.015, 2.5);
    vec3 a0 = -1.5 * uBend * h2 * x / pow(r, 5.0);
    vec3 vh = v + a0 * (0.5 * dt);
    vec3 xn = x + vh * dt;
    float rn = max(length(xn), 0.2);
    vec3 a1 = -1.5 * uBend * h2 * xn / pow(rn, 5.0);
    vec3 vn = vh + a1 * (0.5 * dt);
    if (x.y * xn.y <= 0.0 && x.y != xn.y) {
      float f = x.y / (x.y - xn.y);
      vec3 p = mix(x, xn, f);
      float pr = length(p.xz);
      if (pr > RIN * 0.9 && pr < ROUT) {
        vec4 dc = disk(p, normalize(mix(v, vn, f)));
        acc += (1.0 - aa) * dc.rgb * dc.a;
        aa += (1.0 - aa) * dc.a;
        if (aa > 0.985) break;
      }
    }
    x = xn;
    v = vn;
  }

  vec3 bg = vec3(0.0);
  if (escaped > 0.5) {
    vec3 vN = normalize(v);
    vec3 perp = x - dot(x, vN) * vN;
    float bo = length(perp);
    if (bo > 1e-4) {
      float aout = uBend / bo * (1.0 - sqrt(max(1.0 - bo * bo / (RMARCH * RMARCH), 0.0)));
      vN = normalize(vN * cos(aout) - perp / bo * sin(aout));
    }
    bg = background(x * uRs, vN);
  }
  gl_FragColor = finish(acc + (1.0 - aa) * bg);
}
`;

// Final grade before tone mapping: a soft optical vignette.
export const FINISH_FS = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  c.rgb *= mix(0.5, 1.0, smoothstep(1.1, 0.3, length(d)));
  gl_FragColor = c;
}
`;

export const FULLSCREEN_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
