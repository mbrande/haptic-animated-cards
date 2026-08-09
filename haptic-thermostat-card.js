/*
 * haptic-thermostat-card
 * A thermostat card for Home Assistant, styled after the iOS Home app, with
 * haptic feedback while dragging.
 *
 * v2 layout: the card on the dashboard is a compact square TILE showing the
 * temperature, tinted by mode. Tapping it opens a large panel containing the
 * dial. This mirrors Home's model, and it removes a real hazard: in v1 the dial
 * sat live on the dashboard, so a scroll gesture that began on the ring changed
 * the setpoint. The tile has no drag handlers at all and opens on `click`, which
 * browsers do not fire when a touch becomes a scroll.
 *
 * The haptic bridge is the reason this card exists. Home Assistant's own
 * thermostat card, its circular-slider component, and better-thermostat-ui-card
 * all contain ZERO haptic references - the only core element that fires haptics
 * is <ha-switch>. Custom cards can fire them, which is what this does:
 *
 *     fireEvent(window, "haptic", "selection")
 *
 * The companion app listens for that window event. Note it is built with
 * `new Event(...)` and `.detail` assigned afterwards - NOT
 * `new CustomEvent(type, {detail})`, which looks right and does not work.
 *
 * Haptics only fire inside the companion app. In a desktop browser the card
 * renders and works normally, silently.
 *
 * No build step, no dependencies, plain custom elements + Shadow DOM.
 */

const VERSION = "3.1.3";

/* HA's own fireEvent shape. Do not "modernise" this to CustomEvent. */
function fireEvent(node, type, detail, options = {}) {
  const event = new Event(type, {
    bubbles: options.bubbles === undefined ? true : options.bubbles,
    cancelable: Boolean(options.cancelable),
    composed: options.composed === undefined ? true : options.composed,
  });
  event.detail = detail === undefined || detail === null ? {} : detail;
  node.dispatchEvent(event);
  return event;
}

const haptic = (type) => fireEvent(window, "haptic", type);

/* Dial geometry: 270 degree sweep. In SVG, angle 0 is at 3 o'clock and grows
 * clockwise because the y axis points down. 135 -> 405 puts the gap at the
 * bottom, same as the iOS dial. */
const START_ANGLE = 135;
const SWEEP = 270;
const R = 76;
const STROKE = 22;

const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

function arcPath(cx, cy, r, a0, a1) {
  if (a1 - a0 <= 0.01) return "";
  const s = polar(cx, cy, r, a0);
  const e = polar(cx, cy, r, a1);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${e.x} ${e.y}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* #RRGGBB -> rgba(r,g,b,a). The glass tile keeps the same shade families but
 * lets the dashboard show through them. */
const hexRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
};

/* Ring ramps. The pale highlight band about two thirds along is what gives the
 * iOS ring its sheen; a plain two-stop gradient looks flat beside it. */
const RAMPS = {
  heat: [[0, "#FF5E00"], [0.44, "#FFC66B"], [0.63, "#FFEDCB"], [1, "#FF9F0A"]],
  cool: [[0, "#0A84FF"], [0.44, "#8FD0F5"], [0.63, "#DCF3F8"], [1, "#4C9BFF"]],
  dry: [[0, "#FFB800"], [0.5, "#FFEBB0"], [1, "#FFC93C"]],
  fan: [[0, "#32ADE6"], [0.5, "#CFF3FF"], [1, "#5EC8F0"]],
  idle: [[0, "#6E6E73"], [0.5, "#C7C7CC"], [1, "#8E8E93"]],
  range: [[0, "#FF7A00"], [0.5, "#F2E6D8"], [1, "#0A84FF"]],
};

/* Tile shades, three stops each, light -> deep. Which set is chosen depends on
 * how hard the thermostat is being asked to work: a low cool setpoint or a high
 * heat setpoint picks a deeper, more saturated set. Three stops rather than two
 * so the gradient reads with real depth as it drifts. */
const TILE_SHADES = {
  cool: [["#8FD8FF", "#3BB3F5", "#0A84FF"], ["#6FC8FA", "#1E9BEC", "#0A6FE8"],
         ["#4FB4F0", "#0F86DC", "#0B5FD0"], ["#2E9BE0", "#0A6CC0", "#0A4FB0"],
         ["#1B7FC4", "#0A529E", "#083E8C"]],
  heat: [["#FFD98A", "#FFB84D", "#FF9F0A"], ["#FFC96B", "#FFA333", "#FF8A00"],
         ["#FFB74D", "#FF8C1F", "#FF6B00"], ["#FF9F33", "#FF6E0A", "#F25200"],
         ["#FF8A1F", "#F25200", "#C43200"]],
  dry: [["#FFEDB0", "#FFD24D", "#FFB800"]],
  fan: [["#BDEFFF", "#6FD4F5", "#32ADE6"]],
  idle: [["#A0A0A6", "#7C7C82", "#4A4A50"]],
  range: [["#FF9F0A", "#C77A55", "#0A84FF"]],
};

const MODE_LABEL = {
  off: "Off", heat: "Heat", cool: "Cool", heat_cool: "Auto",
  auto: "Auto", dry: "Dry", fan_only: "Fan",
};

/* Orb palettes for the shader - same families the CSS layers use. */
const LQ_ORBS = {
  cool: ["#9BE8FF", "#2E6BFF", "#032A66"],
  heat: ["#FFD27A", "#FF5A00", "#7A1600"],
  dry: ["#FFE9A6", "#FFB800", "#7A5200"],
  fan: ["#CFF3FF", "#32ADE6", "#08506E"],
  idle: ["#D0D0D4", "#86868C", "#2C2C30"],
  range: ["#FFB35C", "#4C9BFF", "#24144A"],
};

const hexV = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/* The liquid material, as a fragment shader. Renders the tint gradient, the
 * drifting orbs, the comet sheen, the milk wash and the luminous rim in one
 * pass - and bends the sampling of all of it near the rounded edge using the
 * slab SDF normal, with the R/G/B channels bent by slightly different
 * amounts. That bend is the refraction CSS cannot do, and the channel split
 * is the chromatic fringe real glass has. Alpha is premultiplied; the canvas
 * composites over the SAME backdrop-filter blur the CSS glass uses, so the
 * real wallpaper still shows through underneath. */
