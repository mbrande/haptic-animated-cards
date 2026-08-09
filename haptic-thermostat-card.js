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

const VERSION = "2.0.2";

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

/* Tile shades, light -> deep. Which shade is chosen depends on how hard the
 * thermostat is being asked to work: a low cool setpoint or a high heat setpoint
 * picks a deeper colour. */
const TILE_SHADES = {
  cool: [["#5AC8FA", "#0A84FF"], ["#3BB3F5", "#0A6FE8"], ["#1E9BEC", "#0B5FD0"],
         ["#1481D8", "#0A4FB0"], ["#0E67B4", "#083E8C"]],
  heat: [["#FFCC66", "#FF9F0A"], ["#FFB84D", "#FF8A00"], ["#FFA033", "#FF6B00"],
         ["#FF8A1F", "#F25200"], ["#FF7300", "#D93E00"]],
  dry: [["#FFE08A", "#FFB800"]],
  fan: [["#A0E9FF", "#32ADE6"]],
  idle: [["#8E8E93", "#5A5A5F"]],
  range: [["#FF9F0A", "#0A84FF"]],
};

const MODE_LABEL = {
  off: "Off", heat: "Heat", cool: "Cool", heat_cool: "Auto",
  auto: "Auto", dry: "Dry", fan_only: "Fan",
};

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
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("haptic-thermostat-card: 'entity' is required");
    }
    if (config.entity.split(".")[0] !== "climate") {
      throw new Error("haptic-thermostat-card: entity must be a climate.* entity");
    }
    this._config = Object.assign(
      { name: null, min: null, max: null, step: null, modes: true },
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
        /* Fill the grid cell rather than imposing our own shape. aspect-ratio:1/1
         * fights grid_options.rows: the row count fixes the height, the ratio
         * fixes it again from the width, and when they disagree the card
         * overflows and paints over its neighbour. Let the grid decide. */
        ha-card {
          height: 100%; box-sizing: border-box;
          border: none; overflow: hidden;
          display: flex; flex-direction: column; justify-content: space-between;
          padding: 16px 18px;
          cursor: pointer;
          transition: transform .18s ease, filter .18s ease;
          color: #fff;
        }
        ha-card:active { transform: scale(.97); filter: brightness(1.08); }
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
        <div class="top">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0zm-3-9a1 1 0 0 1 1 1v8.6l.5.3a3 3 0 1 1-3 0l.5-.3V5a1 1 0 0 1 1-1z"/></svg>
          <div class="nm"></div>
        </div>
        <div class="bot">
          <div class="big"></div>
          <div class="sub"></div>
        </div>
      </ha-card>
    `;
    this._tEls = {
      card: this.shadowRoot.querySelector("ha-card"),
      nm: this.shadowRoot.querySelector(".nm"),
      big: this.shadowRoot.querySelector(".big"),
      sub: this.shadowRoot.querySelector(".sub"),
    };
    // `click`, deliberately: a touch that becomes a scroll never produces one,
    // so scrolling past the card can't open it - and there are no drag handlers
    // here at all, so scrolling can't change the temperature either.
    this._tEls.card.addEventListener("click", () => this.openPanel());
  }

  _renderTile() {
    if (!this._tEls) return;
    const s = this._s;
    const unit = this._hass.config.unit_system.temperature || "°";
    this._tEls.nm.textContent =
      this._config.name ?? (s ? s.attributes.friendly_name : this._config.entity);

    if (!s || s.state === "unavailable" || s.state === "unknown") {
      this._tEls.card.style.background = "linear-gradient(160deg,#8E8E93,#5A5A5F)";
      this._tEls.big.innerHTML = `<span class="unavail">${s ? s.state : "not found"}</span>`;
      this._tEls.sub.textContent = this._config.entity;
      return;
    }

    const [c0, c1] = this._tileShade;
    this._tEls.card.style.background = `linear-gradient(160deg, ${c0} 0%, ${c1} 100%)`;

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
          opacity: 0; transition: opacity .28s ease; will-change: opacity;
          font-family: var(--ha-font-family-body, system-ui, -apple-system, sans-serif);
        }
        .back.in { opacity: 1; }
        .blur {
          position: absolute; inset: 0; pointer-events: none;
          background: rgba(0,0,0,.55);
          backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        }
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
          transition: opacity .28s ease; will-change: opacity;
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
        .foot {
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
    this._pEls.back.addEventListener("click", (e) => {
      if (e.target === this._pEls.back) this.closePanel();
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
    setTimeout(() => host.remove(), 320);
  }

  /* ---------- interaction ---------- */

  _tempFromPointer(evt) {
    const r = this._pEls.svg.getBoundingClientRect();
    const x = ((evt.clientX - r.left) / r.width) * 200 - 100;
    const y = ((evt.clientY - r.top) / r.height) * 200 - 100;
    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (deg < START_ANGLE) deg += 360;
    const frac = clamp((deg - START_ANGLE) / SWEEP, 0, 1);
    const raw = this._min + frac * (this._max - this._min);
    return clamp(Math.round(raw / this._step) * this._step, this._min, this._max);
  }

  _down(evt) {
    const s = this._s;
    if (!s || s.state === "unavailable") return;
    const v = this._values;
    if (!v) return;
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

window.customCards = window.customCards || [];
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
