# MushtaqTrader
Practice trading with fake money yet still be able to learn how to trade without losing money

## MushtaqTrack (`racer/`)

A low-poly time-trial racer in the style of PolyTrack, in a single HTML file (`racer/index.html`, Three.js from a CDN). Open the file in a browser to play.

- **Car physics**: each car is a rigid body on four sprung wheels with tyre grip limits, so it's very grippy and fast, with weight transfer, wheelspin and real slides. Cars fly off crests and kickers and land on their suspension.
- **Drift**: tap the handbrake (Space or the Drift button) while turning to kick the tail out, then keep steering into the slide to hold a steady drift angle without losing much speed. Straighten up for a drift boost; longer drifts give bigger boosts.
- **14 cars** in the garage, each with its own model and handling: an open-wheel formula car, an Italian-style supercar, a rear-engine German-style GT, a Le Mans-style prototype, a hypercar, an electric hypercar, a stock car, a muscle car, a drift coupé, a rally hatch, an off-road pickup, a classic roadster and a go-kart. You can repaint any of them. The names are made up and there are no real brand logos.
- **24 official tracks** across Easy, Medium, Hard and Expert, plus a **daily track** and **endless random tracks** from a seed you can share.
- **Medals** (Bronze, Silver, Gold, Author), a **ghost of your best run** with live split deltas, and a local leaderboard that records which car you used.
- **Track editor** with 9 piece types, height levels, undo, a route check, and `MT1.` share codes.
- Red/white barriers on every edge (you can clear them when airborne), skid marks, tyre smoke, engine sound, three cameras, a minimap, time-of-day themes, and keyboard, gamepad and large touch controls.
- An autopilot drives the menu background. It was used to check that all 14 cars can finish all 24 official tracks, and to set the medal times.

Times, ghosts, custom tracks and settings are saved in the browser's local storage.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate (the clock starts on your first input) |
| S / ↓ | Brake, then reverse |
| A D / ← → | Steer |
| Space / Shift | Handbrake / start a drift |
| R | Instant restart |
| Enter | Back to last checkpoint |
| C | Switch camera |
| Esc / P | Pause |
| M | Mute |
| G | Garage (from the menu) |
