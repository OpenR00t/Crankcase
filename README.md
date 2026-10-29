# Crankcase

An engine generator for [BeamNG.drive](https://www.beamng.com/). Build an engine from its
physical parts (layout, bore and stroke, cams, intake, internals, compression and fuel,
flywheel) and gearing, and Crankcase works out its torque curve, size, mass and rotating
inertia from them. Export it and the game gets a complete engine: torque table, friction and
engine braking, its own 3D model, sound, mounts, flywheel, and a vehicle config with the
gearing set.

## Sections

The design is built up in sections, each covering one part of the engine and showing what
it does to the result.

| Section | Controls | What it shows |
| --- | --- | --- |
| 1. Displacement | Cylinders, bore, stroke, rotating-assembly build | Swept volume, bore/stroke ratio, mean piston speed and the redline it allows |
| 2. Breathing | Cam duration and lift, intake runner length | Volumetric efficiency vs rpm (where the torque curve's shape comes from), and the valve-lift diagram with the overlap |
| 3. Internals | Piston rings, bearings, oil, wet or dry sump | Combustion torque, friction losses and what reaches the flywheel; what each part saves and costs in durability |
| 4. Compression | Compression ratio, fuel octane | Efficiency gained from compression, and knock: where the mixture would detonate and the torque lost when the ECU retards the timing |
| 5. Gearing | Number of gears, each ratio, final drive, tyre size; ratio tools to spread the middle gears evenly or progressively, set a gear from an rpm at a speed, and move ratio between gearbox and final drive | Force at the wheels in every gear against the ideal constant-power line and the car's drag and rolling resistance; top speed and what limits it, where each upshift lands on the power curve, cruising rpm and an estimated 0–100 km/h |
| 6. Rotating mass | Flywheel (dual-mass, stock, lightened, ultra-light), crank (fully counterweighted or lightened), the driver's shift speed (relaxed, brisk, quick, sequential) | Total rotating inertia and its parts; how fast the engine revs up in neutral and how far the revs fall during a shift against where the next gear wants them, and how long a perfectly matched shift would take; how heavy that inertia feels through each gear, and its effect on 0–100 km/h |

Planned: forced induction.

The parts map onto the model in [`ui/lib/parts.js`](ui/lib/parts.js). Every change is drawn against a **baseline** (dashed). *Pin as baseline* keeps the current
design to compare the next change against. Hovering any chart shows its values at the cursor;
clicking pins that readout so it stays (and updates) while you move sliders. Click a slider's
value to type one in.

Under the controls, each section shows its key **figures**, then **notes** on what's worth acting on,
one line each and most urgent first (red: critical, yellow: warning, blue: information); hover a
figure or note for the detail. *How it works* holds the background.

## The model

Simple and readable on purpose: every step in [`ui/lib/engine.js`](ui/lib/engine.js) is a
textbook relationship that can be followed by hand.

- Air per cycle = displacement × volumetric efficiency × air density
- Indicated work = (air ÷ air/fuel ratio) × fuel heating value × indicated efficiency
  (a scaled Otto-cycle efficiency from the compression ratio)
- Torque = work per cycle ÷ 4π (four-stroke: one cycle every two revolutions)
- Flywheel torque = indicated torque − friction (friction mean effective pressure growing
  with piston speed, after Chen and Flynn)

Knock is a single index that rises with compression ratio, cylinder filling (VE), bore size and low rpm;
above the chosen fuel's limit, torque is reduced as an ECU would by retarding the ignition.

Volumetric efficiency combines a cam term (best at the cam's rpm, a bigger cam peaks higher
but falls off harder at low rpm), an intake-tuning bump, and flow choking at high piston
speed. These are shaped approximations, not a gas-dynamics simulation.

## Design files

A design (engine and gearing) is saved as a **`.crank`** file: plain JSON with a different
extension, so it can be read, diffed and shared without going through BeamNG. *Save* and
*Open* are in the header; *Open as baseline* in the torque card loads a file as the dashed
comparison curve instead. *Notes* keeps free text (goals, what you tried) inside the file.
The format is written and checked in [`ui/lib/crankfile.js`](ui/lib/crankfile.js); a
`summary` block (peak power and torque, redline, mass) is included for reading only and is
ignored on open.

[`examples/`](examples) holds a few complete designs to start from: a rally boxer, a
rev-happy 2.0 I4, a lazy 5.7 V8 cruiser and a V6 grand tourer, each geared for what it's for.

## Comparing with a run in BeamNG

*Open run* loads a run recorded in BeamNG as a MoTeC i2 log (`.ld`, with its `.ldx`
beside it for laps), such as one recorded with the Beamlog mod, and
compares it with the design ([`ui/lib/run.js`](ui/lib/run.js),
[`ui/lib/motec.js`](ui/lib/motec.js)):

- **Full-throttle torque**: the logged engine torque, binned every 250 rpm, drawn as
  points on the torque chart and listed against the design's curve.
- **Gearing**: each gear's overall ratio (engine speed over driven-wheel speed) against
  the design's gear × final drive, and the run's engine speed against road speed drawn as
  points on the Gearing section's rpm chart.
- **What the car did**: top speed, 0–100 km/h, upshifts (where the revs left and landed),
  laps and temperatures. These depend on the whole car as set up in BeamNG (tyres, aero,
  exhaust, mass), so they're shown as measured rather than checked against a model.

Only the engine and gearbox are compared, because everything else about the car is
meant to be changed in BeamNG. A run from another config, or with different gearing, is
pointed out.

## Target car and fit

Pick the car the engine is for (the Ibishu BX for now). The **Fit** panel draws your
engine's block in that car's engine bay, side and top, and checks length, width and height
against the bay (under 3 cm to spare is flagged as tight), the engine's mass against the car's stock engine, and its torque rating.
An engine that doesn't fit can't be exported to that car; the design itself never depends
on the target.

The engine's size and mass come from the design: layout (inline, flat or V), cylinder count,
bore and stroke set the block's dimensions (see [`ui/lib/geometry.js`](ui/lib/geometry.js)),
and its estimated mass is spread over the block.

## Export to BeamNG.drive

Export writes a complete engine for the car's **Engine** slot, as two files:

- **`crankcase_<name>.jbeam`**, from your design: the torque table in N·m, redline and rev
  limiter, inertia, damage limits, and the eight block nodes BeamNG engines are built from,
  sized and weighted to your engine;
- **`crankcase_<name>.dae`**, the engine's own 3D model, generated for its layout (block or
  crankcase, heads, cam covers, intake, exhaust manifold, oil pan, timing cover, pulley) and
  sized to the same block, so an I4 looks like an I4 and a flat-6 like a flat-6
  ([`ui/lib/mesh.js`](ui/lib/mesh.js)). It uses materials that ship with the game, so it
  needs no textures of its own.

The same jbeam also holds a **flywheel** part for the car's flywheel slot (on the BX, inside
the gearbox), carrying the flywheel and clutch inertia chosen in the Rotating mass section;
the engine's own inertia is the crank and rotating assembly only.

