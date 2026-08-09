/*
 * ios-thermostat-card
 * A circular temperature dial for Home Assistant, styled after the iOS Home app,
 * with haptic feedback while dragging.
 *
 * The haptic bridge is the whole point of this card. Home Assistant's own
 * thermostat card, its circular-slider component, and better-thermostat-ui-card
 * all contain ZERO haptic references - the only core element that fires haptics
 * is <ha-switch>. Custom cards can fire them, though, which is what this does:
 *
 *     fireEvent(window, "haptic", "selection")
 *
 * The companion app listens for that window event and produces the tap. Verified
 * against Bubble Card's working implementation on this instance. Note the event
 * is built with `new Event(...)` and `.detail` assigned afterwards - NOT
 * `new CustomEvent(type, {detail})`. That is how HA does it internally and it is
 * what the app expects.
 *
 * Haptics only fire inside the iOS/Android companion app. In a desktop browser
 * or the Fire tablet kiosk the card renders and works normally, silently.
 *
 * No build step, no dependencies, plain custom element + Shadow DOM.
 */

const VERSION = "1.5.0";

/* HA's own fireEvent shape. Do not "modernise" this to CustomEvent - the detail
 * is assigned as a property after construction, matching the frontend. */
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

/* Dial geometry: a 270 degree sweep. In SVG, angle 0 is at 3 o'clock and grows
 * clockwise because the y axis points down. 135 -> 405 puts the gap at the
 * bottom, same as the iOS dial. */
const START_ANGLE = 135;
const SWEEP = 270;
const R = 76;        // arc radius
const STROKE = 22;   // ring thickness - iOS's ring is chunky

