# MushtaqTrader
Practice trading with fake money yet still be able to learn how to trade without losing money

## MushtaqTrack (`racer/`)

A low-poly time-trial racer in the style of PolyTrack, in a single HTML file (`racer/index.html`, with Three.js and Ammo.js loaded from CDNs). Open the file in a browser to play.

- **Car physics**: runs on [Ammo.js](https://github.com/kripken/ammo.js), the JavaScript port of the Bullet physics engine. Each car is a Bullet raycast vehicle: a rigid chassis on four raycast wheels with sprung suspension. Grip comes from a friction-circle tyre model that uses each wheel's load from Bullet. The road is Bullet collision geometry built from the track; barriers, pillars and blocks are handled by the car itself, so brushing one slides you along it instead of spinning you round. It's very grippy and fast, and you get weight transfer, wheelspin and real slides. The road is a true 3D surface, so cars can drive banked turns, ride walls and go upside down through loops. A small handling layer on top adds the drift, boosts and air control, and keeps the car on banked and looping road. After a landing the throttle cuts briefly so the back wheels can settle.
- **Air control**: in the air, steering turns the car, W/S pitch the nose down or up, and Space works as an air brake that stops it spinning.
- **Drift**: the cars grip and stay straight through corners. To drift, hold Space (the handbrake) as you turn in to slide the tail out, keep steering into the slide to hold it, then straighten up for a small drift boost; longer drifts give bigger boosts.
- **Track pieces**: road, tight, wide and **banked** turns, **wall rides**, **loops** (exiting a lane left or right), ramps and **long slopes**, kickers, boost pads, **pillars** and **chicane blocks**, **tunnels**, checkpoints, and arrow signs on tight turns.
- **Environments**: Summer, Winter (snowy pines) and Desert (cacti and mesas), combined with time of day.
- **14 cars** in the garage, each with its own model and handling: an open-wheel formula car, an Italian-style supercar, a rear-engine German-style GT, a Le Mans-style prototype, a hypercar, an electric hypercar, a stock car, a muscle car, a drift coupé, a rally hatch, an off-road pickup, a classic roadster and a go-kart. You can repaint any of them. The names are made up and there are no real brand logos.
- **34 official tracks** across Easy, Medium, Hard and Expert, plus a **daily track** and **endless random tracks** from a seed you can share. The generator uses every piece type.
- **Medals** (Bronze, Silver, Gold, Author), a **ghost of your best run** with live split deltas, and a local leaderboard that records which car you used.
- **Track editor** with 17 piece types, height levels, an environment picker, undo, a route check, and `MT1.` share codes.
- **Community tracks** (on the hosted page): press Publish on a track under Yours and everyone who plays the game sees it in the Community tab, with its maker's name. They can race it or copy it into their own editor. You can update or unpublish your own tracks, and the game's owner can remove any track. Publishing needs Contributor access or higher to the page; people with view-only access can still race community tracks. A copy of the game opened as a local file has no Community tab.
- Red/white barriers on every edge (you can clear them when airborne), skid marks, tyre smoke, engine sound, three cameras (the chase camera rolls with the car through loops), a minimap, and keyboard, gamepad and large touch controls.
- An autopilot drives the menu background. It was used to test all 14 cars on all 34 official tracks, and to set the medal times.

Times, ghosts, custom tracks and settings are saved in the browser's local storage.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate (the clock starts on your first input); in the air, nose down |
| S / ↓ | Brake, then reverse; in the air, nose up |
| A D / ← → | Steer (also in the air) |
| Space / Shift | Handbrake; air brake in the air |
| R | Instant restart |
| Enter | Back to last checkpoint |
| C | Switch camera |
| Esc / P | Pause |
| M | Mute |
| G | Garage (from the menu) |
