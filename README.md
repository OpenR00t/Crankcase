# Crankcase

An engine generator for [BeamNG.drive](https://www.beamng.com/). Build an engine from its
physical parts (layout, bore and stroke, cams, intake, internals, compression, fuel and
injection, turbo or supercharger, exhaust, flywheel) and gearing, and Crankcase works out its torque curve, size, mass and rotating
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
| 4. Compression | Compression ratio, fuel octane, port or direct injection | Efficiency gained from compression, and knock: where the mixture would detonate and the torque lost when the ECU retards the timing; with direct injection, the compression it would take clean |
| 5. Forced induction | Naturally aspirated, turbocharged (single, parallel twin, sequential twin, twin-scroll), supercharged (roots, twin-screw, centrifugal) or twincharged; boost; where full boost arrives (the turbo's size); the hand-over rpm for sequential turbos and twincharging | Boost against rpm (each device's share when twincharged), torque with and without it, how fast the boost builds, the supercharger's drive loss, and knock under boost with the compression that would run clean |
| 6. Exhaust | Cast manifold or tubular headers (and their primary length), single or dual pipes and their diameter, catalytic converter, muffler | Back pressure against rpm, torque with this exhaust against a free-flowing one, the pipe size the engine wants, the rpm the headers are tuned to, and how loud it is in the game |
| 7. Gearing | Number of gears, each ratio, final drive, tyre size; ratio tools to spread the middle gears evenly or progressively, set a gear from an rpm at a speed, and move ratio between gearbox and final drive | Force at the wheels in every gear against the ideal constant-power line and the car's drag and rolling resistance; top speed and what limits it, where each upshift lands on the power curve, the best shift point for each gear (where the next gear accelerates harder, counting grip and engine inertia), cruising rpm and an estimated 0–100 km/h |
| 8. Rotating mass | Flywheel (dual-mass, stock, lightened, ultra-light), crank (fully counterweighted or lightened), the driver's shift speed (relaxed, brisk, quick, sequential) | Total rotating inertia and its parts; how fast the engine revs up in neutral and how far the revs fall during a shift against where the next gear wants them, and how long a perfectly matched shift would take; how heavy that inertia feels through each gear, and its effect on 0–100 km/h |

The parts map onto the model in [`ui/lib/parts.js`](ui/lib/parts.js). Every change is drawn against a **baseline** (dashed). *Pin as baseline* keeps the current
design to compare the next change against. Hovering any chart shows its values at the cursor;
clicking pins that readout so it stays (and updates) while you move sliders. Click a slider's
value to type one in.

**Locks** under the headline numbers hold a target while you design. *Displacement*, *Redline*
and *Bore / stroke* hold a value: with 2.0 L locked, more bore means less stroke; with the redline
locked, the stroke follows the rotating-assembly build. *Mass* is a ceiling, and *Fits the car*
and *No knock* are limits: the sliders stop at the last setting that keeps them (turning *No knock*
on while the engine knocks lowers the compression until it runs clean). Click a lock's value to
type a target, such as 2.0 for a 2.0 L class. A move the locks can't allow (the bore, with both
displacement and redline locked) is held, and the lock that held it flashes. Locks are saved with
the design ([`ui/lib/locks.js`](ui/lib/locks.js)).

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
  with piston speed, after Chen and Flynn) − exhaust pumping

Knock is a single index that rises with compression ratio, cylinder filling (VE), bore size and low rpm;
above the chosen fuel's limit, torque is reduced as an ECU would by retarding the ignition.
Direct injection cools the charge: it lowers the knock index (worth about 1 to 1.5 points of
compression) and fills the cylinder about 2% better, for a little pump friction.