const polar = (cx, cy, r, angleDeg) => {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

function arcPath(cx, cy, r, startAngle, endAngle) {
  if (endAngle - startAngle <= 0.01) return "";
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Multi-stop ramps, matched to the iOS Home dial.
 *
 * The important part is that it is NOT a simple dark->light ramp. Apple runs a
 * pale, almost-white highlight band roughly two thirds of the way along the arc
 * and comes back to saturated colour at the end, which reads as a sheen on a
 * glossy ring. A two-stop gradient looks flat next to it.
 *
 * Offsets are along the gradient axis, which is laid diagonally bottom-left ->
 * top-right so it tracks the direction the arc actually travels. */
const RAMPS = {
  heat: [[0, "#FF5E00"], [0.44, "#FFC66B"], [0.63, "#FFEDCB"], [1, "#FF9F0A"]],
  cool: [[0, "#0A84FF"], [0.44, "#8FD0F5"], [0.63, "#DCF3F8"], [1, "#4C9BFF"]],
  dry: [[0, "#FFB800"], [0.5, "#FFEBB0"], [1, "#FFC93C"]],
  fan: [[0, "#32ADE6"], [0.5, "#CFF3FF"], [1, "#5EC8F0"]],
  idle: [[0, "#6E6E73"], [0.5, "#C7C7CC"], [1, "#8E8E93"]],
};

/* HA's mode ids are not what you'd say out loud. */
const MODE_LABEL = {
  off: "Off",
  heat: "Heat",
  cool: "Cool",
  heat_cool: "Auto",
  auto: "Auto",
  dry: "Dry",
  fan_only: "Fan",
};

class IosThermostatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._dragging = false;
    this._pending = null;      // target temp while dragging, before we commit
    this._lastHapticStep = null;
    this._built = false;
    /* Gradient ids must be unique per instance: two cards in one document would
     * otherwise both resolve url(#...) to whichever defs parsed last. */
    this._gradId = "arc-" + Math.random().toString(36).slice(2, 9);
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("ios-thermostat-card: 'entity' is required");
    }
    if (config.entity.split(".")[0] !== "climate") {
      throw new Error("ios-thermostat-card: entity must be a climate.* entity");
    }
    this._config = Object.assign(
      { name: null, min: null, max: null, step: null, modes: true },
      config
    );
    this._built = false;
  }

  getCardSize() {
    return 5;
  }

  static getStubConfig() {
    return { entity: "" };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._render();
  }

  get _stateObj() {
    return this._hass && this._config
      ? this._hass.states[this._config.entity]
      : undefined;
  }

  /* ---------- temperature model ---------- */

  get _min() {
    const s = this._stateObj;
    return this._config.min ?? (s && s.attributes.min_temp) ?? 45;
  }

  get _max() {
    const s = this._stateObj;
    return this._config.max ?? (s && s.attributes.max_temp) ?? 95;
  }

  get _step() {
    const s = this._stateObj;
    return this._config.step ?? (s && s.attributes.target_temp_step) ?? 1;
  }

  get _target() {
    if (this._pending !== null) return this._pending;
    const s = this._stateObj;
    return s && s.attributes.temperature != null
      ? Number(s.attributes.temperature)
      : null;
  }

  /* Colour follows what the system is DOING (hvac_action) when available, and
   * falls back to what it is set to. Matches the iOS behaviour where the ring
   * is orange only while actually heating. */
  get _rampKey() {
    const s = this._stateObj;
    if (!s || s.state === "off" || s.state === "unavailable") return "idle";
    const action = s.attributes.hvac_action;
    const basis = action && action !== "idle" ? action : s.state;
    if (basis === "heating" || basis === "heat") return "heat";
    if (basis === "cooling" || basis === "cool") return "cool";
    if (basis === "drying" || basis === "dry") return "dry";
    if (basis === "fan" || basis === "fan_only") return "fan";
    return "idle";
  }

  /* Rebuild the gradient stops only when the ramp actually changes - _render()
   * runs on every state update and re-creating four SVG nodes each time is
   * pointless churn. */
  _applyRamp(key) {
    if (this._appliedRamp === key) return;
    this._appliedRamp = key;
    const grad = this._els.grad;
    while (grad.firstChild) grad.removeChild(grad.firstChild);
    for (const [offset, colour] of RAMPS[key]) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", `${offset * 100}%`);
      stop.setAttribute("stop-color", colour);
      grad.appendChild(stop);
    }
  }

  /* ---------- build ---------- */

  _build() {
    this._built = true;
    const g = this._gradId;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          padding: 14px 8px 12px;
          display: flex; flex-direction: column; align-items: center;
        }
        .name {
          font-size: 15px; font-weight: 600; letter-spacing: .2px;
          color: var(--secondary-text-color);
          margin: 0 0 2px; text-align: center;
        }
        /* The dial's 90 degree gap leaves dead space at the bottom of a square
         * SVG. Pull the following content up into it instead of letting the card
         * grow taller than it needs to be.
         *
         * How far is safe: with R=76 and STROKE=22 the arc's lowest point sits at
         * y = 100 + 76*sin(135) + 11 = 165 of a 200-tall viewBox, so ~17% of the
         * SVG below that is empty. -15% stays just inside it. */
        .wrap { position: relative; width: 100%; max-width: 320px; margin-bottom: -15%; }
        svg { width: 100%; height: auto; display: block; touch-action: none; }
        .track { stroke: var(--divider-color, #3a3a3c); opacity: .4; }
        .knob  { transition: fill .35s ease; }
        .centre {
          position: absolute; inset: 0;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          pointer-events: none; text-align: center;
        }
        .mode {
          font-size: 13px; font-weight: 600; text-transform: capitalize;
          letter-spacing: .4px; opacity: .85;
        }
        .target {
          font-size: 58px; font-weight: 300; line-height: 1.02;
          font-feature-settings: "tnum"; /* stop digits jittering while dragging */
          color: var(--primary-text-color);
        }
        .target sup { font-size: 21px; font-weight: 400; vertical-align: super; }
        /* Reading and mode selector share one row - stacked they cost two rows of
         * card height for two short items, which pushed the card past its grid
         * allocation and let the next section heading overlap it. */
        .footer {
          display: flex; align-items: center; justify-content: center;
          gap: 12px; flex-wrap: wrap; width: 100%;
        }
        /* Sits BELOW the gauge, not inside it. */
        .current {
          font-size: 14px; font-weight: 500;
          color: var(--secondary-text-color);
          text-align: center;
        }
        /* A native <select> on purpose: iOS renders it as the system wheel
         * picker, which is exactly the interaction being asked for, and it is
         * accessible and keyboard-navigable for free. appearance:none strips the
         * platform chrome so it can be styled as an iOS pill. */
        .modesel {
          font: inherit; font-size: 13px; font-weight: 600; letter-spacing: .3px;
          -webkit-appearance: none; appearance: none;
          border: 0; border-radius: 16px; cursor: pointer;
          padding: 7px 30px 7px 16px;
          color: #fff; text-align: center;
          transition: background .25s ease;
          background-repeat: no-repeat;
          background-position: right 11px center;
          background-size: 11px;
          background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 8"><path d="M1 1.5L6 6.5L11 1.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        }
        .modesel:focus { outline: none; }
        /* The dropdown list itself is drawn by the platform, so give the options
         * a sane background - inheriting the pill colour makes them unreadable. */
        .modesel option { color: initial; background: initial; font-weight: 500; }
        .unavail {
          font-size: 15px; color: var(--error-color, #ff453a); padding: 28px 0;
        }
      </style>
      <ha-card>
        <div class="name"></div>
        <div class="wrap">
          <svg viewBox="0 0 200 200" aria-label="Temperature dial">
            <defs>
              <!-- Axis runs bottom-left -> top-right, following the direction the
                   arc travels, so the ramp reads along the ring rather than across
                   it. userSpaceOnUse keeps it anchored to the dial while the arc
                   grows; the default bounding-box mode would rescale the ramp to
                   the arc's own box and slide the colours under your finger. -->
              <linearGradient id="${g}" gradientUnits="userSpaceOnUse"
                              x1="26" y1="174" x2="174" y2="26">
              </linearGradient>
            </defs>
            <path class="track" fill="none" stroke-width="${STROKE}" stroke-linecap="round"></path>
            <path class="value" fill="none" stroke-width="${STROKE}" stroke-linecap="round"
                  stroke="url(#${g})"></path>
            <circle class="knob" r="10"></circle>
          </svg>
          <div class="centre">
            <div class="mode"></div>
            <div class="target"></div>
          </div>
        </div>
        <div class="footer">
          <div class="current"></div>
          <select class="modesel" aria-label="HVAC mode"></select>
        </div>
      </ha-card>
    `;

    this._els = {
      card: this.shadowRoot.querySelector("ha-card"),
      name: this.shadowRoot.querySelector(".name"),
      svg: this.shadowRoot.querySelector("svg"),
      track: this.shadowRoot.querySelector(".track"),
      value: this.shadowRoot.querySelector(".value"),
      knob: this.shadowRoot.querySelector(".knob"),
      mode: this.shadowRoot.querySelector(".mode"),
      target: this.shadowRoot.querySelector(".target"),
      current: this.shadowRoot.querySelector(".current"),
      modesel: this.shadowRoot.querySelector(".modesel"),
      grad: this.shadowRoot.querySelector("linearGradient"),
    };
    this._appliedRamp = null;
    this._appliedModes = null;

    this._els.modesel.addEventListener("change", (e) => this._setMode(e.target.value));

    const svg = this._els.svg;
    svg.addEventListener("pointerdown", (e) => this._onDown(e));
    svg.addEventListener("pointermove", (e) => this._onMove(e));
    svg.addEventListener("pointerup", (e) => this._onUp(e));
    svg.addEventListener("pointercancel", (e) => this._onUp(e));
  }

  /* ---------- interaction ---------- */

  _tempFromPointer(evt) {
    const rect = this._els.svg.getBoundingClientRect();
    // viewBox is 200x200 and centre is (100,100); work in viewBox units
    const x = ((evt.clientX - rect.left) / rect.width) * 200 - 100;
    const y = ((evt.clientY - rect.top) / rect.height) * 200 - 100;

    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (deg < START_ANGLE) deg += 360;          // wrap into the 135..405 domain
    const frac = clamp((deg - START_ANGLE) / SWEEP, 0, 1);

    const raw = this._min + frac * (this._max - this._min);
    const step = this._step;
    return clamp(Math.round(raw / step) * step, this._min, this._max);
  }

  _onDown(evt) {
    if (!this._stateObj || this._stateObj.state === "unavailable") return;
    this._dragging = true;
    this._els.svg.setPointerCapture(evt.pointerId);
    this._lastHapticStep = null;
    this._onMove(evt);
  }

  _onMove(evt) {
    if (!this._dragging) return;
    evt.preventDefault();
    const t = this._tempFromPointer(evt);
    if (t !== this._pending) {
      this._pending = t;
      // One tick per step crossed - this is the iOS "picker" feel.
      if (this._lastHapticStep !== t) {
        haptic("selection");
        this._lastHapticStep = t;
      }
      this._render();
    }
  }

  _onUp(evt) {
    if (!this._dragging) return;
    this._dragging = false;
    try {
      this._els.svg.releasePointerCapture(evt.pointerId);
    } catch (e) {
      /* pointer already gone - harmless */
    }
    const t = this._pending;
    this._pending = null;
    if (t === null || !this._stateObj) return;

    const current = this._stateObj.attributes.temperature;
    if (Number(current) === Number(t)) return;   // nothing to do

    // Commit on release rather than during the drag: dragging fires dozens of
    // moves and hammering set_temperature makes the thermostat lag and the ring
    // fight the user's finger.
    haptic("light");
    this._hass.callService("climate", "set_temperature", {
      entity_id: this._config.entity,
      temperature: t,
    });
  }

  _setMode(mode) {
    haptic("light");
    this._hass.callService("climate", "set_hvac_mode", {
      entity_id: this._config.entity,
      hvac_mode: mode,
    });
  }

  /* Options are rebuilt only when the available mode LIST changes, not on every
   * state update - rebuilding mid-gesture would close the picker under the
   * user's finger. */
  _applyModes(modes) {
    const key = modes.join("|");
    if (this._appliedModes === key) return;
    this._appliedModes = key;
    const sel = this._els.modesel;
    sel.textContent = "";
    for (const m of modes) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = MODE_LABEL[m] || m.replace(/_/g, " ");
      sel.appendChild(o);
    }
  }

  /* ---------- render ---------- */

  _render() {
    if (!this._els) return;
    const s = this._stateObj;

    this._els.name.textContent =
      this._config.name ?? (s ? s.attributes.friendly_name : this._config.entity);

    if (!s || s.state === "unavailable" || s.state === "unknown") {
      this._els.mode.textContent = "";
      this._els.target.innerHTML =
        `<span class="unavail">${s ? s.state : "not found"}</span>`;
      this._els.current.textContent = this._config.entity;
      this._els.value.setAttribute("d", "");
      this._els.knob.setAttribute("r", "0");
      this._els.modesel.style.display = "none";
      return;
    }

    const target = this._target;
    const rampKey = this._rampKey;
    const deep = RAMPS[rampKey][0][1];   // first stop, used for accents
    const unit = this._hass.config.unit_system.temperature || "°";

    this._applyRamp(rampKey);

    this._els.track.setAttribute(
      "d",
      arcPath(100, 100, R, START_ANGLE, START_ANGLE + SWEEP)
    );

    if (target === null) {
      this._els.value.setAttribute("d", "");
      this._els.knob.setAttribute("r", "0");
      this._els.target.textContent = "--";
    } else {
      const frac = clamp((target - this._min) / (this._max - this._min), 0, 1);
      const endAngle = START_ANGLE + frac * SWEEP;
      this._els.value.setAttribute("d", arcPath(100, 100, R, START_ANGLE, endAngle));

      const k = polar(100, 100, R, endAngle);
      this._els.knob.setAttribute("cx", k.x);
      this._els.knob.setAttribute("cy", k.y);
      this._els.knob.setAttribute("r", "10");
      this._els.knob.setAttribute("fill", "#ffffff");

      const dp = this._step < 1 ? 1 : 0;
      this._els.target.innerHTML =
        `${target.toFixed(dp)}<sup>${unit}</sup>`;
    }

    const action = s.attributes.hvac_action;
    this._els.mode.textContent = action ? action : s.state;
    this._els.mode.style.color = deep;

    const cur = s.attributes.current_temperature;
    this._els.current.textContent =
      cur != null ? `Currently ${Number(cur).toFixed(1)}${unit}` : "";

    // hvac mode selector
    const modes = this._config.modes === false
      ? []
      : (s.attributes.hvac_modes || []);
    this._applyModes(modes);
    const sel = this._els.modesel;
    sel.style.display = modes.length ? "" : "none";
    // Don't yank the value out from under an open picker mid-selection.
    if (document.activeElement !== this && sel.value !== s.state) {
      sel.value = s.state;
    }
    // backgroundColor only, so the chevron background-image set in CSS survives
    sel.style.backgroundColor = deep;
  }
}

customElements.define("ios-thermostat-card", IosThermostatCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ios-thermostat-card",
  name: "iOS Thermostat Card",
  description:
    "Circular temperature dial styled after the iOS Home app, with haptic feedback on the companion app.",
  preview: true,
});

console.info(
  `%c IOS-THERMOSTAT-CARD %c v${VERSION} `,
  "color:#fff;background:#0A84FF;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "color:#0A84FF;background:#1c1c1e;border-radius:0 3px 3px 0;padding:2px 4px"
);