The engine also carries the design's own **friction and engine braking** in BeamNG's terms:
`friction` and `dynamicFriction` fitted to the design's friction curve, and `engineBrakeTorque`
for pumping against a closed throttle (about 0.8 bar on every intake stroke). So the internals
you choose change how hard the engine brakes and how fast the revs fall in the game, and the
Rotating mass section's rev-drop chart uses the same sum BeamNG does.

It also writes a **vehicle config** for the car (`crankcase_<name>.pc` with its
`info_crankcase_<name>.json`), so the design's gearing comes along: a stock config of the
car (read from the game) with your engine and flywheel, the car's adjustable race gearbox for your number
of gears and its adjustable final drive swapped in, and every ratio set. It appears in the
vehicle selector as *Crankcase: your design*. Everything else, tyres included, stays as the
stock config has it; if the car's tyres aren't the size the gearing was worked out on, the
export says by how much every speed will differ (see
[`ui/lib/vehicleconfig.js`](ui/lib/vehicleconfig.js)).

The engine **sound** is a stock recording of the closest layout (an inline six, a boxer, a
V6 …, see [`ui/lib/sounds.js`](ui/lib/sounds.js)) with its harmonics set to your cylinder
count. The **mounts, intake, exhaust and radiator** come from the car's own engine of the
same family (the *donor*, read from the game when you export): for the BX, the stock
2.4 L I4 for inline and flat engines, the 4.5 L V8 for V engines. Each car is described by
a small profile in [`ui/lib/profiles.js`](ui/lib/profiles.js); supporting another car means
adding a profile.

The file goes to `mods/unpacked/crankcase/vehicles/<car>/` inside BeamNG's user folder. The
game and user folders are found automatically (Steam libraries and the default user
folder); set `CRANKCASE_BEAMNG_GAME` or `CRANKCASE_BEAMNG_USER` to override. In the game,
restart once after the first export, then spawn the **Crankcase: *your design*** config
from the vehicle selector, or pick **Engine → Crankcase: *your design*** in Vehicle Config on
any config of the car.

## Running from source

You need [Rust](https://rustup.rs/) (and, on Windows, the WebView2 runtime that ships with
Windows 10 and 11).

```
cd src-tauri
cargo run --release
```

Or with the Tauri CLI (Node.js): `npm install`, then `npx tauri dev`.

The interface also runs in a plain browser from any static file server pointed at `ui/`;
exporting needs the desktop app, which reads the donor engine from the game.

Tests:

```
npm test                         # engine model and export (Node.js 20+)
cd src-tauri && cargo test       # file path checks
```

## License

[AGPL-3.0-or-later](LICENSE). uPlot is included under its own MIT license
([`ui/vendor/uPlot.LICENSE`](ui/vendor/uPlot.LICENSE)).
