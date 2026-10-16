/**
 * GLSL for the companion core (WebGL 1 / GLSL ES 1.00, so it runs on older integrated GPUs). Original shader.
 *
 * An analytic glass sphere with a short refracted march through its interior, studio reflections, a fresnel rim,
 * an anti-aliased silhouette and dithering. Larger placements also draw an outer ring: orbiting particles and a
 * waveform line.
 *
 * Forms: 0 Arc core (plasma filaments in dark glass), 1 Lattice (holographic cage), 2 Ribbon (bands of light),
 * 3 Frost (pale frosted glass).
 *
 * State uniforms (energy, swirl, sweep, pulse, alert, ring) come from real companion events. uLevel is a measured
 * microphone level and is 0 whenever no audio source is attached, so the waveform is flat unless sound is really
 * being recorded. Speaking and working change rhythm and speed; they never pretend to be an amplitude.
 */

export const ORB_VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const ORB_FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uForm;
uniform vec3 uTint;
uniform vec3 uTint2;
uniform float uEnergy;
uniform float uSwirl;
uniform float uSweep;
uniform float uPulse;
uniform float uAlert;
uniform float uRing;
uniform float uRingOn;
uniform float uLevel;
uniform float uDark;
uniform float uSeed;

const float TAU = 6.2831853;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash31(i);
  float b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0));
  float d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0));
  float g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0));
  float k = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

// Studio environment for reflections: a key window up-left, a cool floor bounce and the energy colour as a rim light.
vec3 env(vec3 d, vec3 energy) {
  float sky = smoothstep(-0.35, 0.9, d.y);
  vec3 darkRoom = mix(vec3(0.02, 0.025, 0.035), vec3(0.12, 0.15, 0.2), sky);
  vec3 lightRoom = mix(vec3(0.62, 0.66, 0.7), vec3(0.95, 0.97, 0.99), sky);
  vec3 base = mix(lightRoom, darkRoom, uDark);
  vec2 sb = d.xy - vec2(-0.42, 0.5);
  float box = 1.0 - smoothstep(0.02, 0.16, length(max(abs(sb) - vec2(0.2, 0.1), 0.0)));
  base += vec3(1.2) * box * step(0.0, d.z);
  float rim = smoothstep(0.5, 1.0, dot(d, normalize(vec3(0.75, -0.45, 0.35))));
  base += energy * (0.7 + 0.5 * uDark) * rim;
  return base;
}

