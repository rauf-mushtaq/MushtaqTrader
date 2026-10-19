# MushtaqTrader
Practice trading with fake money yet still be able to learn how to trade without losing money

## MushtaqTrack (`racer/`)

A low-poly time-trial racer in the style of PolyTrack, in a single HTML file (`racer/index.html`, Three.js from a CDN). Open the file in a browser to play.

- **Five official tracks** with ramps, bridges, kicker jumps, boost pads and hairpins.
- **Medals** (Bronze, Silver, Gold, Author) worked out from each track's route, so custom tracks get them too.
- **Ghost of your personal best** to race against, with live split deltas at every checkpoint.
- **Track editor**: 9 piece types, multiple height levels, rotation, undo and a route check that tells you whether Start reaches Finish.
- **Share codes**: export any track as an `MT1.` code and import a friend's.
- Drift, skid marks, synthesized engine sound, three cameras, speed-based FOV, a minimap, time-of-day themes (including night with headlights), car paint, and keyboard, touch and gamepad controls.
- An autopilot drives the menu background and was used to check that every official track can be finished.

Times, ghosts and custom tracks are saved in the browser's local storage.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate (the clock starts on your first input) |
| S / ↓ | Brake, then reverse |
| A D / ← → | Steer |
| Space / Shift | Drift |
| R | Instant restart |
| Enter | Back to last checkpoint |
| C | Switch camera |
| Esc / P | Pause |
| M | Mute |