const LQ_FRAG = 'precision mediump float;\nuniform vec2 u_res;\nuniform float u_t, u_rad, u_dpr, u_tempo;\nuniform vec3 u_c0, u_c1, u_c2, u_o1, u_o2, u_o3;\nuniform vec4 u_seed;\n\nfloat sdb(vec2 p, vec2 b, float r) {\n  vec2 q = abs(p) - b + r;\n  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;\n}\nfloat orb(vec2 uv, vec2 c, float rad) {\n  float d = length(uv - c);\n  return exp(-d * d / (rad * rad));\n}\nvec4 material(vec2 uv) {\n  vec2 g = vec2(0.5, 0.866);\n  float gt = clamp(dot(uv - 0.5, g) + 0.5, 0.0, 1.0);\n  vec3 col = gt < 0.45 ? mix(u_c0, u_c1, gt / 0.45)\n                       : mix(u_c1, u_c2, (gt - 0.45) / 0.55);\n  float a = mix(0.40, 0.58, clamp(abs(gt - 0.45) * 1.9, 0.0, 1.0));\n  float t = u_t * u_tempo;\n  vec2 p1 = vec2(0.30, 0.30) + 0.34 * vec2(cos(t * 0.55 + u_seed.x * 6.28), sin(t * 0.42 + u_seed.x * 4.0));\n  vec2 p2 = vec2(0.72, 0.70) + 0.30 * vec2(cos(t * 0.36 + u_seed.y * 6.28), sin(t * 0.61 + u_seed.y * 3.1));\n  vec2 p3 = vec2(0.55, 0.45) + 0.22 * vec2(cos(t * 0.22 + u_seed.z * 6.28), sin(t * 0.17 + u_seed.z * 5.2));\n  float g1 = orb(uv, p1, 0.42);\n  float g2 = orb(uv, p2, 0.46);\n  float g3 = orb(uv, p3, 0.60);\n  col = 1.0 - (1.0 - col) * (1.0 - u_o1 * g1 * 0.62);\n  col = 1.0 - (1.0 - col) * (1.0 - u_o2 * g2 * 0.55);\n  col = mix(col, col * u_o3, g3 * 0.42);\n  a += (g1 + g2) * 0.10;\n  float ph = fract(t / 25.0);\n  float run = smoothstep(0.55, 0.58, ph);\n  float c = mix(-0.7, 1.7, clamp((ph - 0.55) / 0.45, 0.0, 1.0));\n  float w = dot(uv, normalize(vec2(0.94, -0.34))) - c;\n  float sheen = exp(-abs(w) * (w > 0.0 ? 30.0 : 7.5)) * 0.16 * run;\n  col += sheen;\n  float milk = mix(0.20, 0.05, smoothstep(0.0, 0.45, uv.y)) + 0.05 * smoothstep(0.45, 1.0, uv.y);\n  col += milk;\n  a = clamp(a + milk * 0.55 + sheen * 0.4, 0.0, 0.92);\n  return vec4(col, a);\n}\nvoid main() {\n  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);\n  vec2 hf = u_res * 0.5;\n  vec2 p = px - hf;\n  float rad = min(u_rad, min(hf.x, hf.y));\n  float d = sdb(p, hf - 1.0, rad);\n  float e = 1.5 * u_dpr;\n  vec2 n = normalize(vec2(\n    sdb(p + vec2(e, 0.0), hf - 1.0, rad) - sdb(p - vec2(e, 0.0), hf - 1.0, rad),\n    sdb(p + vec2(0.0, e), hf - 1.0, rad) - sdb(p - vec2(0.0, e), hf - 1.0, rad)) + vec2(0.00001));\n  float edge = smoothstep(-26.0 * u_dpr, 0.0, d);\n  float bend = edge * edge * 20.0 * u_dpr;\n  vec4 mr = material((px - n * bend) / u_res);\n  vec4 mg = material((px - n * bend * 1.16) / u_res);\n  vec4 mb = material((px - n * bend * 1.34) / u_res);\n  vec3 col = vec3(mr.r, mg.g, mb.b);\n  float a = (mr.a + mg.a + mb.a) / 3.0;\n  float hair = smoothstep(1.6 * u_dpr, 0.0, abs(d + 1.6 * u_dpr)) * 0.30;\n  float halo = exp(d / (7.0 * u_dpr)) * 0.13;\n  float topl = smoothstep(2.0 * u_dpr, 0.0, abs(d + 2.2 * u_dpr)) * smoothstep(0.15, 0.7, -n.y) * 0.26;\n  col += hair + halo + topl;\n  a = clamp(a + hair + halo * 0.6 + topl, 0.0, 0.95);\n  float inside = smoothstep(0.0, -1.5, d);\n  gl_FragColor = vec4(col, 1.0) * a * inside;\n}\n';

/* ------------------------------------------------------------------ */

class HapticThermostatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._dragging = false;
    this._pending = null;
    this._activeHandle = null;
    this._lastHapticStep = null;
    this._built = false;
    this._panel = null;          // overlay host, lives on document.body
    this._pEls = null;
    this._gradId = "arc-" + Math.random().toString(36).slice(2, 9);
    this._onKey = (e) => { if (e.key === "Escape") this.closePanel(); };
    this._lqSeed = [Math.random(), Math.random(), Math.random(), Math.random()];
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("haptic-thermostat-card: 'entity' is required");
    }
    if (config.entity.split(".")[0] !== "climate") {
      throw new Error("haptic-thermostat-card: entity must be a climate.* entity");
    }
    this._config = Object.assign(
      { name: null, min: null, max: null, step: null, modes: true,
        animation: true, animation_speed: 10, glass: true, liquid: false },
      config
    );
    this._built = false;
  }

  getCardSize() { return 3; }
  static getStubConfig() { return { entity: "" }; }
  static getConfigElement() { return undefined; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._buildTile();
    this._renderTile();
    if (this._pEls) this._renderDial(this._pEls);
  }

  disconnectedCallback() {
    // The panel lives on document.body, so it must be torn down explicitly or it
    // outlives the card when a dashboard view is swapped out.
    this.closePanel();
    this._lqStop();
  }

  get _s() {
    return this._hass && this._config ? this._hass.states[this._config.entity] : undefined;
  }

  /* ---------- model ---------- */

  get _min() { const s = this._s; return this._config.min ?? (s && s.attributes.min_temp) ?? 45; }
  get _max() { const s = this._s; return this._config.max ?? (s && s.attributes.max_temp) ?? 95; }
  get _step() { const s = this._s; return this._config.step ?? (s && s.attributes.target_temp_step) ?? 1; }

  /* Range mode is detected from the ATTRIBUTES, not the mode name:
   * implementations disagree over heat_cool vs auto, but all agree on these. */
  get _isRange() {
    const s = this._s;
    return !!s && s.attributes.target_temp_low != null && s.attributes.target_temp_high != null;
  }

  get _values() {
    if (this._pending) return this._pending;
    const s = this._s;
    if (!s) return null;
    if (this._isRange) {
      return { low: Number(s.attributes.target_temp_low), high: Number(s.attributes.target_temp_high) };
    }
    return s.attributes.temperature != null ? { t: Number(s.attributes.temperature) } : null;
  }

  get _rampKey() {
    const s = this._s;
    if (!s || s.state === "off" || s.state === "unavailable") return "idle";
    if (this._isRange) return "range";
    const a = s.attributes.hvac_action;
    const b = a && a !== "idle" ? a : s.state;
    if (b === "heating" || b === "heat") return "heat";
    if (b === "cooling" || b === "cool") return "cool";
    if (b === "drying" || b === "dry") return "dry";
    if (b === "fan" || b === "fan_only") return "fan";
    return "idle";
  }

  /* How hard is it being asked to work? Low cool setpoint or high heat setpoint
   * -> deeper shade. Returns [from, to] for the tile gradient. */
  get _tileShade() {
    const key = this._rampKey;
    const set = TILE_SHADES[key] || TILE_SHADES.idle;
    if (set.length === 1) return set[0];
    const v = this._values;
    if (!v || v.t === undefined) return set[Math.floor(set.length / 2)];
    const frac = clamp((v.t - this._min) / (this._max - this._min), 0, 1);
    const intensity = key === "cool" ? 1 - frac : frac;
    return set[clamp(Math.round(intensity * (set.length - 1)), 0, set.length - 1)];
  }

  _angleFor(t) {
    return START_ANGLE + clamp((t - this._min) / (this._max - this._min), 0, 1) * SWEEP;
  }

  /* ---------- tile (what sits on the dashboard) ---------- */

  _buildTile() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        /* The gradient and its animation live on our OWN element, not on
         * <ha-card>. ha-card's :host rule sets the 'background' SHORTHAND, which
         * resets background-size to auto - so an animation on background-position
         * runs but has nothing to travel across, and looks like nothing happens.
         * Owning the painted layer sidesteps the cross-shadow cascade entirely. */
        ha-card {
          position: relative; overflow: hidden;
          height: 100%; box-sizing: border-box;
          border: none; padding: 0;
          background: transparent;
          cursor: pointer;
          transition: transform .18s ease, filter .18s ease;
          color: #fff;
        }
        ha-card:active { transform: scale(.97); filter: brightness(1.08); }
        /* The STRONG gradient stays at natural size on .bg - panning an
         * oversized gradient showed only a thin slice of it at any moment,
         * which is why the depth washed out. Motion comes from layers ABOVE
         * the gradient instead: three radial glow orbs drifting lava-lamp
         * style (transform-only, so GPU composited) and a periodic sheen
         * sweep. Orb colours and tempo differ per mode. */
        /* isolation: the orbs use mix-blend-mode, and on a translucent tile
         * they would otherwise blend with whatever the dashboard has behind the
         * card. Isolating .bg makes them blend only against the tinted glass. */
        .bg {
          position: absolute; inset: 0; isolation: isolate;
          /* Match the card's own radius so the blur region and the bevel both
           * curve with the corners instead of being square shapes clipped by
           * overflow:hidden - the clipping is exactly what reduced the old rim
           * to straight lines on two edges. */
          border-radius: var(--ha-card-border-radius, var(--ha-border-radius-lg, 12px));
        }
        .bg.glass {
          backdrop-filter: blur(26px) saturate(1.8) brightness(1.06);
          -webkit-backdrop-filter: blur(26px) saturate(1.8) brightness(1.06);
        }
        /* The bevel proper. Inset box-shadows follow border-radius natively,
         * which is what makes these read as rounded glass edges rather than
         * drawn lines: a hairline all the way round, a bright refraction on the
         * top-left curvature, a thinner lip on the bottom-right, a dark inner
         * depth opposite the light, and a wide faint bloom filling the slab. */
        .bg.glass::after {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          z-index: 1;
          border-radius: inherit;
          /* Luminous, not carved: Apple's glass edge is a soft uniform bright
           * rim with NO dark inner shadow anywhere. A crisp hairline, a soft
           * white halo hugging it, and a slightly brighter top inner line. */
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.30),
            inset 0 0 7px 2px rgba(255,255,255,.13),
            inset 0 1.5px 1px rgba(255,255,255,.28);
        }
        /* Light entering the slab: a corner bloom, not an edge stripe. */
        .bg.glass::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          z-index: 1;
          border-radius: inherit;
          /* The milk: a white frost wash, brightest at the top, faint again at
           * the base - this is what makes the slab read as glass rather than a
           * tinted panel. */
          background: linear-gradient(180deg,
            rgba(255,255,255,.20) 0%,
            rgba(255,255,255,.05) 45%,
            rgba(255,255,255,.10) 100%);
        }
        .blob {
          position: absolute; width: 130%; aspect-ratio: 1;
          border-radius: 50%;
          background: radial-gradient(circle, var(--c) 0%, transparent 62%);
          mix-blend-mode: screen; opacity: .8;
          will-change: transform;
        }
        .b1 { top: -55%; left: -45%; animation: float1 calc(var(--drift-speed, 10s) * 1.15 * var(--r, 1)) ease-in-out infinite alternate; }
        .b2 { bottom: -60%; right: -45%; animation: float2 calc(var(--drift-speed, 10s) * 1.6 * var(--r, 1)) ease-in-out infinite alternate; }
        .b3 {
          top: -20%; left: -15%; width: 170%;
          mix-blend-mode: multiply; opacity: .55;
          animation: float3 calc(var(--drift-speed, 10s) * 2.2 * var(--r, 1)) ease-in-out infinite alternate;
        }
        /* A light catch, not a stripe: the old gradient spiked to its peak
         * across 5% of the band, which drew a visible edge. Bell-curve stops
         * over the full width, a lower peak, a slight blur to melt what is
         * left of the edges, and the angle matched to the base gradient's
         * 150deg so it reads as the same light source. */
        .sheen {
          position: absolute; top: -25%; bottom: -25%; width: 95%;
          /* Comet, not a bar: the wave moves left-to-right, so the bright crest
           * sits near the leading edge at 84% and the light decays in a long
           * tail behind it, with two fainter echo ripples further back - that
           * is the trail. The leading edge falls off fast so the wave has a
           * face. */
          background: linear-gradient(115deg,
            transparent 0%,
            rgba(255,255,255,.03) 14%,
            rgba(255,255,255,.07) 20%,
            rgba(255,255,255,.03) 27%,
            rgba(255,255,255,.09) 42%,
            rgba(255,255,255,.05) 52%,
            rgba(255,255,255,.08) 64%,
            rgba(255,255,255,.13) 74%,
            rgba(255,255,255,.20) 84%,
            rgba(255,255,255,.07) 93%,
            transparent 100%);
          filter: blur(10px);
          transform: translateX(-220%) skewX(-18deg);
          mix-blend-mode: screen;
          animation: sheen calc(var(--drift-speed, 10s) * 2.5 * var(--r, 1)) linear infinite;
          will-change: transform;
        }
        @keyframes float1 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          50%  { transform: translate3d(28%, 22%, 0) scale(1.12); }
          100% { transform: translate3d(52%, 6%, 0) scale(.94); }
        }
        @keyframes float2 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          50%  { transform: translate3d(-30%, -18%, 0) scale(1.15); }
          100% { transform: translate3d(-8%, -42%, 0) scale(1); }
        }
        @keyframes float3 {
          0%   { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(14%, 20%, 0); }
        }
        /* Off-screen most of the cycle, one clean pass across. */
        @keyframes sheen {
          0%, 55% { transform: translateX(-220%) skewX(-18deg); }
          100%    { transform: translateX(260%) skewX(-18deg); }
        }
        /* Mode choreography. Cool drifts glacially (the defaults above); heat
         * runs the same paths noticeably faster, so it reads as embers rather
         * than ice. */
        .m-heat .b1 { animation-duration: calc(var(--drift-speed, 10s) * .65 * var(--r, 1)); }
        .m-heat .b2 { animation-duration: calc(var(--drift-speed, 10s) * .9 * var(--r, 1)); }
        .m-heat .b3 { animation-duration: calc(var(--drift-speed, 10s) * 1.3 * var(--r, 1)); }
        .m-heat .sheen { animation-duration: calc(var(--drift-speed, 10s) * 1.8 * var(--r, 1)); }
        /* Orb palettes per mode. */
        .m-cool  .b1 { --c: #9BE8FF; } .m-cool  .b2 { --c: #2E6BFF; } .m-cool  .b3 { --c: #032A66; }
        .m-heat  .b1 { --c: #FFD27A; } .m-heat  .b2 { --c: #FF5A00; } .m-heat  .b3 { --c: #7A1600; }
        .m-dry   .b1 { --c: #FFE9A6; } .m-dry   .b2 { --c: #FFB800; } .m-dry   .b3 { --c: #7A5200; }
        .m-fan   .b1 { --c: #CFF3FF; } .m-fan   .b2 { --c: #32ADE6; } .m-fan   .b3 { --c: #08506E; }
        .m-idle  .b1 { --c: #D0D0D4; } .m-idle  .b2 { --c: #86868C; } .m-idle  .b3 { --c: #2C2C30; }
        .m-range .b1 { --c: #FFB35C; } .m-range .b2 { --c: #4C9BFF; } .m-range .b3 { --c: #24144A; }
        .bg.no-anim .blob, .bg.no-anim .sheen { animation: none; }
        @media (prefers-reduced-motion: reduce) {
          .blob, .sheen { animation: none; }
        }
        /* The shader canvas replaces the DOM-painted material when liquid
         * mode is active; the backdrop-filter on .bg stays either way, so the
         * real wallpaper blur is identical in both engines. */
        .lq { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }
        .bg.liquid .lq { display: block; }
        .bg.liquid .blob, .bg.liquid .sheen { display: none; }
        .bg.liquid::before, .bg.liquid::after { display: none; }
        .content {
          position: relative; z-index: 1;
          height: 100%; box-sizing: border-box;
          padding: 16px 18px;
          display: flex; flex-direction: column; justify-content: space-between;
        }
        .top { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .top svg { width: 20px; height: 20px; flex: none; opacity: .95; }
        .nm {
          font-size: 15px; font-weight: 600; letter-spacing: .2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          text-shadow: 0 1px 2px rgba(0,0,0,.18);
        }
        .bot { display: flex; flex-direction: column; gap: 1px; }
        .big {
          font-size: 40px; font-weight: 500; line-height: 1;
          font-feature-settings: "tnum";
          text-shadow: 0 1px 3px rgba(0,0,0,.2);
        }
        .big sup { font-size: 18px; font-weight: 400; vertical-align: super; }
        .sub {
          font-size: 13px; font-weight: 500; opacity: .92;
          text-shadow: 0 1px 2px rgba(0,0,0,.18);
        }
        .unavail { font-size: 15px; font-weight: 600; }
      </style>
      <ha-card>
        <div class="bg">
          <div class="blob b1"></div>
          <div class="blob b2"></div>
          <div class="blob b3"></div>
          <div class="sheen"></div>
          <canvas class="lq"></canvas>
        </div>
        <div class="content">
        <div class="top">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0zm-3-9a1 1 0 0 1 1 1v8.6l.5.3a3 3 0 1 1-3 0l.5-.3V5a1 1 0 0 1 1-1z"/></svg>
          <div class="nm"></div>
        </div>
        <div class="bot">
          <div class="big"></div>
          <div class="sub"></div>
        </div>
        </div>
      </ha-card>
    `;
    this._tEls = {
      card: this.shadowRoot.querySelector("ha-card"),
      bg: this.shadowRoot.querySelector(".bg"),
      lq: this.shadowRoot.querySelector(".lq"),
      nm: this.shadowRoot.querySelector(".nm"),
      big: this.shadowRoot.querySelector(".big"),
      sub: this.shadowRoot.querySelector(".sub"),
    };
    // `click`, deliberately: a touch that becomes a scroll never produces one,
    // so scrolling past the card can't open it - and there are no drag handlers
    // here at all, so scrolling can't change the temperature either.
    // De-loop the choreography: each layer gets a random tempo multiplier, a
    // random negative delay (so it starts mid-phase), and a coin-flip travel
    // direction. Randomised once per card build - the composition never visibly
    // repeats, and two cards on one dashboard never move in sync. The sheen
    // keeps its direction: the comet tail points the way it travels.
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (const sel of [".b1", ".b2", ".b3", ".sheen"]) {
      const el = this.shadowRoot.querySelector(sel);
      el.style.setProperty("--r", rnd(0.82, 1.28).toFixed(3));
      el.style.animationDelay = "-" + rnd(0, 30).toFixed(2) + "s";
      if (sel !== ".sheen" && Math.random() < 0.5) {
        el.style.animationDirection = "alternate-reverse";
      }
    }

    this._tEls.card.addEventListener("click", () => this.openPanel());
  }

  /* Speed and on/off are config-driven so the animation can be tuned or killed
   * without touching the card. A speed of 0 (or animation:false) stops it. */
  _applyAnimation() {
    const c = this._tEls.bg;
    const spd = Number(this._config.animation_speed);
    const on = this._config.animation !== false && !(spd === 0);
    c.classList.toggle("no-anim", !on);
    if (on) c.style.setProperty("--drift-speed", `${spd > 0 ? spd : 10}s`);
  }

  _setModeClass(key) {
    const bg = this._tEls.bg;
    for (const m of ["heat", "cool", "dry", "fan", "idle", "range"]) {
      bg.classList.toggle("m-" + m, m === key);
    }
  }

  _renderTile() {
    if (!this._tEls) return;
    const s = this._s;
    const unit = this._hass.config.unit_system.temperature || "°";
    this._tEls.nm.textContent =
      this._config.name ?? (s ? s.attributes.friendly_name : this._config.entity);

    if (!s || s.state === "unavailable" || s.state === "unknown") {
      const gOff = this._config.glass !== false;
      this._tEls.bg.classList.toggle("glass", gOff);
      this._tEls.bg.style.backgroundImage = gOff
        ? "linear-gradient(150deg," + hexRgba("#A0A0A6", .7) + " 0%," + hexRgba("#7C7C82", .55) + " 50%," + hexRgba("#4A4A50", .7) + " 100%)"
        : "linear-gradient(150deg,#A0A0A6 0%,#7C7C82 50%,#4A4A50 100%)";
      this._setModeClass("idle");
      this._applyAnimation();
      this._syncLiquid(false, ["#A0A0A6", "#7C7C82", "#4A4A50"]);
      this._tEls.big.innerHTML = `<span class="unavail">${s ? s.state : "not found"}</span>`;
      this._tEls.sub.textContent = this._config.entity;
      return;
    }

    const [c0, c1, c2] = this._tileShade;
    const glass = this._config.glass !== false;
    this._tEls.bg.classList.toggle("glass", glass);
    // Middle stop most transparent: the tint holds its colour at the edges and
    // lets the dashboard show through the centre - that is the liquid look.
    const s0 = glass ? hexRgba(c0, .58) : c0;
    const s1 = glass ? hexRgba(c1, .40) : c1;
    const s2 = glass ? hexRgba(c2, .58) : c2;
    this._tEls.bg.style.backgroundImage =
      `linear-gradient(150deg, ${s0} 0%, ${s1} 45%, ${s2} 100%)`;
    this._syncLiquid(glass, [c0, c1, c2]);
    this._setModeClass(this._rampKey);
    this._applyAnimation();

    // Current temperature is the glanceable number, as on the Home tile.
    const cur = s.attributes.current_temperature;
    this._tEls.big.innerHTML = cur != null
      ? `${Number(cur).toFixed(0)}<sup>${unit}</sup>`
      : "--";

    const v = this._values;
    const dp = this._step < 1 ? 1 : 0;
    const mode = MODE_LABEL[s.state] || s.state;
    let target = "";
    if (v && v.t !== undefined) target = ` to ${v.t.toFixed(dp)}${unit}`;
    else if (v) target = ` ${v.low.toFixed(dp)}–${v.high.toFixed(dp)}${unit}`;
    this._tEls.sub.textContent = s.state === "off" ? "Off" : mode + target;
  }

  /* ---------- liquid renderer ---------- */

  _lqSupported() {
    if (this._lqOk !== undefined) return this._lqOk;
    try {
      const c = document.createElement("canvas");
      this._lqOk = !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch (e) { this._lqOk = false; }
    return this._lqOk;
  }

  _syncLiquid(on, cols) {
    const want = on && this._config.liquid !== false && this._lqSupported();
    this._tEls.bg.classList.toggle("liquid", want);
    if (!want) { this._lqStop(); return; }
    const key = this._rampKey;
    const o = LQ_ORBS[key] || LQ_ORBS.idle;
    this._lqCols = { c0: hexV(cols[0]), c1: hexV(cols[1]), c2: hexV(cols[2]),
                     o1: hexV(o[0]), o2: hexV(o[1]), o3: hexV(o[2]) };
    this._lqTempo = key === "heat" ? 0.62 : 1.0;
    this._lqStart();
    this._lqKick();
  }

  _lqStart() {
    if (this._lq) return;
    const canvas = this._tEls.lq;
    let gl = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false })
        || canvas.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: true });
    } catch (e) { /* fall through to css glass */ }
    if (!gl) { this._lqOk = false; this._tEls.bg.classList.remove("liquid"); return; }
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("haptic-thermostat-card: shader compile failed", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const v = mk(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    const f = mk(gl.FRAGMENT_SHADER, LQ_FRAG);
    if (!v || !f) { this._lqOk = false; this._tEls.bg.classList.remove("liquid"); return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this._lqOk = false;
      this._tEls.bg.classList.remove("liquid");
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const U = {};
    for (const nm of ["u_res", "u_t", "u_rad", "u_dpr", "u_tempo",
                      "u_c0", "u_c1", "u_c2", "u_o1", "u_o2", "u_o3", "u_seed"]) {
      U[nm] = gl.getUniformLocation(prog, nm);
    }
    this._lq = { gl, U, canvas, t0: performance.now(), raf: 0,
                 visible: !document.hidden, onscreen: true, dpr: 1, rad: 12 };
    // Battery guards: no frames while the tab is hidden or the card has
    // scrolled out of view. A single static frame is drawn on re-entry.
    this._lqVis = () => {
      if (this._lq) { this._lq.visible = !document.hidden; this._lqKick(); }
    };
    document.addEventListener("visibilitychange", this._lqVis);
    this._lqIO = new IntersectionObserver((es) => {
      if (this._lq) { this._lq.onscreen = es[0].isIntersecting; this._lqKick(); }
    });
    this._lqIO.observe(this);
    this._lqRO = new ResizeObserver(() => this._lqSize());
    this._lqRO.observe(canvas);
    this._lqSize();
  }

  _lqSize() {
    const L = this._lq;
    if (!L) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(L.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(L.canvas.clientHeight * dpr));
    if (L.canvas.width !== w || L.canvas.height !== h) {
      L.canvas.width = w;
      L.canvas.height = h;
      L.gl.viewport(0, 0, w, h);
    }
    L.dpr = dpr;
    L.rad = (parseFloat(getComputedStyle(this._tEls.bg).borderRadius) || 12) * dpr;
    this._lqFrame();
  }

  _lqKick() {
    const L = this._lq;
    if (!L) return;
    cancelAnimationFrame(L.raf);
    if (!L.visible || !L.onscreen) return;
    const spd = Number(this._config.animation_speed);
    const animOn = this._config.animation !== false && spd !== 0;
    const loop = () => {
      this._lqFrame();
      if (animOn && this._lq) L.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  _lqFrame() {
    const L = this._lq;
    if (!L || !this._lqCols) return;
    const gl = L.gl, U = L.U;
    const spd = Number(this._config.animation_speed);
    const scale = 10 / (spd > 0 ? spd : 10);
    const animOn = this._config.animation !== false && spd !== 0;
    const t = animOn
      ? ((performance.now() - L.t0) / 1000) * scale
      : 3.7 + this._lqSeed[3] * 20.0;
    gl.uniform2f(U.u_res, L.canvas.width, L.canvas.height);
    gl.uniform1f(U.u_t, t);
    gl.uniform1f(U.u_rad, L.rad);
    gl.uniform1f(U.u_dpr, L.dpr);
    gl.uniform1f(U.u_tempo, this._lqTempo || 1);
    const C = this._lqCols;
    gl.uniform3fv(U.u_c0, C.c0);
    gl.uniform3fv(U.u_c1, C.c1);
    gl.uniform3fv(U.u_c2, C.c2);
    gl.uniform3fv(U.u_o1, C.o1);
    gl.uniform3fv(U.u_o2, C.o2);
    gl.uniform3fv(U.u_o3, C.o3);
    gl.uniform4fv(U.u_seed, this._lqSeed);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _lqStop() {
    if (this._lqIO) { this._lqIO.disconnect(); this._lqIO = null; }
    if (this._lqRO) { this._lqRO.disconnect(); this._lqRO = null; }
    if (this._lqVis) {
      document.removeEventListener("visibilitychange", this._lqVis);
      this._lqVis = null;
    }
    if (this._lq) {
      cancelAnimationFrame(this._lq.raf);
      const ext = this._lq.gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
      this._lq = null;
    }
  }


  /* ---------- panel (the expanded dial) ---------- */

  openPanel() {
    if (this._panel || !this._s) return;
    haptic("light");

    // Appended to document.body on purpose. position:fixed is relative to the
    // nearest ancestor with a transform/filter/perspective, and HA's layouts
    // sometimes have one - anchoring here is the only reliable way to cover the
    // viewport. Its own shadow root keeps HA styles out and ours in.
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    const g = this._gradId;
    host.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; display: block; }
        /* The blur lives on a child, not on .back. Animating opacity on an
         * element that also carries backdrop-filter is a known WebKit trap - the
         * transition gets dropped or renders badly. Separating them keeps the
         * animated property plain. pointer-events:none so backdrop clicks still
         * land on .back. */
        .back {
          position: fixed; inset: 0; z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          opacity: 0; transition: opacity .56s ease; will-change: opacity;
          font-family: var(--ha-font-family-body, system-ui, -apple-system, sans-serif);
        }
        .back.in { opacity: 1; }
        .blur {
          position: absolute; inset: 0; pointer-events: none;
          background: rgba(0,0,0,.55);
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
          opacity: 0; transition: opacity .56s ease;
        }
        .back.in .blur { opacity: 1; }
        /* Straight cross-fade, no scale/pop - backdrop and panel share the same
         * duration and easing so open and close read as one movement. */
        .panel {
          width: min(86vw, 78vh, 460px);
          background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
          color: var(--primary-text-color, #fff);
          border-radius: 30px;
          padding: 20px 18px 18px;
          box-shadow: 0 24px 70px rgba(0,0,0,.6);
          opacity: 0;
          transition: opacity .56s ease; will-change: opacity;
          display: flex; flex-direction: column; align-items: center;
        }
        .back.in .panel { opacity: 1; }
        .hdr {
          width: 100%; display: flex; align-items: center;
          justify-content: space-between; margin-bottom: 2px;
        }
        .ttl { font-size: 17px; font-weight: 600; letter-spacing: .2px; }
        .x {
          border: 0; cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
          background: var(--divider-color, #3a3a3c); color: inherit;
          font-size: 17px; line-height: 1; display: grid; place-items: center;
        }
        .wrap { position: relative; width: 100%; margin-bottom: -14%; }
        svg.dial { width: 100%; height: auto; display: block; touch-action: none; }
        .track { stroke: var(--divider-color, #3a3a3c); opacity: .4; }
        .centre {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          pointer-events: none; text-align: center;
        }
        .mode {
          font-size: 14px; font-weight: 600; text-transform: capitalize;
          letter-spacing: .4px; opacity: .9;
        }
        .target {
          font-size: 64px; font-weight: 300; line-height: 1.02;
          font-feature-settings: "tnum";
        }
        .target sup { font-size: 23px; font-weight: 400; vertical-align: super; }
        .target.range { font-size: 38px; font-weight: 400; }
        .target.range sup { font-size: 16px; }
        .target .lo { color: #FF9F0A; } .target .hi { color: #4C9BFF; }
        .target .dash { opacity: .45; margin: 0 6px; font-weight: 300; }
        /* Positioned above the dial, explicitly. .wrap is position:relative,
         * and positioned elements hit-test ABOVE static siblings regardless of
         * DOM order - so the footer, pulled up into the dial's box by the
         * negative margin, was visible through the SVG's transparent bottom gap
         * but untappable: every tap on the mode pill landed on the SVG instead.
         * That is why mode changes never registered. */
        .foot {
          position: relative; z-index: 2;
          display: flex; align-items: center; justify-content: center;
          gap: 14px; flex-wrap: wrap; width: 100%;
        }
        .cur { font-size: 15px; font-weight: 500; opacity: .7; }
        .sel {
          font: inherit; font-size: 14px; font-weight: 600; letter-spacing: .3px;
          -webkit-appearance: none; appearance: none; border: 0; cursor: pointer;
          border-radius: 17px; padding: 8px 32px 8px 17px; color: #fff;
          transition: background .25s ease;
          background-repeat: no-repeat; background-position: right 12px center;
          background-size: 11px;
          background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 8"><path d="M1 1.5L6 6.5L11 1.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        }
        .sel:focus { outline: none; }
        .sel option { color: initial; background: initial; font-weight: 500; }
      </style>
      <div class="back">
        <div class="blur"></div>
        <div class="panel" role="dialog" aria-modal="true">
          <div class="hdr"><div class="ttl"></div><button class="x" aria-label="Close">✕</button></div>
          <div class="wrap">
            <svg class="dial" viewBox="0 0 200 200" aria-label="Temperature dial">
              <defs>
                <linearGradient id="${g}" gradientUnits="userSpaceOnUse"
                                x1="26" y1="174" x2="174" y2="26"></linearGradient>
              </defs>
              <path class="track" fill="none" stroke-width="${STROKE}" stroke-linecap="round"></path>
              <path class="value" fill="none" stroke-width="${STROKE}" stroke-linecap="round"
                    stroke="url(#${g})"></path>
              <circle class="knob knob-lo" r="0" fill="#fff"></circle>
              <circle class="knob knob-hi" r="0" fill="#fff"></circle>
            </svg>
            <div class="centre"><div class="mode"></div><div class="target"></div></div>
          </div>
          <div class="foot"><div class="cur"></div><select class="sel" aria-label="HVAC mode"></select></div>
        </div>
      </div>
    `;
    document.body.appendChild(host);
    this._panel = host;

    const q = (s2) => host.shadowRoot.querySelector(s2);
    this._pEls = {
      back: q(".back"), panel: q(".panel"), ttl: q(".ttl"),
      svg: q("svg.dial"), track: q(".track"), value: q(".value"),
      knobLo: q(".knob-lo"), knobHi: q(".knob-hi"),
      mode: q(".mode"), target: q(".target"), cur: q(".cur"),
      sel: q(".sel"), grad: q("linearGradient"),
    };
    this._appliedRamp = null;
    this._appliedModes = null;

    q(".x").addEventListener("click", () => this.closePanel());
    // Backdrop only - a click inside the panel must not close it.
    // The null guard matters: a click on the ✕ closes the panel and THEN bubbles
    // to this handler, by which point _pEls is already null. Without the guard
    // that threw a TypeError mid-close.
    this._pEls.back.addEventListener("click", (e) => {
      if (this._pEls && e.target === this._pEls.back) this.closePanel();
    });
    this._pEls.sel.addEventListener("change", (e) => this._setMode(e.target.value));

    const svg = this._pEls.svg;
    svg.addEventListener("pointerdown", (e) => this._down(e));
    svg.addEventListener("pointermove", (e) => this._move(e));
    svg.addEventListener("pointerup", (e) => this._up(e));
    svg.addEventListener("pointercancel", (e) => this._up(e));

    document.addEventListener("keydown", this._onKey);
    this._prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    this._renderDial(this._pEls);

    // Force a style flush before flipping the class. A freshly inserted element
    // has no computed style yet, so setting the final state in the same frame
    // makes the browser skip straight to it and no transition runs. Reading a
    // layout property is the reliable way to commit the initial state first -
    // a single requestAnimationFrame is not enough here.
    void this._pEls.back.offsetWidth;
    this._pEls.back.classList.add("in");
  }

  closePanel() {
    if (!this._panel) return;
    const host = this._panel;
    const back = this._pEls && this._pEls.back;
    this._panel = null;
    this._pEls = null;
    this._dragging = false;
    this._pending = null;
    document.removeEventListener("keydown", this._onKey);
    document.body.style.overflow = this._prevOverflow || "";
    // Remove only after the fade-out has finished, or it vanishes instantly.
    if (back) back.classList.remove("in");
    setTimeout(() => host.remove(), 620);   // must outlast the .56s fade
  }

  /* ---------- interaction ---------- */

  _geom(evt) {
    const r = this._pEls.svg.getBoundingClientRect();
    const x = ((evt.clientX - r.left) / r.width) * 200 - 100;
    const y = ((evt.clientY - r.top) / r.height) * 200 - 100;
    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (deg < START_ANGLE) deg += 360;
    return { dist: Math.hypot(x, y), rawFrac: (deg - START_ANGLE) / SWEEP };
  }

  _tempFromPointer(evt) {
    const frac = clamp(this._geom(evt).rawFrac, 0, 1);
    const raw = this._min + frac * (this._max - this._min);
    return clamp(Math.round(raw / this._step) * this._step, this._min, this._max);
  }

  _down(evt) {
    const s = this._s;
    if (!s || s.state === "unavailable") return;
    const v = this._values;
    if (!v) return;
    // Only begin a drag if the touch actually lands on the ring. The SVG is a
    // full-width rectangle, and without this guard a tap in its empty bottom
    // gap - exactly where the mode selector sits, pulled up by the negative
    // margin - mapped to ~90deg, wrapped past the end of the sweep, clamped to
    // frac=1 and slammed the setpoint to MAX on release. A radial band around
    // the ring plus a small angular tolerance keeps ring taps and end-stop
    // grabs working while ignoring everything else.
    const g = this._geom(evt);
    if (Math.abs(g.dist - R) > 34 || g.rawFrac < -0.06 || g.rawFrac > 1.06) return;
    this._dragging = true;
    this._pEls.svg.setPointerCapture(evt.pointerId);
    this._lastHapticStep = null;
    if (v.t !== undefined) {
      this._activeHandle = "t";
    } else {
      const t = this._tempFromPointer(evt);
      this._activeHandle = Math.abs(t - v.low) <= Math.abs(t - v.high) ? "low" : "high";
    }
    this._pending = Object.assign({}, v);
    this._move(evt);
  }

  _move(evt) {
    if (!this._dragging) return;
    evt.preventDefault();
    let t = this._tempFromPointer(evt);
    const p = this._pending;
    const step = this._step;
    if (this._activeHandle === "t") {
      if (p.t === t) return;
      p.t = t;
    } else if (this._activeHandle === "low") {
      t = Math.min(t, p.high - step);          // keep the handles from crossing
      if (p.low === t) return;
      p.low = t;
    } else {
      t = Math.max(t, p.low + step);
      if (p.high === t) return;
      p.high = t;
    }
    if (this._lastHapticStep !== t) {
      haptic("selection");                      // one tick per step crossed
      this._lastHapticStep = t;
    }
    this._renderDial(this._pEls);
  }

  _up(evt) {
    if (!this._dragging) return;
    this._dragging = false;
    try { this._pEls.svg.releasePointerCapture(evt.pointerId); } catch (e) { /* gone */ }
    const p = this._pending;
    const h = this._activeHandle;
    this._pending = null;
    this._activeHandle = null;
    const s = this._s;
    if (!p || !s) return;
    // Commit on release: a drag fires dozens of moves, and calling the service on
    // each makes the thermostat lag and the ring fight your finger.
    let data;
    if (h === "t") {
      if (Number(s.attributes.temperature) === p.t) return;
      data = { temperature: p.t };
    } else {
      if (Number(s.attributes.target_temp_low) === p.low &&
          Number(s.attributes.target_temp_high) === p.high) return;
      data = { target_temp_low: p.low, target_temp_high: p.high };
    }
    haptic("light");
    this._hass.callService("climate", "set_temperature",
      Object.assign({ entity_id: this._config.entity }, data));
  }

  _setMode(mode) {
    haptic("light");
    this._hass.callService("climate", "set_hvac_mode",
      { entity_id: this._config.entity, hvac_mode: mode });
  }

  _applyRamp(key, els) {
    if (this._appliedRamp === key) return;
    this._appliedRamp = key;
    const g = els.grad;
    while (g.firstChild) g.removeChild(g.firstChild);
    for (const [o, c] of RAMPS[key]) {
      const st = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      st.setAttribute("offset", `${o * 100}%`);
      st.setAttribute("stop-color", c);
      g.appendChild(st);
    }
  }

  /* Rebuilt only when the available list changes - rebuilding mid-gesture would
   * close the picker under the user's finger. */
  _applyModes(modes, els) {
    const key = modes.join("|");
    if (this._appliedModes === key) return;
    this._appliedModes = key;
    els.sel.textContent = "";
    for (const m of modes) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = MODE_LABEL[m] || m.replace(/_/g, " ");
      els.sel.appendChild(o);
    }
  }

  /* ---------- dial render ---------- */

  _renderDial(els) {
    const s = this._s;
    if (!els || !s) return;
    els.ttl.textContent =
      this._config.name ?? s.attributes.friendly_name ?? this._config.entity;

    if (s.state === "unavailable" || s.state === "unknown") {
      els.mode.textContent = "";
      els.target.textContent = s.state;
      els.value.setAttribute("d", "");
      els.knobLo.setAttribute("r", "0");
      els.knobHi.setAttribute("r", "0");
      els.sel.style.display = "none";
      return;
    }

    const v = this._values;
    const key = this._rampKey;
    const deep = RAMPS[key][0][1];
    const unit = this._hass.config.unit_system.temperature || "°";
    const dp = this._step < 1 ? 1 : 0;

    this._applyRamp(key, els);
    els.track.setAttribute("d", arcPath(100, 100, R, START_ANGLE, START_ANGLE + SWEEP));

    if (!v) {
      els.value.setAttribute("d", "");
      els.knobLo.setAttribute("r", "0");
      els.knobHi.setAttribute("r", "0");
      els.target.textContent = "--";
      els.target.classList.remove("range");
    } else if (v.t !== undefined) {
      const end = this._angleFor(v.t);
      els.value.setAttribute("d", arcPath(100, 100, R, START_ANGLE, end));
      els.grad.setAttribute("x1", 26); els.grad.setAttribute("y1", 174);
      els.grad.setAttribute("x2", 174); els.grad.setAttribute("y2", 26);
      const k = polar(100, 100, R, end);
      els.knobLo.setAttribute("r", "0");
      els.knobHi.setAttribute("cx", k.x); els.knobHi.setAttribute("cy", k.y);
      els.knobHi.setAttribute("r", "10");
      els.target.classList.remove("range");
      els.target.innerHTML = `${v.t.toFixed(dp)}<sup>${unit}</sup>`;
    } else {
      const aLo = this._angleFor(v.low), aHi = this._angleFor(v.high);
      els.value.setAttribute("d", arcPath(100, 100, R, aLo, aHi));
      const kLo = polar(100, 100, R, aLo), kHi = polar(100, 100, R, aHi);
      // point the ramp at the handles so warm->cool lands across the band
      els.grad.setAttribute("x1", kLo.x); els.grad.setAttribute("y1", kLo.y);
      els.grad.setAttribute("x2", kHi.x); els.grad.setAttribute("y2", kHi.y);
      els.knobLo.setAttribute("cx", kLo.x); els.knobLo.setAttribute("cy", kLo.y);
      els.knobLo.setAttribute("r", "10");
      els.knobHi.setAttribute("cx", kHi.x); els.knobHi.setAttribute("cy", kHi.y);
      els.knobHi.setAttribute("r", "10");
      els.target.classList.add("range");
      els.target.innerHTML =
        `<span class="lo">${v.low.toFixed(dp)}</span><span class="dash">–</span>` +
        `<span class="hi">${v.high.toFixed(dp)}</span><sup>${unit}</sup>`;
    }

    const act = s.attributes.hvac_action;
    els.mode.textContent = act ? act : s.state;
    els.mode.style.color = deep;

    const cur = s.attributes.current_temperature;
    els.cur.textContent = cur != null ? `Currently ${Number(cur).toFixed(1)}${unit}` : "";

    const modes = this._config.modes === false ? [] : (s.attributes.hvac_modes || []);
    this._applyModes(modes, els);
    els.sel.style.display = modes.length ? "" : "none";
    if (els.sel.value !== s.state && document.activeElement !== this._panel) {
      els.sel.value = s.state;
    }
    els.sel.style.backgroundColor = deep;   // colour only, so the chevron survives
  }
}

customElements.define("haptic-thermostat-card", HapticThermostatCard);

/* ------------------------------------------------------------------ */
/* haptic-temp-pill: a compact glass pill for temperature sensors.
 * Same material and choreography family as the thermostat tile, but the
 * colour comes from the TEMPERATURE itself on a thermal scale, not from
 * HVAC mode. Tapping opens the entity's more-info dialog, with a haptic. */

/* Thermal anchors, in Fahrenheit; values between anchors interpolate in RGB
 * and values beyond the ends clamp. Sensors reporting Celsius are converted
 * for the mapping only - the displayed value keeps its own unit. */
const THERMAL = [
  [50, "#0B5FD0"],
  [62, "#0A84FF"],
  [70, "#32ADE6"],
  [75, "#FFB800"],
  [82, "#FF6B00"],
  [90, "#D93E00"],
];

const mixHex = (h1, h2, t) => {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const ch = (sh) => Math.round(((a >> sh) & 255) + (((b >> sh) & 255) - ((a >> sh) & 255)) * t);
  return "#" + ((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1);
};

const thermalColor = (f) => {
  if (f <= THERMAL[0][0]) return THERMAL[0][1];
  for (let i = 1; i < THERMAL.length; i++) {
    if (f <= THERMAL[i][0]) {
      const [t0, c0] = THERMAL[i - 1];
      const [t1, c1] = THERMAL[i];
      return mixHex(c0, c1, (f - t0) / (t1 - t0));
    }
  }
  return THERMAL[THERMAL.length - 1][1];
};

class HapticTempPill extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("haptic-temp-pill: 'entity' is required");
    }
    this._config = Object.assign(
      { name: null, animation: true, animation_speed: 10, glass: true },
      config
    );
    this._built = false;
  }

  getCardSize() { return 1; }

  /* The sections grid sizes cards by what they DECLARE, not by their content -
   * without this, an unknown custom card is guessed at 2 rows and no amount of
   * CSS slimming changes the box. Both spellings for API compatibility. */
  getGridOptions() { return { rows: 1, columns: 6, min_rows: 1 }; }
  getLayoutOptions() { return { grid_rows: 1, grid_columns: 6, grid_min_rows: 1 }; }

  static getStubConfig() { return { entity: "" }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._render();
  }

  get _s() {
    return this._hass && this._config ? this._hass.states[this._config.entity] : undefined;
  }

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card {
          position: relative; overflow: hidden;
          height: 100%; box-sizing: border-box;
          border: none; padding: 0;
          background: transparent;
          cursor: pointer;
          transition: transform .18s ease, filter .18s ease;
          color: #fff;
        }
        ha-card:active { transform: scale(.97); filter: brightness(1.08); }
        .bg {
          position: absolute; inset: 0; isolation: isolate;
          border-radius: var(--ha-card-border-radius, var(--ha-border-radius-lg, 12px));
        }
        .bg.glass {
          backdrop-filter: blur(26px) saturate(1.8) brightness(1.06);
          -webkit-backdrop-filter: blur(26px) saturate(1.8) brightness(1.06);
        }
        .bg.glass::after {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          z-index: 1;
          border-radius: inherit;
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.30),
            inset 0 0 7px 2px rgba(255,255,255,.13),
            inset 0 1.5px 1px rgba(255,255,255,.28);
        }
        .bg.glass::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          z-index: 1;
          border-radius: inherit;
          background: linear-gradient(180deg,
            rgba(255,255,255,.20) 0%,
            rgba(255,255,255,.05) 45%,
            rgba(255,255,255,.10) 100%);
        }
        .blob {
          position: absolute; width: 170%; aspect-ratio: 1;
          border-radius: 50%;
          background: radial-gradient(circle, var(--c) 0%, transparent 68%);
          mix-blend-mode: screen; opacity: .95;
          will-change: transform;
        }
        .p1 { top: -140%; left: -40%; animation: pfloat1 calc(var(--drift-speed, 10s) * 1.0 * var(--r, 1)) ease-in-out infinite alternate; }
        .p2 {
          bottom: -150%; right: -35%;
          mix-blend-mode: multiply; opacity: .6;
          animation: pfloat2 calc(var(--drift-speed, 10s) * 1.5 * var(--r, 1)) ease-in-out infinite alternate;
        }
        @keyframes pfloat1 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          100% { transform: translate3d(26%, 14%, 0) scale(1.1); }
        }
        @keyframes pfloat2 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          100% { transform: translate3d(-22%, -12%, 0) scale(.95); }
        }
        .sheen {
          position: absolute; top: -30%; bottom: -30%; width: 85%;
          background: linear-gradient(115deg,
            transparent 0%,
            rgba(255,255,255,.05) 20%,
            rgba(255,255,255,.10) 45%,
            rgba(255,255,255,.24) 80%,
            rgba(255,255,255,.08) 92%,
            transparent 100%);
          filter: blur(8px);
          transform: translateX(-260%) skewX(-18deg);
          mix-blend-mode: screen;
          animation: psheen calc(var(--drift-speed, 10s) * 2.4 * var(--r, 1)) linear infinite;
          will-change: transform;
        }
        @keyframes psheen {
          0%, 62% { transform: translateX(-260%) skewX(-18deg); }
          100%    { transform: translateX(300%) skewX(-18deg); }
        }
        .bg.no-anim .blob, .bg.no-anim .sheen { animation: none; }
        @media (prefers-reduced-motion: reduce) {
          .blob, .sheen { animation: none; }
        }
        .content {
          position: relative; z-index: 1;
          height: 100%; box-sizing: border-box;
          display: flex; align-items: center; gap: 12px;
          padding: 8px 14px;
        }
        .ic {
          width: 34px; height: 34px; border-radius: 50%; flex: none;
          background: rgba(255,255,255,.22);
          display: grid; place-items: center;
          transition: background .45s ease;
        }
        .ic svg {
          width: 19px; height: 19px; fill: #fff;
          transition: fill .45s ease, filter .45s ease;
        }
        .tx { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
        .nm {
          font-size: 15px; font-weight: 600; letter-spacing: .2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          text-shadow: 0 1px 2px rgba(0,0,0,.18);
        }
        .vl {
          font-size: 13px; font-weight: 500; opacity: .95;
          font-feature-settings: "tnum";
          text-shadow: 0 1px 2px rgba(0,0,0,.18);
        }
      </style>
      <ha-card>
        <div class="bg">
          <div class="blob p1"></div>
          <div class="blob p2"></div>
          <div class="sheen"></div>
        </div>
        <div class="content">
          <div class="ic">
            <svg viewBox="0 0 24 24"><path d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0zm-3-9a1 1 0 0 1 1 1v8.6l.5.3a3 3 0 1 1-3 0l.5-.3V5a1 1 0 0 1 1-1z"/></svg>
          </div>
          <div class="tx">
            <div class="nm"></div>
            <div class="vl"></div>
          </div>
        </div>
      </ha-card>
    `;
    this._els = {
      card: this.shadowRoot.querySelector("ha-card"),
      bg: this.shadowRoot.querySelector(".bg"),
      nm: this.shadowRoot.querySelector(".nm"),
      vl: this.shadowRoot.querySelector(".vl"),
      ic: this.shadowRoot.querySelector(".ic"),
      icSvg: this.shadowRoot.querySelector(".ic svg"),
    };
    // Same de-looping as the tile: random tempo, mid-phase start, direction.
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (const sel of [".p1", ".p2", ".sheen"]) {
      const el = this.shadowRoot.querySelector(sel);
      el.style.setProperty("--r", rnd(0.82, 1.28).toFixed(3));
      el.style.animationDelay = "-" + rnd(0, 30).toFixed(2) + "s";
      if (sel !== ".sheen" && Math.random() < 0.5) {
        el.style.animationDirection = "alternate-reverse";
      }
    }
    this._els.card.addEventListener("click", () => {
      haptic("light");
      fireEvent(this, "hass-more-info", { entityId: this._config.entity });
    });
  }

  _render() {
    if (!this._els) return;
    const s = this._s;
    const glass = this._config.glass !== false;
    const bg = this._els.bg;
    bg.classList.toggle("glass", glass);

    const spd = Number(this._config.animation_speed);
    const on = this._config.animation !== false && spd !== 0;
    bg.classList.toggle("no-anim", !on);
    if (on) bg.style.setProperty("--drift-speed", (spd > 0 ? spd : 10) + "s");

    this._els.nm.textContent =
      this._config.name ?? (s ? s.attributes.friendly_name : this._config.entity);

    const raw = s ? parseFloat(s.state) : NaN;
    if (!s || isNaN(raw)) {
      bg.style.backgroundImage = glass
        ? "linear-gradient(150deg," + hexRgba("#A0A0A6", .58) + " 0%," + hexRgba("#7C7C82", .40) + " 45%," + hexRgba("#4A4A50", .58) + " 100%)"
        : "linear-gradient(150deg,#A0A0A6 0%,#7C7C82 45%,#4A4A50 100%)";
      this._els.vl.textContent = s ? s.state : "not found";
      this._els.ic.style.background = "";
      this._els.icSvg.style.fill = "";
      this._els.icSvg.style.filter = "";
      return;
    }

    const unit = (s.attributes.unit_of_measurement || "").trim();
    // Map on Fahrenheit; display in whatever the sensor reports.
    const f = unit.indexOf("C") >= 0 ? raw * 9 / 5 + 32 : raw;
    const base = thermalColor(f);
    const c0 = mixHex(base, "#FFFFFF", 0.35);
    const c2 = mixHex(base, "#000000", 0.30);
    bg.style.backgroundImage = glass
      ? "linear-gradient(150deg," + hexRgba(c0, .58) + " 0%," + hexRgba(base, .40) + " 45%," + hexRgba(c2, .58) + " 100%)"
      : "linear-gradient(150deg," + c0 + " 0%," + base + " 45%," + c2 + " 100%)";

    const p1 = this.shadowRoot.querySelector(".p1");
    const p2 = this.shadowRoot.querySelector(".p2");
    p1.style.setProperty("--c", mixHex(base, "#FFFFFF", 0.55));
    p2.style.setProperty("--c", mixHex(base, "#000000", 0.45));

    // The icon wears the temperature too: a deep-shade glyph on a tinted frost
    // circle, with a soft glow in the thermal colour.
    this._els.ic.style.background = hexRgba(mixHex(base, "#FFFFFF", 0.30), 0.34);
    this._els.icSvg.style.fill = mixHex(base, "#000000", 0.38);
    this._els.icSvg.style.filter = "drop-shadow(0 0 5px " + hexRgba(base, 0.9) + ")";

    this._els.vl.textContent = raw.toFixed(1) + (unit ? " " + unit : "");
  }
}

customElements.define("haptic-temp-pill", HapticTempPill);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "haptic-temp-pill",
  name: "Haptic Temperature Pill",
  description:
    "Glass temperature pill whose colour follows the reading - blue when cold, red when hot.",
  preview: true,
});
window.customCards.push({
  type: "haptic-thermostat-card",
  name: "Haptic Thermostat Card",
  description:
    "Square temperature tile that expands into an iOS-style dial, with haptic feedback on the companion app.",
  preview: true,
});

console.info(
  `%c HAPTIC-THERMOSTAT-CARD %c v${VERSION} `,
  "color:#fff;background:#0A84FF;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "color:#0A84FF;background:#1c1c1e;border-radius:0 3px 3px 0;padding:2px 4px"
);
