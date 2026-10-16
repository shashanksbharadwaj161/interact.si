/**
 * GLSL for the companion orb (WebGL 1 / GLSL ES 1.00, so it runs on older integrated GPUs).
 * Original shader: an analytic sphere with a short refracted march through an inner volume, studio-style
 * reflections, a fresnel rim, anti-aliased silhouette and dithering. Nothing is loaded from the network.
 *
 * Form 0 porcelain: milky glaze over a luminous nucleus. Form 1 smoked glass: tinted glass holding drifting smoke.
 * Form 2 ribbon: clear glass holding three thin bands of light.
 * State uniforms (energy, swirl, sweep, pulse, alert) come from real companion events. uLevel is a measured
 * microphone level and stays 0 when no audio source is attached.
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
uniform float uLevel;
uniform float uDark;
uniform float uSeed;

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

// Studio environment for reflections: a soft key window up and to the left, a floor bounce and a tinted rim light.
vec3 env(vec3 d, vec3 tint) {
  float sky = smoothstep(-0.35, 0.9, d.y);
  vec3 lightRoom = mix(vec3(0.74, 0.74, 0.71), vec3(1.0, 1.0, 0.99), sky);
  vec3 darkRoom = mix(vec3(0.035, 0.04, 0.035), vec3(0.2, 0.21, 0.2), sky);
  vec3 base = mix(lightRoom, darkRoom, uDark);
  vec2 sb = d.xy - vec2(-0.42, 0.5);
  float box = 1.0 - smoothstep(0.02, 0.16, length(max(abs(sb) - vec2(0.2, 0.11), 0.0)));
  base += vec3(1.25) * box * step(0.0, d.z);
  float rim = smoothstep(0.55, 1.0, dot(d, normalize(vec3(0.75, -0.45, 0.35))));
  base += tint * (0.55 + 0.4 * uDark) * rim;
  return base;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  float px = 2.2 / min(uRes.x, uRes.y);
  float t = uTime;
  float breathe = 1.0 + 0.011 * sin(t * 1.05) + 0.03 * uLevel;
  float R = 0.8 * breathe;
  float r = length(p);
  vec3 tint = mix(uTint, vec3(0.98, 0.6, 0.24), uAlert * 0.85);

  // Outside the sphere: a soft contact shadow on porcelain, a faint tinted halo on ink.
  vec2 sp = (p - vec2(0.0, -R * 0.97)) / vec2(R * 0.74, R * 0.15);
  float shadow = exp(-dot(sp, sp) * 1.7) * 0.2 * (1.0 - uDark);
  float halo = exp(-pow(max(r - R, 0.0) * 11.0, 2.0)) * (0.07 + 0.22 * uEnergy) * uDark * step(R, r) * (1.0 - smoothstep(0.9, 1.0, r));
  vec4 outside = vec4(tint * halo, halo + shadow);

  float inside = smoothstep(R + px, R - px, r);
  if (inside <= 0.0) {
    gl_FragColor = outside;
    return;
  }

  vec2 q = p / R;
  float q2 = min(dot(q, q), 0.9999);
  vec3 n = normalize(vec3(q, sqrt(1.0 - q2)));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.55, 0.7, 0.6));
  float ndl = dot(n, L);
  float fres = pow(1.0 - n.z, 3.0);
  vec3 envc = env(reflect(-V, n), tint);
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float spec = pow(nh, 260.0);
  float sheen = pow(nh, 16.0);

  // Short march through the inner volume along the refracted ray.
  float flow = t * (0.1 + 0.6 * uSwirl);
  vec3 ro = n;
  vec3 rd = refract(-V, n, 1.0 / 1.45);
  float sExit = max(-2.0 * dot(ro, rd), 0.0);
  float dens = 0.0;
  float hueMix = 0.0;
  for (int i = 0; i < 7; i++) {
    float s = (float(i) + 0.5) / 7.0 * sExit;
    vec3 pos = ro + rd * s;
    float rr = length(pos);
    vec3 pp = pos;
    pp.xz = rot(flow) * pp.xz;
    float d = 0.0;
    if (uForm < 0.5) {
      // A soft luminous nucleus with slow cloud structure: frosted milk glass lit from inside.
      float core = exp(-rr * rr * (3.9 - 1.8 * uEnergy - 1.4 * uLevel));
      float cloud = fbm(pp * 1.8 + vec3(0.0, flow * 0.7, uSeed));
      d = core * (0.62 + 0.55 * cloud);
      hueMix += cloud;
    } else if (uForm < 1.5) {
      // Ridged noise gives thin smoke filaments instead of a uniform haze.
      float nn = fbm(pp * 2.3 + vec3(flow * 0.5, -flow * 0.3, uSeed));
      float ridge = 1.0 - abs(2.0 * nn - 1.0);
      ridge = pow(ridge, 8.0);
      d = ridge * (1.1 - rr * 0.75) * 1.3 + exp(-rr * rr * 7.5) * (0.18 + 0.45 * uEnergy);
      hueMix += nn;
    } else {
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
        hueMix += fk * 0.5 * step(0.5, exp(-dist * dist / (width * width)));
      }
      d *= 0.62;
    }
    float band = exp(-pow((pos.y - (0.9 - 1.8 * fract(t * 0.42))) * 7.0, 2.0)) * uSweep;
    d += band * (uForm > 1.5 ? 0.22 : 0.42);
    d *= 1.0 + uPulse * 0.32 * (0.5 + 0.5 * sin(t * 5.0));
    dens += d;
  }
  dens /= 7.0;
  hueMix = clamp(hueMix / 7.0, 0.0, 1.0);
  float glow = dens * (0.65 + 1.2 * uEnergy + 0.8 * uLevel);
  vec3 lightCol = mix(tint, uTint2, smoothstep(0.25, 0.75, hueMix));
  vec3 inner = mix(lightCol, vec3(1.0), 0.18) * glow;
  // Light from the nucleus that reaches the lower edge, like a lamp under frosted glass.
  float bounce = smoothstep(0.1, 1.0, -n.y) * smoothstep(0.2, 1.0, 1.0 - n.z);
  // Broad soft lobe from the key light; the crisp point and the rim arc come from spec and env().
  float softbox = pow(nh, 7.0) * smoothstep(0.2, 0.75, n.z);

  vec3 col;
  if (uForm < 0.5) {
    vec3 milk = mix(vec3(0.975, 0.972, 0.958), vec3(0.64, 0.66, 0.7), uDark);
    float wrap = clamp((ndl + 0.7) / 1.7, 0.0, 1.0);
    vec3 glaze = milk * mix(0.8 + 0.2 * wrap, 0.55 + 0.45 * wrap, uDark);
    float sss = clamp(glow * mix(1.55, 1.15, uDark), 0.0, 1.0);
    col = mix(glaze, lightCol * 1.05 + 0.18, sss * (0.55 + 0.4 * n.z));
    col += lightCol * bounce * (0.35 + 0.5 * uEnergy);
    col = mix(col, envc * vec3(0.98, 0.99, 1.0), 0.18 * fres);
    col += vec3(1.0) * softbox * mix(0.32, 0.22, uDark);
    col += vec3(1.0) * spec * 0.9 + lightCol * sheen * 0.06;
  } else if (uForm < 1.5) {
    vec3 glass = mix(vec3(0.05, 0.055, 0.065), tint * 0.12, 0.5);
    col = glass + inner * 1.25;
    col += lightCol * bounce * (0.25 + 0.4 * uEnergy);
    col = mix(col, envc, 0.05 + 0.75 * fres);
    col += vec3(1.0) * softbox * 0.2;
    col += vec3(1.0) * spec * 1.2;
  } else {
    vec3 clear = mix(vec3(0.9, 0.915, 0.94), vec3(0.06, 0.07, 0.09), uDark);
    vec3 base = clear * (0.82 + 0.18 * max(ndl, 0.0));
    // On porcelain the bands tint the glass; on ink they add light.
    vec3 onLight = mix(base, lightCol * 0.82, clamp(glow * 1.6, 0.0, 0.92));
    col = mix(onLight, base + inner * 1.5, uDark);
    col += lightCol * bounce * 0.3;
    col = mix(col, envc, 0.06 + 0.6 * fres);
    col += vec3(1.0) * softbox * 0.22;
    col += vec3(1.0) * spec * 1.1;
  }
  // A slightly firmer edge on porcelain backgrounds keeps the silhouette crisp at small sizes.
  col *= 1.0 - 0.07 * smoothstep(0.9, 1.0, sqrt(q2)) * (1.0 - uDark);
  col = col / (1.0 + max(col - 0.85, 0.0) * 0.9);
  col += (hash31(vec3(gl_FragCoord.xy, fract(t))) - 0.5) / 255.0;
  gl_FragColor = vec4(col * inside, inside) + outside * (1.0 - inside);
}
`;
