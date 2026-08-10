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

const VERSION = "3.3.9";

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
    // Locking body scroll removes the desktop scrollbar, which widens the
    // viewport and shifts the whole page sideways for the panel's lifetime.
    // Measure the scrollbar and hold its width as padding so nothing moves.
    const sw = window.innerWidth - document.documentElement.clientWidth;
    this._prevOverflow = document.body.style.overflow;
    this._prevPadR = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (sw > 0) document.body.style.paddingRight = sw + "px";

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
    document.body.style.paddingRight = this._prevPadR || "";
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
/* Blues hold to 75.5F, then warmth starts at 76: a ONE-degree blend into
 * amber - kept razor thin because RGB interpolation between cyan and amber
 * passes through sage green, so no reading may live inside the window.
 * Orange intensity climbs 76-90, redder beyond, deep red clamps from 96F. */
const THERMAL = [
  [50, "#0B5FD0"],
  [66, "#0A84FF"],
  [75.5, "#32ADE6"],
  [76.5, "#FFB800"],
  [82, "#FF8A00"],
  [90, "#FF5A00"],
  [96, "#D93E00"],
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

/* ------------------------------------------------------------------ */
/* haptic-media-card: a glass media controller.
 * The stock media-control card falls back to a flat accent panel with a
 * placeholder glyph when the cast session provides no artwork - which is
 * every YouTube session. This renders the same glass material as the rest
 * of the suite, tinted by the APP that is playing, with a live progress
 * bar and haptic transport controls. When artwork does exist it becomes a
 * blurred backdrop under the glass. */

const APP_ACCENTS = {
  youtube: "#E62117",
  "youtube music": "#FF0000",
  plex: "#E5A00D",
  spotify: "#1DB954",
  netflix: "#B00610",
  "prime video": "#00A8E1",
  hulu: "#1CE783",
  disney: "#0063E5",
};

/* Brand glyphs for the no-artwork fallback, inlined so the card keeps its
 * zero-network-dependency property. Real artwork always wins the slot. */
const APP_LOGOS = {
  youtube: { d: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z", c: "#E23022", w: 34 },
  netflix: { d: "M5.398 0v.006c3.028 8.556 5.37 15.175 8.348 23.596 2.344.058 4.85.398 4.854.398-2.8-7.924-5.923-16.747-8.487-24zm8.489 0v9.63L18.6 22.951c-.043-7.86-.004-15.913.002-22.95zM5.398 1.05V24c1.873-.225 2.81-.312 4.715-.398v-9.22z", c: "#E50914", w: 30 },
  spotify: { d: "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z", c: "#1DB954", w: 34 },
  plex: { d: "M3.987 8.409c-.96 0-1.587.28-2.12.933v-.72H0v8.88s.038.018.127.037c.138.03.821.187 1.331-.249.441-.377.542-.814.542-1.318v-1.283c.533.573 1.147.813 2 .813 1.84 0 3.253-1.493 3.253-3.48 0-2.12-1.36-3.613-3.266-3.613Zm16.748 5.595.406.591c.391.614.894.906 1.492.908.621-.012 1.064-.562 1.226-.755 0 0-.307-.27-.686-.72-.517-.614-1.214-1.755-1.24-1.803l-1.198 1.779Zm-3.205-1.955c0-2.08-1.52-3.64-3.52-3.64s-3.467 1.587-3.467 3.573a3.48 3.48 0 0 0 3.507 3.52c1.413 0 2.626-.84 3.253-2.293h-2.04l-.093.093c-.427.4-.72.533-1.227.533-.787 0-1.373-.506-1.453-1.266h4.986c.04-.214.054-.307.054-.52Zm-7.671-.219c0 .769.11 1.701.868 2.722l.056.069c-.306.526-.742.88-1.248.88-.399 0-.814-.211-1.138-.579a2.177 2.177 0 0 1-.538-1.441V6.409H9.86l-.001 5.421Zm9.283 3.46h-2.39l2.247-3.332-2.247-3.335h2.39l2.248 3.335-2.248 3.332Zm1.593-1.286Zm-17.162-.342c-.933 0-1.68-.773-1.68-1.72s.76-1.666 1.68-1.666c.92 0 1.68.733 1.68 1.68 0 .946-.733 1.706-1.68 1.706Zm18.361-1.974L24 8.622h-2.391l-.87 1.293 1.195 1.773Zm-9.404-.466c.16-.706.72-1.133 1.493-1.133.773 0 1.373.467 1.507 1.133h-3Z", c: "#E5A00D", w: 40 },
  hulu: { d: "M14.707 15.957h1.912V8.043h-1.912zm-3.357-2.256a.517.517 0 01-.512.511H9.727a.517.517 0 01-.512-.511v-3.19H7.303v3.345c0 1.368.879 2.09 2.168 2.09h1.868c1.189 0 1.912-.856 1.912-2.09V10.51h-1.912c.01 0 .01 3.09.01 3.19zm10.75-3.19v3.19a.517.517 0 01-.512.511h-1.112a.517.517 0 01-.511-.511v-3.19h-1.912v3.345c0 1.368.878 2.09 2.167 2.09h1.868c1.19 0 1.912-.856 1.912-2.09V10.51zm-18.32 0H2.557c-.434 0-.645.11-.645.11V8.044H0v7.903h1.9v-3.179c0-.278.234-.511.512-.511h1.112c.278 0 .511.233.511.511v3.19h1.912v-3.446c0-1.445-.967-2-2.167-2Z", c: "#1CE783", w: 44 },
  prime: { d: "M0 9.508c0-.043.01-.073.028-.09.018-.017.047-.025.086-.025h.329c.07 0 .112.034.127.101l.032.119c.091-.088.202-.159.33-.21a1.04 1.04 0 0 1 .396-.079c.294 0 .528.109.7.326.171.217.257.51.257.88 0 .254-.042.475-.127.665-.086.19-.201.335-.347.437a.85.85 0 0 1-.502.154c-.125 0-.243-.02-.355-.06a.857.857 0 0 1-.288-.164v1.003c0 .043-.008.073-.025.09-.017.016-.046.025-.09.025H.115c-.04 0-.068-.009-.086-.025-.019-.017-.028-.047-.028-.09zm1.113.32a.868.868 0 0 0-.447.124v1.206a.834.834 0 0 0 .447.124c.17 0 .296-.058.376-.174.081-.117.121-.3.121-.55 0-.254-.04-.439-.118-.555-.08-.116-.206-.174-.379-.174zm2.248-.087c.121-.134.236-.23.344-.286a.733.733 0 0 1 .345-.085h.063c.043 0 .073.009.092.025.018.017.027.047.027.09v.385c0 .04-.008.068-.025.087-.017.018-.046.027-.089.027a.923.923 0 0 1-.082-.004 1.369 1.369 0 0 0-.383.025c-.1.02-.186.045-.256.076v1.54c0 .04-.008.069-.025.087-.016.018-.046.028-.089.028h-.437c-.04 0-.069-.01-.087-.028-.018-.018-.028-.047-.028-.087V9.508c0-.043.01-.073.028-.09.018-.017.047-.025.087-.025h.328c.07 0 .112.034.128.1zm1.526-.71a.396.396 0 0 1-.278-.096.338.338 0 0 1-.105-.262c0-.11.035-.197.105-.26a.395.395 0 0 1 .278-.097c.116 0 .208.032.278.096.07.064.105.151.105.261a.34.34 0 0 1-.105.262.396.396 0 0 1-.278.096zm-.333.477c0-.043.01-.073.027-.09.019-.017.048-.025.087-.025h.438c.043 0 .072.008.089.025s.025.047.025.09v2.113c0 .04-.008.069-.025.087-.017.018-.046.028-.09.028h-.437c-.04 0-.068-.01-.087-.028-.018-.018-.027-.047-.027-.087zm1.837.11c.161-.107.306-.183.435-.227.13-.045.263-.067.4-.067.273 0 .466.098.579.294.155-.104.3-.18.438-.225.137-.046.278-.069.424-.069.213 0 .377.06.495.179.117.12.175.286.175.5v1.618c0 .04-.008.069-.025.087-.017.019-.046.027-.089.027h-.438c-.04 0-.068-.008-.086-.027-.018-.018-.028-.047-.028-.087V10.15c0-.208-.092-.312-.278-.312-.164 0-.33.04-.497.119v1.664c0 .04-.008.069-.025.087-.017.019-.046.027-.09.027h-.437c-.04 0-.068-.008-.086-.027-.019-.018-.028-.047-.028-.087V10.15c0-.208-.093-.312-.278-.312-.17 0-.337.04-.502.123v1.66c0 .04-.008.069-.025.087-.017.019-.046.027-.089.027h-.438c-.039 0-.068-.008-.086-.027-.018-.018-.027-.047-.027-.087V9.508c0-.043.009-.073.027-.09.018-.017.047-.025.086-.025h.329c.07 0 .112.034.128.101zm4.387 1.16a1.81 1.81 0 0 1-.451-.05c.018.204.08.35.185.44.105.088.263.132.476.132.085 0 .168-.005.249-.016a3.08 3.08 0 0 0 .362-.078.143.143 0 0 1 .023-.002c.052 0 .078.035.078.105v.211c0 .049-.007.083-.02.103a.169.169 0 0 1-.08.053 1.953 1.953 0 0 1-.708.128c-.377 0-.666-.103-.868-.312-.203-.207-.304-.505-.304-.893 0-.398.104-.71.31-.935.207-.227.494-.34.862-.34.283 0 .504.069.664.206a.69.69 0 0 1 .24.55c0 .23-.087.403-.258.52-.172.119-.425.177-.76.177zm.064-.99c-.292 0-.46.18-.506.54.122.025.257.037.406.037.155 0 .267-.024.337-.071.07-.047.105-.12.105-.218 0-.193-.114-.289-.342-.289zm2.948 1.946a.21.21 0 0 1-.075-.011.119.119 0 0 1-.05-.037.274.274 0 0 1-.038-.071l-.777-2.04a1.863 1.863 0 0 1-.023-.063.162.162 0 0 1-.009-.05c0-.047.03-.07.091-.07h.454c.049 0 .084.01.107.028.023.018.04.049.052.092l.468 1.622.477-1.622a.175.175 0 0 1 .052-.092c.023-.018.058-.027.107-.027h.44c.061 0 .091.022.091.068a.16.16 0 0 1-.009.05l-.022.065-.777 2.039a.274.274 0 0 1-.039.07.122.122 0 0 1-.047.038.207.207 0 0 1-.078.01zm2.02-2.703a.393.393 0 0 1-.277-.097.338.338 0 0 1-.105-.26c0-.11.035-.198.105-.262a.393.393 0 0 1 .277-.096c.115 0 .207.032.277.096.07.064.104.151.104.261 0 .11-.034.197-.104.261a.393.393 0 0 1-.277.097zm-.218 2.703c-.04 0-.068-.01-.086-.028-.019-.018-.028-.047-.028-.087V9.507c0-.043.01-.072.028-.09.018-.016.047-.024.086-.024h.436c.042 0 .072.008.089.025.016.017.024.046.024.09v2.111c0 .04-.008.07-.024.087-.017.019-.047.028-.09.028zm1.948.05a.869.869 0 0 1-.513-.153.97.97 0 0 1-.334-.426 1.6 1.6 0 0 1-.116-.63c0-.38.09-.682.268-.91a.856.856 0 0 1 .709-.341.98.98 0 0 1 .622.206V8.458c0-.043.01-.073.027-.09.018-.016.047-.025.087-.025h.436c.042 0 .071.009.088.025.017.017.025.047.025.09v3.161c0 .04-.008.07-.025.087-.017.019-.046.028-.088.028h-.364a.135.135 0 0 1-.084-.023.137.137 0 0 1-.043-.078l-.027-.105a.958.958 0 0 1-.668.256zm.218-.504a.762.762 0 0 0 .418-.128v-1.21a.872.872 0 0 0-.45-.114c-.16 0-.28.06-.358.18-.08.121-.118.304-.118.548 0 .245.041.426.124.546.084.119.212.178.384.178zm2.588-.51c-.169 0-.315-.016-.44-.05.018.201.078.345.18.432.103.087.257.13.465.13.083 0 .164-.005.242-.016a2.997 2.997 0 0 0 .354-.076.135.135 0 0 1 .022-.002c.05 0 .075.035.075.103v.207c0 .048-.007.082-.02.101a.165.165 0 0 1-.077.052 1.895 1.895 0 0 1-.69.126c-.367 0-.65-.102-.846-.306-.197-.204-.296-.496-.296-.876 0-.39.1-.695.302-.917.202-.222.482-.333.84-.333.276 0 .492.068.647.203a.678.678 0 0 1 .234.539c0 .225-.084.395-.251.51-.168.115-.415.173-.74.173zm.063-.97c-.285 0-.45.176-.494.53.119.024.25.036.396.036.15 0 .26-.024.329-.07.068-.046.102-.117.102-.213 0-.19-.111-.284-.333-.284zm2.442 2.003c-.36 0-.642-.11-.845-.328-.203-.218-.304-.523-.304-.914 0-.388.101-.691.304-.91.203-.218.485-.327.845-.327s.642.109.845.327c.203.219.304.522.304.91 0 .39-.101.696-.304.914-.203.218-.485.328-.845.328zm0-.514c.318 0 .477-.242.477-.728 0-.483-.16-.724-.477-.724-.318 0-.477.241-.477.724 0 .486.16.728.477.728zm-6.844 1.886c.405-.306.944-.408 1.39-.408.418 0 .756.09.828.185.15.2-.039 1.584-.775 2.244-.112.102-.22.047-.17-.087.166-.442.536-1.436.36-1.677-.175-.242-1.158-.115-1.6-.058-.068.008-.107-.02-.112-.061v-.023c.004-.036.03-.078.079-.115zm-10.184-.172a.105.105 0 0 1 .106-.091c.027 0 .057.009.089.028a11.778 11.778 0 0 0 6.194 1.772c1.52 0 3.19-.34 4.726-1.043.232-.105.426.164.2.346-1.371 1.09-3.359 1.67-5.07 1.67-2.397 0-4.557-.956-6.191-2.547a.173.173 0 0 1-.054-.097Z", c: "#00A8E1", w: 46 },
  directv: { img: "data:image/jpeg;base64,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", c: "#315CE9" },
};

const MFEAT = { PAUSE: 1, PREV: 16, NEXT: 32, TURN_ON: 128, TURN_OFF: 256, PLAY: 16384 };

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
};

class HapticMediaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._timer = 0;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("haptic-media-card: 'entity' is required");
    }
    if (config.entity.split(".")[0] !== "media_player") {
      throw new Error("haptic-media-card: entity must be a media_player.* entity");
    }
    this._config = Object.assign(
      { name: null, animation: true, animation_speed: 10, glass: true, accent: null },
      config
    );
    this._built = false;
  }

  getCardSize() { return 3; }
  getGridOptions() { return { rows: 3, columns: 12, min_rows: 2 }; }
  getLayoutOptions() { return { grid_rows: 3, grid_columns: 12, grid_min_rows: 2 }; }
  static getStubConfig() { return { entity: "" }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._render();
    this._syncTimer();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = 0;
  }

  get _s() {
    return this._hass && this._config ? this._hass.states[this._config.entity] : undefined;
  }

  _svc(service, extra) {
    haptic("light");
    this._hass.callService("media_player", service,
      Object.assign({ entity_id: this._config.entity }, extra || {}));
  }

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card {
          position: relative; overflow: hidden;
          height: 100%; box-sizing: border-box;
          border: none; padding: 0; background: transparent;
          color: #fff;
        }
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
          z-index: 2; border-radius: inherit;
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.30),
            inset 0 0 7px 2px rgba(255,255,255,.13),
            inset 0 1.5px 1px rgba(255,255,255,.28);
        }
        .bg.glass::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          z-index: 2; border-radius: inherit;
          background: linear-gradient(180deg,
            rgba(255,255,255,.18) 0%,
            rgba(255,255,255,.04) 45%,
            rgba(255,255,255,.09) 100%);
        }
        /* artwork backdrop, when the session provides one */
        .art {
          position: absolute; inset: -8%;
          background-size: cover; background-position: center;
          filter: blur(16px) brightness(.62) saturate(1.25);
          display: none;
        }
        .bg.hasart .art { display: block; }
        .bg.hasart .blob { opacity: .5; }
        .blob {
          position: absolute; width: 130%; aspect-ratio: 1;
          border-radius: 50%;
          background: radial-gradient(circle, var(--c) 0%, transparent 66%);
          mix-blend-mode: screen; opacity: .85;
          will-change: transform;
        }
        .m1 { top: -120%; left: -30%; animation: mfloat1 calc(var(--drift-speed, 10s) * .85 * var(--r, 1)) ease-in-out infinite alternate; }
        .m2 {
          bottom: -130%; right: -25%;
          mix-blend-mode: multiply; opacity: .55;
          animation: mfloat2 calc(var(--drift-speed, 10s) * 1.3 * var(--r, 1)) ease-in-out infinite alternate;
        }
        .m3 {
          top: -60%; right: 10%; width: 90%;
          opacity: .7;
          animation: mfloat1 calc(var(--drift-speed, 10s) * 1.05 * var(--r, 1)) ease-in-out infinite alternate-reverse;
        }
        .msheen {
          position: absolute; top: -30%; bottom: -30%; width: 85%;
          background: linear-gradient(115deg,
            transparent 0%,
            rgba(255,255,255,.05) 20%,
            rgba(255,255,255,.10) 45%,
            rgba(255,255,255,.22) 80%,
            rgba(255,255,255,.08) 92%,
            transparent 100%);
          filter: blur(9px);
          transform: translateX(-260%) skewX(-18deg);
          mix-blend-mode: screen;
          animation: msheenk calc(var(--drift-speed, 10s) * 2.2 * var(--r, 1)) linear infinite;
          will-change: transform;
        }
        @keyframes msheenk {
          0%, 58% { transform: translateX(-260%) skewX(-18deg); }
          100%    { transform: translateX(300%) skewX(-18deg); }
        }
        .bg.no-anim .msheen { animation: none; }
        @media (prefers-reduced-motion: reduce) { .msheen { animation: none; } }
        @keyframes mfloat1 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          100% { transform: translate3d(24%, 16%, 0) scale(1.1); }
        }
        @keyframes mfloat2 {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          100% { transform: translate3d(-20%, -12%, 0) scale(.95); }
        }
        .bg.no-anim .blob { animation: none; }
        @media (prefers-reduced-motion: reduce) { .blob { animation: none; } }
        .content {
          position: relative; z-index: 3;
          height: 100%; box-sizing: border-box;
          display: flex; flex-direction: column; justify-content: space-between;
          padding: 14px 18px 12px;
        }
        .hdr { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .hdr svg { width: 18px; height: 18px; flex: none; opacity: .9; fill: #fff; }
        .dev {
          font-size: 13px; font-weight: 600; opacity: .9; letter-spacing: .2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          text-shadow: 0 1px 2px rgba(0,0,0,.25);
        }
        .app {
          margin-left: auto; flex: none;
          font-size: 11px; font-weight: 700; letter-spacing: .6px;
          text-transform: uppercase; opacity: .85;
          padding: 3px 9px; border-radius: 10px;
          background: rgba(255,255,255,.18);
          text-shadow: 0 1px 2px rgba(0,0,0,.2);
        }
        .bg.haspad ~ .content .title, .bg.haspad ~ .content .artist { padding-right: 104px; }
        .title {
          font-size: 17px; font-weight: 700; line-height: 1.25;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden;
          text-shadow: 0 1px 3px rgba(0,0,0,.3);
        }
        .artist {
          font-size: 13px; font-weight: 500; opacity: .85; margin-top: 2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          text-shadow: 0 1px 2px rgba(0,0,0,.25);
        }
        .prog { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
        .bar {
          flex: 1; height: 4px; border-radius: 2px;
          background: rgba(255,255,255,.25); overflow: hidden;
        }
        .fill {
          height: 100%; width: 0%;
          background: rgba(255,255,255,.9);
          border-radius: 2px;
        }
        .t {
          font-size: 11px; font-weight: 600; opacity: .8; flex: none;
          font-feature-settings: "tnum";
        }
        .row {
          display: flex; align-items: center; justify-content: center;
          gap: 6px; margin-top: 4px;
        }
        .row button {
          border: 0; cursor: pointer; color: #fff;
          background: transparent; border-radius: 50%;
          width: 42px; height: 42px;
          display: grid; place-items: center;
          transition: background .15s ease, transform .1s ease;
        }
        .row button:active { background: rgba(255,255,255,.22); transform: scale(.92); }
        .row button svg { width: 24px; height: 24px; fill: #fff; filter: drop-shadow(0 1px 2px rgba(0,0,0,.3)); }
        .row .pp { width: 46px; height: 46px; background: rgba(255,255,255,.20); }
        .row .pp svg { width: 26px; height: 26px; }
        .row .pw { margin-right: auto; }
        .row .sp { margin-left: auto; width: 42px; }
        .thumb {
          position: absolute; right: 16px; top: 44px;
          width: 92px; border-radius: 8px;
          box-shadow: 0 4px 14px rgba(0,0,0,.4);
          z-index: 3;
        }
        .applogo {
          position: absolute; right: 16px; top: 44px;
          width: 54px; height: 54px; border-radius: 12px;
          background: rgba(255,255,255,.22);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.22), 0 4px 14px rgba(0,0,0,.3);
          display: grid; place-items: center;
          z-index: 3;
        }
        .applogo svg { width: 34px; height: 34px; fill: #fff; filter: drop-shadow(0 1px 3px rgba(0,0,0,.35)); }
        .applogo .mono {
          font-size: 26px; font-weight: 800; color: #fff;
          text-shadow: 0 1px 3px rgba(0,0,0,.35);
        }
        /* children overlay in one cell; visibility is style.display only
         * (SVGElement has no .hidden - it cost us a mislaid DTV tile) */
        .applogo > * { grid-area: 1 / 1; }
        .applogo .bimg {
          width: 54px; height: 54px; border-radius: inherit;
          object-fit: cover;
        }
        .idle-note { font-size: 14px; font-weight: 500; opacity: .8; }
        [hidden] { display: none !important; }
      </style>
      <ha-card>
        <div class="bg">
          <div class="art"></div>
          <div class="blob m1"></div>
          <div class="blob m2"></div>
          <div class="blob m3"></div>
          <div class="msheen"></div>
        </div>
        <img class="thumb" hidden alt="">
        <div class="applogo" hidden><svg viewBox="0 0 24 24" style="display:none"><path d=""></path></svg><span class="mono" style="display:none"></span><img class="bimg" alt="" style="display:none"></div>
        <div class="content">
          <div class="hdr">
            <svg viewBox="0 0 24 24"><path d="M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>
            <div class="dev"></div>
            <div class="app"></div>
          </div>
          <div>
            <div class="title"></div>
            <div class="artist"></div>
            <div class="prog">
              <div class="t tl">0:00</div>
              <div class="bar"><div class="fill"></div></div>
              <div class="t tr">0:00</div>
            </div>
          </div>
          <div class="row">
            <button class="pw" aria-label="Power"><svg viewBox="0 0 24 24"><path d="M13 3h-2v10h2V3zm4.83 2.17-1.42 1.42A6.92 6.92 0 0 1 19 12a7 7 0 0 1-14 0c0-2.06.9-3.92 2.58-5.4L6.17 5.17A8.93 8.93 0 0 0 3 12a9 9 0 0 0 18 0c0-2.74-1.23-5.18-3.17-6.83z"/></svg></button>
            <button class="prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg></button>
            <button class="pp" aria-label="Play or pause"><svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z"/></svg><svg class="i-pause" viewBox="0 0 24 24" hidden><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button>
            <button class="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z"/></svg></button>
            <div class="sp"></div>
          </div>
        </div>
      </ha-card>
    `;
    const q = (x) => this.shadowRoot.querySelector(x);
    this._els = {
      bg: q(".bg"), art: q(".art"), dev: q(".dev"), app: q(".app"),
      title: q(".title"), artist: q(".artist"),
      fill: q(".fill"), tl: q(".tl"), tr: q(".tr"),
      pp: q(".pp"), iplay: q(".i-play"), ipause: q(".i-pause"),
      prev: q(".prev"), next: q(".next"), pw: q(".pw"),
      m1: q(".m1"), m2: q(".m2"), m3: q(".m3"), msheen: q(".msheen"),
      thumb: this.shadowRoot.querySelector(".thumb"),
      logo: q(".applogo"), logoSvg: q(".applogo svg"),
      logoPath: q(".applogo path"), logoMono: q(".applogo .mono"),
      bimg: q(".applogo .bimg"),
    };
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (const el of [this._els.m1, this._els.m2, this._els.m3, this._els.msheen]) {
      el.style.setProperty("--r", rnd(0.82, 1.28).toFixed(3));
      el.style.animationDelay = "-" + rnd(0, 30).toFixed(2) + "s";
      if (Math.random() < 0.5) el.style.animationDirection = "alternate-reverse";
    }
    this._els.pp.addEventListener("click", () => this._svc("media_play_pause"));
    this._els.prev.addEventListener("click", () => this._svc("media_previous_track"));
    this._els.next.addEventListener("click", () => this._svc("media_next_track"));
    this._els.pw.addEventListener("click", () => {
      const s = this._s;
      this._svc(s && s.state !== "off" ? "turn_off" : "turn_on");
    });
  }

  _accent() {
    const s = this._s;
    if (!s || s.state === "off" || s.state === "unavailable" || s.state === "idle") {
      return "#6E6E73";
    }
    // Config wins over the app tint - "make it blue" is a valid preference.
    if (this._config.accent) return this._config.accent;
    const app = (s.attributes.app_name || "").toLowerCase();
    // The glyph's brand color is the tint, so tile and card always match.
    for (const k in APP_LOGOS) {
      if (app.indexOf(k) >= 0) return APP_LOGOS[k].c;
    }
    for (const k in APP_ACCENTS) {
      if (app.indexOf(k) >= 0) return APP_ACCENTS[k];
    }
    return "#5A6BC0";
  }

  _progress() {
    const s = this._s;
    if (!s) return null;
    const dur = s.attributes.media_duration;
    let pos = s.attributes.media_position;
    if (dur == null || pos == null) return null;
    if (s.state === "playing" && s.attributes.media_position_updated_at) {
      pos += (Date.now() - new Date(s.attributes.media_position_updated_at).getTime()) / 1000;
    }
    return { pos: Math.min(pos, dur), dur };
  }

  _syncTimer() {
    const playing = this._s && this._s.state === "playing";
    if (playing && !this._timer) {
      this._timer = setInterval(() => this._renderProgress(), 1000);
    } else if (!playing && this._timer) {
      clearInterval(this._timer);
      this._timer = 0;
    }
  }

  _renderProgress() {
    const p = this._progress();
    const on = !!p && p.dur > 0;
    this._els.fill.parentElement.parentElement.style.visibility = on ? "" : "hidden";
    if (!on) return;
    this._els.fill.style.width = (100 * p.pos / p.dur).toFixed(2) + "%";
    this._els.tl.textContent = fmtTime(p.pos);
    this._els.tr.textContent = fmtTime(p.dur);
  }

  _render() {
    if (!this._els) return;
    const s = this._s;
    const glass = this._config.glass !== false;
    const bg = this._els.bg;
    bg.classList.toggle("glass", glass);

    const spd = Number(this._config.animation_speed);
    const animOn = this._config.animation !== false && spd !== 0;
    bg.classList.toggle("no-anim", !animOn);
    if (animOn) bg.style.setProperty("--drift-speed", (spd > 0 ? spd : 10) + "s");

    this._els.dev.textContent =
      this._config.name ?? (s ? s.attributes.friendly_name : this._config.entity);

    const accent = this._accent();
    const c0 = mixHex(accent, "#FFFFFF", 0.48);
    const c2 = mixHex(accent, "#000000", 0.42);
    bg.style.backgroundImage = glass
      ? "linear-gradient(150deg," + hexRgba(c0, .66) + " 0%," + hexRgba(accent, .46) + " 45%," + hexRgba(c2, .66) + " 100%)"
      : "linear-gradient(150deg," + c0 + " 0%," + accent + " 45%," + c2 + " 100%)";
    this._els.m1.style.setProperty("--c", mixHex(accent, "#FFFFFF", 0.55));
    this._els.m2.style.setProperty("--c", mixHex(accent, "#000000", 0.45));
    this._els.m3.style.setProperty("--c", mixHex(accent, "#FFFFFF", 0.30));

    let art = s && s.attributes.entity_picture;
    if (!art && s && /youtube/i.test(s.attributes.app_name || "")) {
      // TV-native YouTube sessions often put the video id in media_content_id;
      // phone-cast sessions expose nothing, and then there is no thumbnail to
      // be had from any source.
      const cid = String(s.attributes.media_content_id || "");
      const m = cid.match(/(?:^|v=|\/)([A-Za-z0-9_-]{11})(?:$|[&?])/);
      if (m) art = "https://img.youtube.com/vi/" + m[1] + "/mqdefault.jpg";
    }
    bg.classList.toggle("hasart", !!art);
    this._els.art.style.backgroundImage = art ? "url('" + art + "')" : "";
    this._els.thumb.hidden = !art;
    if (art) this._els.thumb.src = art;
    // No artwork but something is playing: show the app itself in the slot.
    let logoOn = false;
    const activeNow = s && !["off", "idle", "unavailable", "unknown"].includes(s.state);
    if (!art && activeNow) {
      const app = (s.attributes.app_name || "").toLowerCase();
      let glyph = null;
      for (const k in APP_LOGOS) { if (app.indexOf(k) >= 0) { glyph = APP_LOGOS[k]; break; } }
      // Visibility is style.display ONLY: SVGElement has no .hidden property.
      const show = (svg, mono, img) => {
        this._els.logoSvg.style.display = svg ? "block" : "none";
        this._els.logoMono.style.display = mono ? "block" : "none";
        this._els.bimg.style.display = img ? "block" : "none";
      };
      if (glyph && glyph.d) {
        this._els.logoPath.setAttribute("d", glyph.d);
        this._els.logoPath.setAttribute("fill", glyph.c);
        const px = (glyph.w || 34) + "px";
        this._els.logoSvg.style.width = px;
        this._els.logoSvg.style.height = px;
        show(true, false, false);
        logoOn = true;
      } else if (glyph && glyph.img) {
        if (this._els.bimg._src !== glyph.img) {
          this._els.bimg._src = glyph.img;
          this._els.bimg.src = glyph.img;
        }
        show(false, false, true);
        logoOn = true;
      } else if (s.attributes.app_name) {
        this._els.logoMono.textContent = s.attributes.app_name[0].toUpperCase();
        show(false, true, false);
        logoOn = true;
      }
    }
    this._els.logo.hidden = !logoOn;
    bg.classList.toggle("haspad", !!art || logoOn);

    if (!s || s.state === "unavailable" || s.state === "off" || s.state === "idle") {
      this._els.app.textContent = s ? s.state : "not found";
      this._els.title.textContent = "Nothing playing";
      this._els.title.classList.add("idle-note");
      this._els.artist.textContent = "";
      this._renderProgress();
      this._els.iplay.hidden = false;
      this._els.ipause.hidden = true;
      return;
    }

    this._els.title.classList.remove("idle-note");
    this._els.app.textContent = s.attributes.app_name || s.state;
    this._els.title.textContent = s.attributes.media_title || "—";
    this._els.artist.textContent = s.attributes.media_artist || "";
    const playing = s.state === "playing";
    this._els.iplay.hidden = playing;
    this._els.ipause.hidden = !playing;
    this._renderProgress();

    const feat = s.attributes.supported_features || 0;
    this._els.prev.style.visibility = (feat & MFEAT.PREV) ? "" : "hidden";
    this._els.next.style.visibility = (feat & MFEAT.NEXT) ? "" : "hidden";
    this._els.pw.style.visibility = (feat & (MFEAT.TURN_OFF | MFEAT.TURN_ON)) ? "" : "hidden";
  }
}

customElements.define("haptic-media-card", HapticMediaCard);


window.customCards = window.customCards || [];
window.customCards.push({
  type: "haptic-media-card",
  name: "Haptic Media Card",
  description:
    "Glass media controller tinted by the playing app, with haptic transport controls and a live progress bar.",
  preview: true,
});
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