The exhaust ([`ui/lib/exhaust.js`](ui/lib/exhaust.js)): back pressure = loss coefficient ×
½ × gas density × gas speed², with each part (manifold, pipe friction, catalytic converter,
muffler) adding to the coefficient and the gas flow following the engine's airflow. It costs
pumping work on the exhaust stroke and leaves residual gas in the cylinder (more with cam
overlap). Behind a turbo the gas is denser and the pressure is felt back through the turbine.
Tubular headers add a tuning bump around the rpm their primary length suits (Smith's rule);
an oversized pipe loses a little scavenging low down. A design saved before the Exhaust section
opens with a road car's exhaust, so it shows a little less than it did; that's about what the
game's stock exhausts were already taking off.

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
rev-happy 2.0 I4, a lazy 5.7 V8 cruiser, a V6 grand tourer and a 1.3 L turbo four in the
style of a 90s Japanese hot hatch, each geared for what it's for.

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

Pick the car the engine is for. The list holds every car and truck in the game and in your
active mods (zipped or unpacked), and each one is checked in the background to show whether
it can take an engine. The **Fit** panel draws your engine's block in that car's engine bay,
side and top, and checks length, width and height against the bay (under 3 cm to spare is
flagged as tight), the engine's mass against the car's stock engine, and its torque rating.
An engine that doesn't fit can't be exported to that car; the design itself never depends
on the target.

### Any car

A car is worked out from its own files the first time you pick it
([`ui/lib/detect.js`](ui/lib/detect.js)), so mod cars work the same way as the game's:

- the **engine slot** is the slot holding the default config's combustion engine, and every
  engine that fits it is a candidate donor;
- each layout family (inline, flat, V) borrows a stock engine of that family as its **donor**;
  a car with no stock engine of a family lends that family another donor's mounts;
- the **engine frame** comes from the donor's block nodes (e1–e4, spelt en1–en4 on the trucks and bus): where the block sits, which
  end the gearbox is on, which way the crank points and which side the car calls left. Your
  engine is built in its own frame and placed along the donor's, so it goes in longways,
  sideways or behind the driver the way the car's own engines do;
- the **bay** is the space the car's stock engines take up, grown into the room the rest of the
  car leaves around them (up to the hood, the radiator and the chassis rails, less 3 cm). It's an
  estimate;
- the **intake, flywheel, gearbox and final drive** slots come from the donor and the stock
  config: its turbo (if it has one) for forced induction, the adjustable gearboxes for the
  config's gearing, and every adjustable final drive;
- **mass, drivetrain and drag** for the gearing sections come from the default config's info
  (its weight, and a drag area backed out of its listed power and top speed).

Cars that can't take an engine (electric only, or engines without block nodes to mount to)
are shown greyed out with the reason. The Ibishu BX keeps its hand-checked profile in
[`ui/lib/profiles.js`](ui/lib/profiles.js), which the detected BX matches.

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

With forced induction, the same jbeam holds an **induction part** for the car's intake slot,
and the .dae carries its own model (the turbos or blower, generated for the layout like the
engine). A turbo is built on the car's stock turbo for that engine family (its intercooler,
nodes and sounds), a supercharger on the slot's stock intake; everything that decides how they
behave comes from the design: the turbo's compressor map, exhaust and efficiency curves (from
the engine's own airflow, shaped for the layout), how fast its boost can rise and its wastegate
(adjustable in the game); the supercharger's type, pulley ratio, boost per rpm, drive loss and,
when twincharged, the rpm its clutch lets go. A pair of turbos is one turbo device in the game,
as on the game's own twin-turbo cars. The engine's torque table stays naturally aspirated, since
BeamNG multiplies it by the boost itself, and Crankcase predicts the boosted torque with the same
sums the game uses ([`ui/lib/induction.js`](ui/lib/induction.js)). BeamNG doesn't model knock,
so the part carries the difference: the turbo's efficiency where it boosts, and a torque
multiplier where the supercharger does. The engine's torque rating is sized for the boosted torque.

The design's **exhaust** is a part for the car's exhaust slot, built on the stock exhaust (its
pipes, nodes and look): its `torqueModExhaust` is what the exhaust takes from, or with tuned
headers adds to, the naturally aspirated torque, and the game adds it to the engine's table
before any boost multiplies it, as it does with its own exhausts. The engine's table itself is
free-flowing. The muffler and catalytic converter set the tailpipe's muffling, tone and
backfires. A car whose exhaust slot can't be found keeps its own exhaust, and the export says so.

It also writes a **vehicle config** for the car (`crankcase_<name>.pc` with its
`info_crankcase_<name>.json`), so the design's gearing comes along: a stock config of the
car (read from the game) with your engine, exhaust, flywheel and any turbo, the car's adjustable race gearbox for your number
of gears and its adjustable final drives swapped in, and every ratio set (a car with no adjustable
gearbox keeps its own). It appears in the
vehicle selector as *Crankcase: your design*. Everything else, tyres included, stays as the
stock config has it; if the car's tyres aren't the size the gearing was worked out on, the
export says by how much every speed will differ (see
[`ui/lib/vehicleconfig.js`](ui/lib/vehicleconfig.js)).

The engine **sound** is a stock recording of the closest layout (an inline six, a boxer, a
V6 …, see [`ui/lib/sounds.js`](ui/lib/sounds.js)) with its harmonics set to your cylinder
count. The **mounts, intake, exhaust and radiator** come from the car's own engine of the
same family (the *donor*, read from the game or the mod when you export): for the BX, the
stock 2.4 L I4 for inline and flat engines, the 4.5 L V8 for V engines. A car with no stock
turbo for that engine gets a turbo built on its stock intake instead.

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
