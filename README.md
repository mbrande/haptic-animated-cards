# haptic-thermostat-card

A circular temperature dial for Home Assistant, styled after the iOS Home app,
**with haptic feedback while dragging**.

## Why this exists

Home Assistant has no temperature control that produces haptic feedback. Verified
against the running instance (HA 2026.7.4):

| Card / component | haptic references |
|---|---|
| core `thermostat` card bundles | **0** |
| core `ha-control-circular-slider` | **0** |
| `better-thermostat-ui-card` 3.2.3 | **0** |
| `lovelace-mushroom` | **0** |
| Bubble Card | dispatcher present, but no dial |
| `button-card` | 14 — but it is a button, not a dial |

Every haptic reference in HA's entire frontend belongs to a single element:
`<ha-switch>`. Toggles can buzz; sliders and dials cannot.

Custom cards *can* fire the event, which is all this card really does differently.

## How the haptic works

    fireEvent(window, "haptic", "selection")

The companion app listens for that `window` event and produces the tap.

> **Do not "modernise" this to `new CustomEvent(type, {detail})`.** HA builds it as
> `new Event(...)` and assigns `.detail` afterwards. The shape was copied from
> Bubble Card's working implementation on this instance.

One `selection` tick per temperature step crossed while dragging; one `light` tap
when the new value is committed on release.

**Haptics only fire inside the iOS/Android companion app.** In a desktop browser
or on the Fire tablet kiosk the card renders and works normally, silently.

## Config

```yaml
type: custom:haptic-thermostat-card
entity: climate.home_downstairs_zone_1
name: House          # optional, defaults to friendly_name
min: 45              # optional, defaults to the entity's min_temp
max: 95              # optional, defaults to the entity's max_temp
step: 1              # optional, defaults to target_temp_step
```

## Deploying a change

⚠️ **`/local/` is cached for 31 days.** Editing the file is not enough — the
resource URL must change or you will be testing stale JavaScript and conclude
your edit did nothing.

1. edit `haptic-thermostat-card.js`
2. `git commit`
3. bump `?v=` on the Lovelace resource (Settings → Dashboards → ⋮ → Resources)
4. hard-refresh, or force-close and reopen the companion app

The `?v=` number and the git history are the same thing viewed two ways — keep
them in step.

## Design notes

* Vanilla custom element + Shadow DOM. No Lit, no build step, no dependencies —
  so a frontend framework bump cannot break it.
* Service calls are committed **on pointer release**, not during the drag. Dragging
  fires dozens of pointermove events; calling `set_temperature` on each makes the
  thermostat lag and the ring fight your finger.
* Ring colour follows `hvac_action` when present, falling back to state, so it is
  orange only while actually heating — matching iOS.
* 270° sweep starting at 135°, gap at the bottom.