// Lattice lines on a unit-sphere point, in its own turning frame. Returns line intensity 0..1.
float lattice(vec3 s, float t, float px) {
  vec3 q = s;
  q.xz = rot(t * (0.25 + 0.9 * uSwirl)) * q.xz;
  q.yz = rot(0.42) * q.yz;
  float lat = asin(clamp(q.y, -1.0, 1.0)) / 3.14159 * 9.0;
  float lon = atan(q.x, q.z) / TAU * 18.0;
  float w = 0.06 + px * 6.0;
  float l1 = 1.0 - smoothstep(0.0, w, abs(fract(lat + 0.5) - 0.5));
  float l2 = 1.0 - smoothstep(0.0, w * 1.2, abs(fract(lon + 0.5) - 0.5));
  l2 *= smoothstep(0.98, 0.7, abs(q.y));
  return max(l1, l2 * 0.8);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  float px = 2.2 / min(uRes.x, uRes.y);
  float t = uTime;
  float breathe = 1.0 + 0.012 * sin(t * 1.05) + 0.028 * uLevel;
  float R = mix(0.8, 0.64, uRingOn) * breathe;
  float r = length(p);
  vec3 energy = mix(uTint, vec3(1.0, 0.62, 0.2), uAlert * 0.9);
  vec3 depth = mix(uTint2, vec3(1.0, 0.3, 0.45), uAlert * 0.6);

  // ---------- Outside the sphere: halo, contact shadow, particle ring and waveform ----------
  vec4 outside = vec4(0.0);
  float halo = exp(-pow(max(r - R, 0.0) * 14.0, 2.0)) * (0.06 + 0.2 * uEnergy) * step(R, r) * (1.0 - smoothstep(0.88, 1.0, r));
  vec2 sp = (p - vec2(0.0, -R * 0.97)) / vec2(R * 0.74, R * 0.15);
  float shadow = exp(-dot(sp, sp) * 1.7) * 0.22 * (1.0 - uDark);
  outside += vec4(energy * halo, halo + shadow);
  if (uRingOn > 0.5 && r > R) {
    float a = atan(p.y, p.x);
    // Waveform line: displaced only by the measured level.
    float wave = sin(a * 7.0 + t * 3.1) * 0.6 + sin(a * 13.0 - t * 4.7) * 0.4;
    float rw = R * 1.2 + wave * uLevel * 0.07;
    float line = exp(-pow((r - rw) / (px * 0.9), 2.0)) * (0.12 + 0.55 * uRing);
    // Fine tick marks every 15 degrees on an inner hairline, like an instrument bezel.
    float tick = step(0.94, abs(cos(a * 12.0))) * exp(-pow((r - R * 1.09) / (px * 2.2), 2.0)) * (0.1 + 0.25 * uRing);
    line += tick;
    // Transcribing: a bright arc sweeping around the ring.
    float sweepA = mod(a - t * 2.4, TAU);
    line += exp(-pow(sweepA - 0.6, 2.0) * 3.0) * uSweep * 0.9 * exp(-pow((r - R * 1.2) / (px * 1.6), 2.0));
    // Particles: one per angular slot, each on its own radius and speed.
    float N = 42.0;
    float spin = t * (0.06 + 0.5 * uSwirl);
    float slotF = (a / TAU + 0.5) * N + spin * N / TAU;
    float slot = floor(slotF);
    float dots = 0.0;
    for (int k = -1; k <= 1; k++) {
      float sl = slot + float(k);
      float hsh = hash11(sl + uSeed * 7.0);
      float ang = ((sl + 0.5) / N - spin / TAU) * TAU - 3.14159 + (hsh - 0.5) * 0.08;
      float rad = R * (1.26 + 0.18 * hash11(sl * 3.7 + 1.0)) + 0.012 * sin(t * (0.6 + hsh) + sl);
      vec2 c = vec2(cos(ang), sin(ang)) * rad;
      float sz = (0.006 + 0.008 * hsh) * (0.8 + 0.6 * uRing);
      float twinkle = 0.55 + 0.45 * sin(t * (1.5 + 2.0 * hsh) + sl * 1.3);
      float speak = 1.0 + uPulse * 0.6 * (0.5 + 0.5 * sin(t * 5.0 - sl * 0.6));
      dots += exp(-dot(p - c, p - c) / (sz * sz)) * twinkle * speak;
    }
    float ringMask = (0.25 + 0.75 * uRing) * (1.0 - smoothstep(0.9, 1.0, r));
    vec3 ringCol = mix(energy, depth, 0.35);
    float ringA = clamp((line + dots * 0.85) * ringMask, 0.0, 1.0);
    outside += vec4(ringCol * ringA, ringA * 0.9);
  }

  float inside = smoothstep(R + px, R - px, r);
  if (inside <= 0.0) {
    gl_FragColor = outside;
    return;
  }

  // ---------- The sphere ----------
  vec2 q = p / R;
  float q2 = min(dot(q, q), 0.9999);
  vec3 n = normalize(vec3(q, sqrt(1.0 - q2)));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.55, 0.7, 0.6));
  float ndl = dot(n, L);
  float fres = pow(1.0 - n.z, 3.0);
  vec3 envc = env(reflect(-V, n), energy);
  float nh = max(dot(n, normalize(L + V)), 0.0);
  float spec = pow(nh, 260.0);
  float lobe = pow(nh, 7.0) * smoothstep(0.2, 0.75, n.z);

  float flow = t * (0.1 + 0.6 * uSwirl);
  vec3 rd = refract(-V, n, 1.0 / 1.45);
  float sExit = max(-2.0 * dot(n, rd), 0.0);
  float dens = 0.0;
  float hot = 0.0;
  float mixHue = 0.0;
  for (int i = 0; i < 7; i++) {
    float s = (float(i) + 0.5) / 7.0 * sExit;
    vec3 pos = n + rd * s;
    float rr = length(pos);
    vec3 pp = pos;
    pp.xz = rot(flow) * pp.xz;
    float d = 0.0;
    if (uForm < 0.5) {
      // Plasma: ridged noise filaments around a hot nucleus.
      float nn = fbm(pp * 2.2 + vec3(flow * 0.5, -flow * 0.3, uSeed));
      float ridge = pow(1.0 - abs(2.0 * nn - 1.0), 12.0);
      d = ridge * (1.2 - rr * 0.8) * 1.9;
      hot += exp(-rr * rr * (16.0 - 6.0 * uEnergy - 4.0 * uLevel));
      mixHue += nn;
    } else if (uForm < 1.5) {
      d = exp(-rr * rr * (6.0 - 2.5 * uEnergy)) * 0.55;
      hot += exp(-rr * rr * 14.0) * 0.6;
      mixHue += 0.5 + 0.5 * sin(rr * 6.0 - t);
    } else if (uForm < 2.5) {
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        vec3 rp = pos;
        rp.xy = rot(flow * (0.7 + 0.22 * fk) + fk * 2.094) * rp.xy;
        rp.yz = rot(0.5 + fk * 1.05) * rp.yz;
        float wave = 0.17 * sin(rp.x * 2.6 + t * 0.7 * (1.0 + uSwirl) + fk * 1.7);
        float dist = abs(rp.y - wave);
        float width = 0.022 + 0.014 * uEnergy;
        float fall = 1.0 - smoothstep(0.45, 0.95, length(rp.xz));
        d += (exp(-dist * dist / (width * width)) * 1.6 + exp(-dist * dist / (width * width * 9.0)) * 0.35) * fall;
        mixHue += fk * 0.5 * step(0.5, exp(-dist * dist / (width * width)));
      }
      d *= 0.62;
    } else {
      float core = exp(-rr * rr * (3.9 - 1.8 * uEnergy - 1.4 * uLevel));
      float cloud = fbm(pp * 1.8 + vec3(0.0, flow * 0.7, uSeed));
      d = core * (0.62 + 0.55 * cloud);
      mixHue += cloud;
    }
    float band = exp(-pow((pos.y - (0.9 - 1.8 * fract(t * 0.42))) * 7.0, 2.0)) * uSweep;
    d += band * (uForm > 1.5 && uForm < 2.5 ? 0.22 : 0.42);
    d *= 1.0 + uPulse * 0.32 * (0.5 + 0.5 * sin(t * 5.0));
    dens += d;
  }
  dens /= 7.0;
  hot /= 7.0;
  mixHue = clamp(mixHue / 7.0, 0.0, 1.0);
  float glow = dens * (0.65 + 1.25 * uEnergy + 0.8 * uLevel);
  vec3 lightCol = mix(energy, depth, smoothstep(0.3, 0.75, mixHue));
  vec3 inner = mix(lightCol, vec3(1.0), 0.15) * glow;
  float bounce = smoothstep(0.1, 1.0, -n.y) * smoothstep(0.2, 1.0, 1.0 - n.z);

  vec3 col;
  if (uForm < 0.5) {
    // Dark glass with an ultraviolet depth fog; crisp energy filaments; a small white-hot nucleus.
    float fog = fbm(vec3(q * 1.3, t * 0.05 + uSeed)) * (1.0 - q2 * 0.6);
    vec3 glass = vec3(0.012, 0.018, 0.03) + depth * fog * 0.16;
    col = glass * (0.75 + 0.25 * max(ndl, 0.0)) + inner * 0.95 + mix(energy, vec3(1.0), 0.7) * hot * (1.3 + 1.4 * uEnergy);
    col += depth * bounce * (0.22 + 0.3 * uEnergy);
    col = mix(col, envc, 0.05 + 0.78 * fres);
  } else if (uForm < 1.5) {
    vec3 glass = mix(vec3(0.62, 0.7, 0.76), vec3(0.015, 0.025, 0.04), uDark);
    float k2 = q2 * 1.2544;
    float zIn = sqrt(max(1.0 - k2, 0.0));
    float inCage = step(k2, 1.0);
    float front = lattice(normalize(vec3(q * 1.12, zIn)), t, px) * inCage;
    float back = lattice(normalize(vec3(-q.x * 1.12, q.y * 1.12, -zIn)), t, px) * inCage;
    float sweepLine = exp(-pow((n.y - (0.95 - 1.9 * fract(t * 0.35))) * 18.0, 2.0)) * (0.25 + uSweep);
    col = glass + inner * 0.9 + energy * (front * (0.9 + 0.7 * uEnergy) + back * 0.28) + depth * sweepLine * 0.8;
    col += mix(energy, vec3(1.0), 0.6) * hot * (0.6 + uEnergy);
    col = mix(col, envc, 0.05 + 0.7 * fres);
  } else if (uForm < 2.5) {
    vec3 clear = mix(vec3(0.86, 0.9, 0.94), vec3(0.03, 0.045, 0.065), uDark);
    vec3 base = clear * (0.82 + 0.18 * max(ndl, 0.0));
    vec3 onLight = mix(base, lightCol * 0.8, clamp(glow * 1.6, 0.0, 0.92));
    col = mix(onLight, base + inner * 1.5, uDark);
    col += lightCol * bounce * 0.3;
    col = mix(col, envc, 0.06 + 0.62 * fres);
  } else {
    vec3 milk = mix(vec3(0.95, 0.965, 0.975), vec3(0.6, 0.66, 0.72), uDark);
    float wrap = clamp((ndl + 0.7) / 1.7, 0.0, 1.0);
    vec3 glaze = milk * mix(0.8 + 0.2 * wrap, 0.55 + 0.45 * wrap, uDark);
    float sss = clamp(glow * mix(1.55, 1.15, uDark), 0.0, 1.0);
    col = mix(glaze, lightCol * 1.05 + 0.15, sss * (0.55 + 0.4 * n.z));
    col += lightCol * bounce * (0.35 + 0.5 * uEnergy);
    col = mix(col, envc, 0.16 * fres);
  }
  col += vec3(1.0) * lobe * (uForm > 2.5 ? 0.32 : 0.2);
  col += vec3(1.0) * spec * 1.2;
  // A thin energy rim keeps the silhouette strong at 24px and on both themes.
  col += energy * pow(1.0 - n.z, 6.0) * (0.35 + 0.4 * uEnergy);
  col = col / (1.0 + max(col - 0.85, 0.0) * 0.9);
  col += (hash31(vec3(gl_FragCoord.xy, fract(t))) - 0.5) / 255.0;
  gl_FragColor = vec4(col * inside, inside) + outside * (1.0 - inside);
}
`;
