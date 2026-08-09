# haptic-thermostat-card

A circular temperature dial for Home Assistant, styled after the iOS Home app —
**with haptic feedback while you drag it.**

You feel a tick for every degree you cross, and a firmer tap when the new
temperature is committed. As far as I can tell it is the only Home Assistant
temperature control that does.

---

## Why this exists

Home Assistant has no temperature control that produces haptic feedback. That is
not an oversight in one card — it is true of every option. Counting haptic
references in the shipped JavaScript (checked against HA 2026.7.4):

| Card / component | haptic references |
|---|---|
| core `thermostat` card | **0** |
| core `ha-control-circular-slider` (the dial component) | **0** |
| `better-thermostat-ui-card` 3.2.3 | **0** |
| `lovelace-mushroom` | **0** |
| Bubble Card | has a dispatcher, but no dial |
| `button-card` | 14 — but it is a button, not a dial |

Every haptic reference in Home Assistant's entire frontend belongs to a single
element: **`<ha-switch>`**. Toggles can buzz. Sliders and dials cannot.

Custom cards *can* fire the event, though, and that is essentially all this card
does differently.

## How the haptics work

```js
fireEvent(window, "haptic", "selection");
```

The Home Assistant companion app listens for that `window` event and produces the
tap. One `selection` tick per temperature step crossed while dragging, and one
`light` tap when the value is committed on release.

> **Implementation note if you are borrowing this:** the event must be built as
> `new Event(type, {bubbles: true, composed: true})` with `.detail` **assigned
> afterwards** — *not* `new CustomEvent(type, {detail})`. The `CustomEvent` form
> looks correct and does not work. This shape matches what the frontend does
> internally.

⚠️ **Haptics only fire inside the companion app** (iOS and Android). In a desktop
browser, or on a wall tablet, the card renders and works normally — silently.

⚠️ **Android feedback is coarser.** Per the companion docs, "Android devices that
have haptic feedback support and/or a vibration motor can expect to feel some type
of feedback." iOS maps the types onto the Taptic Engine and they feel distinct;
Android maps them onto whatever vibration motor the device has.

## Install

**HACS (custom repository)** — HACS → three-dot menu → Custom repositories → add
this repo's URL with category **Dashboard**, then install and add the resource.

**Manual** — copy `haptic-thermostat-card.js` into `/config/www/`, then add a
dashboard resource of type **JavaScript module** pointing at
`/local/haptic-thermostat-card.js`.

⚠️ Home Assistant caches `/local/` aggressively. When you update the file, change
the `?v=` on the resource URL or you will be testing the old copy and conclude
your change did nothing.

## Config

```yaml
type: custom:haptic-thermostat-card
entity: climate.your_thermostat
name: Hallway     # optional, defaults to the entity's friendly name
min: 45           # optional, defaults to the entity's min_temp
max: 95           # optional, defaults to the entity's max_temp
step: 1           # optional, defaults to target_temp_step
modes: true       # optional, set false to hide the HVAC mode selector
```

## What it supports

* **Single setpoint** (`heat`, `cool`, …) — one handle, arc from the minimum.
* **Dual setpoint** (`heat_cool`) — two handles with a warm-to-cool band between
  them. Range mode is detected from `target_temp_low`/`target_temp_high` being
  present rather than from the mode's name, because implementations disagree
  about whether it is called `heat_cool` or `auto` — but they all agree on the
  attributes.
* **HVAC mode switching** via a single pill. It is a native `<select>`, so iOS
  renders it as the system wheel picker and it stays keyboard and screen-reader
  accessible.
* Ring colour follows `hvac_action` where available, so it is orange only while
  actually heating.

## Design notes

* Vanilla custom element and Shadow DOM. No Lit, no build step, no dependencies —
  a frontend framework bump cannot break it.
* `climate.set_temperature` is called **on pointer release**, not during the drag.
  A drag emits dozens of `pointermove` events; calling the service on each makes
  the thermostat lag and the ring fight your finger.
* The gradient is multi-stop with a pale highlight band about two thirds along,
  which is what gives the iOS ring its sheen. A plain two-stop ramp looks flat.
* Its axis uses `gradientUnits="userSpaceOnUse"` anchored to the dial. The default
  bounding-box mode rescales the ramp to the arc's own box, so the colours slide
  around under your finger as the arc grows.
* Each instance generates a unique gradient id — SVG `url(#id)` resolves per
  document, so two cards on one dashboard would otherwise share one gradient.

## Licence

No licence file yet. Until one is added, all rights are reserved — open an issue
if you would like one.
