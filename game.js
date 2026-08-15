/* =========================================================================
   المنزل السابع — 3D Horror Maze Game
   Built with Three.js r128. Map is a static glTF corridor (from Sketchfab,
   Sketchfab Standard license — see models/corridor/license.txt); navigation,
   collision, spawn/key/exit/monster placement are all derived automatically
   from the model at load time. Procedural audio, no other external assets.
   ========================================================================= */
"use strict";

/* ---------------------------------------------------------------------
   0. Small utilities
--------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const isCoarsePointer = window.matchMedia && window.matchMedia("(pointer:coarse)").matches;

/* ---------------------------------------------------------------------
   1. Config
--------------------------------------------------------------------- */
// Every playable map — solo picks one from Settings, multiplayer rooms
// broadcast the host's pick to every guest (see mapId in multiplayer.js /
// enterLobby below) so everyone in a room loads the same level.
// timeoutMs: how long to wait before giving up with "map-load-timeout".
// The hospital scan is ~114MB (183 loose texture files) vs the corridor's
// ~9.4MB, so it genuinely needs much longer on an average connection —
// the old flat 25s applied to every map and was cutting the hospital off
// mid-download on anything but fast wifi.
const MAPS = {
  corridor: { id: "corridor", name: "الممر المهجور", url: "models/corridor/scene.gltf", timeoutMs: 25000 },
  hospital: { id: "hospital", name: "المستشفى", url: "models/hospital/scene.gltf", timeoutMs: 120000 },
};
const DEFAULT_MAP_ID = "corridor";
function mapUrl(mapId) { return (MAPS[mapId] || MAPS[DEFAULT_MAP_ID]).url; }
function mapTimeout(mapId) { return (MAPS[mapId] || MAPS[DEFAULT_MAP_ID]).timeoutMs || 25000; }
const NAV_STEP = 0.55;        // meters between navigation-grid sample points
const FLOOR_TOLERANCE = 0.28; // how far above the lowest floor hit still counts as "floor"
const PLAYER_RADIUS = 0.32;
let EYE_HEIGHT = 1.62;
// Render layer used only for the LOCAL player's own visible-body mesh, so
// the local camera can be told to ignore it (see attachLocalBodyModel /
// initScene). Remote players' avatars stay on the default layer (0) and
// are unaffected — every camera renders every OTHER player's body normally.
const LOCAL_BODY_LAYER = 1;
// Fixed reference used only for the nav-grid's overhead clearance check
// (see buildNavGrid) — deliberately independent of EYE_HEIGHT above, which
// can change once a character model measures its own real eye height.
const NAV_CLEARANCE_HEIGHT = 1.62;
const WALK_SPEED = 3.0;
const SPRINT_SPEED = 5.4;
// Simple jump arc (no real physics/verticality in this maze — see the
// "run"/"jump" touch buttons in controls.js): an initial upward speed and
// a constant downward acceleration, added on top of the normal eye-height
// each frame in updatePlayer, so it works the same whether the player is
// standing still or mid-stride.
const JUMP_SPEED = 3.4;   // m/s, initial upward velocity
const JUMP_GRAVITY = 9.2; // m/s^2, downward acceleration while airborne
const CATCH_RADIUS = 0.95;
const KEY_PICK_RADIUS = 1.15;

/* ---------------------------------------------------------------------
   1b. Player settings (sensitivity / FOV / difficulty) — persisted locally
--------------------------------------------------------------------- */
const Settings = {
  data: Object.assign({
    sensitivity: 1.0,   // multiplier, 0.4 - 2.5
    fov: 72,             // 60 - 100
    pov: 0,               // 0 = first person (only mode implemented so far)
    difficulty: "normal", // none | easy | normal | hard  (solo default)
    mapId: "corridor",   // solo map choice — see MAPS above
    graphicsQuality: "high", // low | medium | high
    fpsCap: 60,             // 0 = unlimited, else 30/60/100/130 — defaulting to
                            // 60 instead of unlimited stops the loop racing a
                            // 90/120Hz phone screen for no visual benefit,
                            // which was the main cause of overheating/lag
    monsterVolume: 100,   // 0-100
    gameVolume: 100        // 0-100
  }, JSON.parse(localStorage.getItem("dlb_settings") || "{}")),
  save() { localStorage.setItem("dlb_settings", JSON.stringify(this.data)); },
  get(k) { return this.data[k]; },
  set(k, v) { this.data[k] = v; this.save(); }
};

// Applies the "جودة الرسوميات" choice to the live renderer: pixel ratio
// and shadows are the two cheapest knobs for real performance gains on
// weak phones. Safe to call before the renderer exists (no-op then) and
// again any time after — settings screen calls it live on change.
function applyGraphicsQuality() {
  if (!renderer) return;
  const q = Settings.get("graphicsQuality") || "high";
  if (q === "low") {
    // A flat pixelRatio of 1 was making everything on the screen — the
    // character, the maps, every texture — look soft/blocky on any phone
    // with a high-density screen (most phones have devicePixelRatio 2-3,
    // so this was rendering at 1/2 or 1/3 resolution). 1.25 keeps most of
    // the performance win but no longer looks broken on those screens.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.shadowMap.enabled = false;
  } else if (q === "medium") {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
  }
  // NOTE: antialiasing is fixed at renderer creation (WebGL context flag),
  // so switching graphicsQuality live changes resolution/shadows instantly
  // but an AA change only takes full effect after the page reloads.
}

// Difficulty tuning table used both in solo play and multiplayer rooms.
const DIFFICULTY_TABLE = {
  none:   { monsterEnabled: false, speedMul: 1.0,  spawnDelay: 0,  batteryDrainMul: 1.0 },
  easy:   { monsterEnabled: true,  speedMul: 0.8,  spawnDelay: 26, batteryDrainMul: 0.75 },
  normal: { monsterEnabled: true,  speedMul: 1.0,  spawnDelay: 14, batteryDrainMul: 1.0 },
  hard:   { monsterEnabled: true,  speedMul: 1.25, spawnDelay: 4,  batteryDrainMul: 1.3 }
};
// If the auto-measured scale still looks wrong (player too tall/short vs the
// room), set a fixed number here instead, e.g. 0.6, and it will be used
// instead of the automatic measurement below. Leave as null to keep auto.
const MANUAL_SCALE_OVERRIDE = null;

/* ---------------------------------------------------------------------
   2. Global state
--------------------------------------------------------------------- */
const state = {
  running: false,
  keysHeld: {},
  keysCollected: 0,
  totalKeys: 3,
  exitUnlocked: false,
  battery: 100,
  flashlightOn: false,
  stamina: 100,
  sprinting: false,
  moving: false,
  jumping: false, // true while airborne — see triggerJump() / updatePlayer
  jumpVel: 0,      // current vertical speed while jumping (m/s)
  jumpOffset: 0,   // current extra height added on top of eye-level (m)
  restY: 0,        // smoothed eye-height BEFORE jumpOffset is added — see updatePlayer
  monsterActive: false,
  monsterMode: "idle", // idle | patrol | chase
  gameOver: false,
  won: false,
  yaw: 0,
  pitch: 0,
  power: 1,            // house ambient power level, 0..1 — see updateHouseLighting()
  survivalTime: 0,
  nextBlackoutAt: 0,
  // Multiplayer session info, set by multiplayer.js before startGame() when
  // launching from a room lobby. active=false means normal solo play.
  mp: { active: false, roomCode: null, difficulty: "normal", mapId: "corridor", isHost: false },
};

function currentDifficulty() {
  return (state.mp && state.mp.active) ? state.mp.difficulty : Settings.get("difficulty");
}

function currentMapId() {
  const id = (state.mp && state.mp.active) ? state.mp.mapId : Settings.get("mapId");
  return MAPS[id] ? id : DEFAULT_MAP_ID;
}

let scene, camera, renderer, yawObject, pitchObject, flashlight, flashTarget;
let clock;
let wallList = [];
let levelBounds = null; // hard outer boundary of the level, in world space
let mazeGroup;
let keyMeshes = [];
let monster = null;
let ambientFlickerLight = null;
let houseAmbient = null; // base room light — dimmed by updateHouseLighting() during blackouts

// --- Static map (loaded model) state ---
const mapTemplates = {}; // mapId -> cached parsed GLTF scene, cloned per playthrough
// The currently-playing map's live mesh group, kept around (not just local
// to buildScene) so runtime wall/door collision can raycast against the
// actual geometry — see raySweepBlocked() below.
let mapMeshGroup = null;
let floorY = 0;               // world Y of the walkable floor
let exitMarker = null, exitLight = null;
let exitWorld = null;
let spawnWorld = null;

// --- Navigation grid (derived from the model via raycasting) ---
let nav = null; // { originX, originZ, w, h, walkable: Uint8Array }

function navIndex(cx, cz) { return cz * nav.w + cx; }
function navIsWalkable(cx, cz) {
  if (cx < 0 || cz < 0 || cx >= nav.w || cz >= nav.h) return false;
  return nav.walkable[navIndex(cx, cz)] === 1;
}
function navCellToWorld(cx, cz) {
  return { x: nav.originX + cx * NAV_STEP, z: nav.originZ + cz * NAV_STEP };
}
function worldToNavCell(x, z) {
  return {
    x: clamp(Math.round((x - nav.originX) / NAV_STEP), 0, nav.w - 1),
    y: clamp(Math.round((z - nav.originZ) / NAV_STEP), 0, nav.h - 1),
  };
}

/** Generic 4-neighbour BFS over the navigation grid. Returns an array of
 *  {x,y} cells from just-after-start to goal, or null if unreachable. */
function bfsPath(start, goal) {
  const key = (x, y) => y * nav.w + x;
  const visited = new Uint8Array(nav.w * nav.h);
  const prev = new Array(nav.w * nav.h).fill(null);
  const queue = [start];
  visited[key(start.x, start.y)] = 1;
  const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    if (cur.x === goal.x && cur.y === goal.y) break;
    for (const d of dirs) {
      const nx = cur.x + d.dx, ny = cur.y + d.dy;
      if (!navIsWalkable(nx, ny)) continue;
      const k = key(nx, ny);
      if (visited[k]) continue;
      visited[k] = 1;
      prev[k] = { x: cur.x, y: cur.y };
      queue.push({ x: nx, y: ny });
    }
  }
  const gk = key(goal.x, goal.y);
  if (!visited[gk]) return null;
  const path = [];
  let cur = { x: goal.x, y: goal.y };
  while (!(cur.x === start.x && cur.y === start.y)) {
    path.push(cur);
    const p = prev[key(cur.x, cur.y)];
    if (!p) return null;
    cur = p;
  }
  path.reverse();
  return path;
}

/** BFS distance (in cells) from start to every reachable cell. */
function bfsDistances(start) {
  const dist = new Int16Array(nav.w * nav.h).fill(-1);
  const key = (x, y) => y * nav.w + x;
  dist[key(start.x, start.y)] = 0;
  const queue = [start];
  const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = dist[key(cur.x, cur.y)];
    for (const dir of dirs) {
      const nx = cur.x + dir.dx, ny = cur.y + dir.dy;
      if (!navIsWalkable(nx, ny)) continue;
      const k = key(nx, ny);
      if (dist[k] !== -1) continue;
      dist[k] = d + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

/* ---------------------------------------------------------------------
   3. Procedural audio (Web Audio API — no external sound files)
--------------------------------------------------------------------- */
const Audio3D = (() => {
  let ctx = null;
  let master = null;
  let gameGain = null;    // footsteps, doors, pickups, ambience — "صوت اللعبة"
  let monsterGain = null; // heartbeat, growls, jumpscare — "صوت الوحش"
  let droneGain = null;
  let noiseBuffer = null;
  let heartbeatTimer = null;
  let footstepTimer = 0;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);

    gameGain = ctx.createGain();
    gameGain.gain.value = (Settings.get("gameVolume") ?? 100) / 100;
    gameGain.connect(master);

    monsterGain = ctx.createGain();
    monsterGain.gain.value = (Settings.get("monsterVolume") ?? 100) / 100;
    monsterGain.connect(master);

    // Ambient drone: two detuned low sines + slow LFO tremolo
    const drone = ctx.createGain();
    drone.gain.value = 0.05;
    droneGain = drone;
    [55, 58].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(drone);
      osc.start();
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(drone.gain);
    lfo.start();
    drone.connect(gameGain);

    // Reusable white-noise buffer for footsteps / static / jumpscare
    const len = ctx.sampleRate * 1.2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  function setGameVolume(pct) { if (gameGain) gameGain.gain.value = Math.max(0, Math.min(1, pct / 100)); }
  function setMonsterVolume(pct) { if (monsterGain) monsterGain.gain.value = Math.max(0, Math.min(1, pct / 100)); }

  function noiseBurst({ duration = 0.15, freqLow = 500, freqHigh = 3000, gain = 0.4, bus = gameGain } = {}) {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = rand(freqLow, freqHigh);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(bp).connect(g).connect(bus || master);
    src.start();
    src.stop(ctx.currentTime + duration + 0.05);
  }

  function footstep() {
    noiseBurst({ duration: 0.09, freqLow: 120, freqHigh: 400, gain: 0.18, bus: gameGain });
  }

  function pickupChime() {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.5);
    osc.connect(g).connect(gameGain || master);
    osc.start();
    osc.stop(ctx.currentTime + 1);
  }

  function unlockSound() {
    noiseBurst({ duration: 1.1, freqLow: 80, freqHigh: 600, gain: 0.3, bus: gameGain });
  }

  function heartbeatPulse(intensity) {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 55;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.35 * intensity, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.connect(g).connect(monsterGain || master);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }

  function setDanger(danger01) {
    // danger01: 0 (safe) -> 1 (about to be caught). Drives heartbeat rate/volume.
    if (!ctx) return;
    clearTimeout(heartbeatTimer);
    if (danger01 <= 0.02) return;
    const interval = lerp(950, 260, danger01);
    heartbeatPulse(0.4 + danger01 * 0.8);
    heartbeatTimer = setTimeout(() => setDanger(danger01), interval);
  }

  function jumpscare() {
    noiseBurst({ duration: 1.4, freqLow: 60, freqHigh: 4000, gain: 0.9, bus: monsterGain });
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.3);
    osc.connect(g).connect(monsterGain || master);
    osc.start();
    osc.stop(ctx.currentTime + 1.4);
  }

  function stopAll() {
    clearTimeout(heartbeatTimer);
  }

  return { init, footstep, pickupChime, unlockSound, setDanger, jumpscare, stopAll, setGameVolume, setMonsterVolume };
})();

/* ---------------------------------------------------------------------
   4. Loading the corridor model (glTF, from Sketchfab)
--------------------------------------------------------------------- */
function withTimeout(promise, ms, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(timeoutMessage || "timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}
function loadMapModel(mapId) {
  if (mapTemplates[mapId]) return Promise.resolve(mapTemplates[mapId].clone(true));
  return new Promise((resolve, reject) => {
    const loader = new THREE.GLTFLoader();
    loader.load(
      mapUrl(mapId),
      (gltf) => {
        mapTemplates[mapId] = gltf.scene;
        setLoadingProgressText("");
        resolve(mapTemplates[mapId].clone(true));
      },
      // onProgress — big maps (hospital) were giving zero feedback while
      // downloading, so a slow load looked identical to a frozen one.
      (evt) => {
        if (evt && evt.lengthComputable) {
          const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
          setLoadingProgressText(`${pct}%`);
        }
      },
      (err) => reject(err)
    );
  });
}
function setLoadingProgressText(text) {
  const el = $("loadingProgressText");
  if (el) el.textContent = text;
}

/* ---------------------------------------------------------------------
   5. Navigation grid — built by raycasting straight down onto the model.
   A sample point is "walkable" if the first thing it hits from above is
   close to the lowest surface found anywhere (the floor). Anywhere a wall,
   piece of furniture, or rubble is the first hit instead, that point is
   marked solid. This needs no manual level authoring.
--------------------------------------------------------------------- */

// Free glTF exports are frequently off by a scale factor (wrong source unit,
// bad SketchUp/USD conversion, etc). Rather than trust the file's stated
// units, we measure the model's own floor-to-ceiling clearance by raycasting
// and rescale the whole thing so that clearance matches a normal room. This
// is what keeps the player from ending up giant (head above the ceiling) or
// tiny relative to the corridor.
const TARGET_CEILING_HEIGHT = 2.35; // meters — typical indoor ceiling
function measureSceneScale(modelGroup) {
  modelGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelGroup);
  const raycaster = new THREE.Raycaster();
  raycaster.far = (box.max.y - box.min.y) + 4;
  const down = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 1, 0);
  const clearances = [];
  for (let i = 0; i < 160; i++) {
    const x = rand(box.min.x, box.max.x);
    const z = rand(box.min.z, box.max.z);
    raycaster.set(new THREE.Vector3(x, box.max.y + 1, z), down);
    const dHits = raycaster.intersectObject(modelGroup, true);
    if (!dHits.length) continue;
    // Use the DEEPEST hit, not the first: for an enclosed room the first
    // thing a ray from above meets is usually the roof/ceiling, not the
    // floor. intersectObject sorts by distance from the ray origin (which
    // is above everything), so the last entry is the lowest surface hit —
    // the actual floor.
    const floorAtPoint = dHits[dHits.length - 1].point.y;
    raycaster.set(new THREE.Vector3(x, floorAtPoint + Math.min(0.05, raycaster.far), z), up);
    const uHits = raycaster.intersectObject(modelGroup, true);
    if (!uHits.length) continue;
    const clearance = uHits[0].point.y - floorAtPoint;
    if (clearance > 0.2) clearances.push(clearance);
  }
  if (!clearances.length) return 1;

  // Use the most common clearance (mode, via binning) rather than the raw
  // median: a room with door frames, low furniture, or hanging fixtures can
  // pull the plain median away from the *typical* ceiling height, which is
  // what previously made the player end up too tall relative to the room.
  // Ignore anything under 1.7m before binning: those samples are almost
  // always door frames/low beams, not the ceiling. Letting them win the
  // "most common" vote was making the whole model scale up too much,
  // which is why the player ended up too tall to fit through doorways.
  const MIN_PLAUSIBLE_CEILING = 1.7;
  const filtered = clearances.filter((c) => c >= MIN_PLAUSIBLE_CEILING);
  const pool = filtered.length ? filtered : clearances;

  const binSize = 0.05;
  const bins = new Map();
  for (const c of pool) {
    const bin = Math.round(c / binSize);
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  let bestBin = null, bestCount = -1;
  for (const [bin, count] of bins) {
    if (count > bestCount) { bestCount = count; bestBin = bin; }
  }
  const typicalClearance = bestBin * binSize;
  return clamp(TARGET_CEILING_HEIGHT / typicalClearance, 0.02, 50);
}

// Yields control back to the browser between chunks of heavy synchronous
// work (raycasting a whole grid) so the tab never looks frozen and the
// loading screen can actually update / a timeout can actually fire.
// Three.js r128 has no requestIdleCallback dependency, so a plain 0ms
// timeout is used — it still gives the event loop (and rendering) a turn.
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Counts triangles across every mesh in the model — used to size the nav
// grid to the model's actual complexity (see pickNavStep below) instead
// of assuming every map is as simple as the original corridor scan.
function countTriangles(modelGroup) {
  let tris = 0;
  modelGroup.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    if (geo.index) tris += geo.index.count / 3;
    else if (geo.attributes && geo.attributes.position) tris += geo.attributes.position.count / 3;
  });
  return tris;
}

// The corridor model (the original map this game shipped with) is ~52k
// triangles and a nav grid built from it at NAV_STEP=0.55 loads in well
// under a second. A dense scan like the hospital (~255k triangles, and a
// much bigger floor area) run through the SAME fixed 0.55 step was
// producing a grid with many thousands more cells, each doing up to two
// full raycasts against a 5x-heavier mesh — which is what was hanging
// the tab for over an hour with no crash and no feedback (a synchronous
// loop, so not even the network timeout could interrupt it once started).
// This scales the step up for bigger/denser maps so total raycasts stay
// in roughly the same ballpark regardless of which map is loaded.
const NAV_GRID_CELL_BUDGET = 4500; // target cell count for the whole grid
function pickNavStep(box, triCount) {
  const area = Math.max(1, (box.max.x - box.min.x) * (box.max.z - box.min.z));
  const complexity = Math.max(1, triCount / 50000); // corridor ≈ 1.0
  const step = Math.sqrt((area * complexity) / NAV_GRID_CELL_BUDGET);
  return clamp(step, NAV_STEP, 1.6); // never finer than the original 0.55m, cap how coarse it gets
}

async function buildNavGrid(modelGroup, box, onProgress) {
  const triCount = countTriangles(modelGroup);
  const step = pickNavStep(box, triCount);
  console.log(`[navgrid] ${triCount.toFixed(0)} tris -> step ${step.toFixed(2)}m (was fixed ${NAV_STEP}m)`);

  const raycaster = new THREE.Raycaster();
  raycaster.far = box.max.y - box.min.y + 4;
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const rayY = box.max.y + 1;

  const w = Math.max(2, Math.ceil((box.max.x - box.min.x) / step) + 1);
  const h = Math.max(2, Math.ceil((box.max.z - box.min.z) / step) + 1);
  const walkable = new Uint8Array(w * h);

  // Find the floor height. NOT simply the single lowest hit anywhere —
  // a dense photogrammetry scan (like the hospital) can have a handful
  // of stray/disconnected geometry far below the real floor (foundation
  // debris, exterior clutter caught in the scan, etc). Trusting the raw
  // minimum let one such stray point define "the floor," which spawned
  // the player far underneath the actual level looking up at its
  // underside from outside — exactly the "I'm outside the map" bug.
  // Instead, bin every hit's height and take the most COMMON height
  // (the floor virtually every probe lands on), which one or two outlier
  // points can't skew. Same idea as the mode-based binning already used
  // in measureSceneScale() above for scale correction.
  let lowest = Infinity;
  const probeHits = [];
  const ROWS_PER_CHUNK = 4;
  const chunkStart = performance.now();
  for (let cz = 0; cz < h; cz++) {
    for (let cx = 0; cx < w; cx++) {
      const wx = box.min.x + cx * step;
      const wz = box.min.z + cz * step;
      raycaster.set(new THREE.Vector3(wx, rayY, wz), down);
      const hits = raycaster.intersectObject(modelGroup, true);
      if (hits.length) {
        // Deepest hit, not the first: under an intact roof/ceiling the
        // first thing this downward ray meets is the roof, not the floor
        // beneath it. Sampling the first hit made the roof itself look
        // like "the floor" almost everywhere a ceiling was present, which
        // spawned the player up on top of the building looking down at it
        // instead of inside — the "I'm above the map" variant of this bug.
        const floorHit = hits[hits.length - 1].point.y;
        probeHits.push({ cx, cz, y: floorHit });
        if (floorHit < lowest) lowest = floorHit;
      }
    }
    if (cz % ROWS_PER_CHUNK === 0) {
      if (onProgress) onProgress(Math.round((cz / h) * 70)); // first pass ≈ 70% of this step's work
      await yieldToBrowser();
      if (performance.now() - chunkStart > 180000) throw new Error("navgrid-timeout");
    }
  }
  if (!isFinite(lowest)) lowest = box.min.y;

  if (probeHits.length) {
    const BIN = 0.15; // meters — coarse enough to absorb scan noise, fine enough to tell floors apart
    const counts = new Map();
    for (const hit of probeHits) {
      const bin = Math.round(hit.y / BIN);
      counts.set(bin, (counts.get(bin) || 0) + 1);
    }
    let bestBin = null, bestCount = -1;
    for (const [bin, count] of counts) {
      if (count > bestCount) { bestCount = count; bestBin = bin; }
    }
    // Only trust the mode if it's actually backed by a meaningful chunk of
    // the samples — otherwise (very sparse/noisy data) fall back to the
    // plain minimum rather than risk picking an arbitrary bin.
    if (bestBin !== null && bestCount >= Math.max(5, probeHits.length * 0.05)) {
      lowest = bestBin * BIN;
    }
  }

  // Was NAV_CLEARANCE_HEIGHT + 0.15 (1.77m). Real doorways in the corridor
  // scan/rescale can measure a little tighter than a full 1.77m of
  // clearance right at the frame (scan noise at the lintel, or the up-ray
  // catching the top of the door frame itself rather than the open
  // doorway just past it) even though a person can actually walk through
  // them fine. That was enough to mark doorway cells solid in the nav
  // grid, which reads as "can't enter the door" even though nothing is
  // really blocking it. A smaller margin still keeps out anything
  // meaningfully too low to walk through while giving real doorways room
  // to pass this check.
  const minClearance = NAV_CLEARANCE_HEIGHT + 0.04;
  for (let i = 0; i < probeHits.length; i++) {
    const hit = probeHits[i];
    if (hit.y <= lowest + FLOOR_TOLERANCE) {
      raycaster.set(new THREE.Vector3(box.min.x + hit.cx * step, hit.y + 0.05, box.min.z + hit.cz * step), up);
      const uHits = raycaster.intersectObject(modelGroup, true);
      const clearance = uHits.length ? (uHits[0].point.y - hit.y) : Infinity;
      if (clearance >= minClearance) {
        walkable[hit.cz * w + hit.cx] = 1;
      }
    }
    if (i % 200 === 0) {
      if (onProgress) onProgress(70 + Math.round((i / probeHits.length) * 30));
      await yieldToBrowser();
    }
  }

  nav = { originX: box.min.x, originZ: box.min.z, w, h, walkable };
  floorY = lowest;
}

/** After buildNavGrid marks cells walkable purely by floor-height + headroom,
 *  a dense photogrammetry scan (the hospital) can still leave a second,
 *  disconnected walkable patch at the exact same floor height as the real
 *  interior — an exterior courtyard/parking area caught in the scan, not
 *  reachable from inside the building at all. findOpenCell() below only
 *  ever looked at *local* openness, so a big flat outdoor patch like that
 *  would often win over the (more cluttered) real interior and become the
 *  spawn point: the player would load in able to see the hospital, but
 *  standing on a separate slab far away from it with no path in — the
 *  "outside the map" bug. Flood-fill every walkable region (matching the
 *  4-neighbour connectivity bfsPath/bfsDistances already use for movement)
 *  and discard every cell that isn't part of the single largest connected
 *  region, so spawn/keys/exit can only ever land somewhere actually
 *  reachable from each other. */
function keepLargestWalkableRegion() {
  const w = nav.w, h = nav.h;
  const visited = new Uint8Array(w * h);
  const dirs = [[0, -1], [0, 1], [1, 0], [-1, 0]];
  let bestRegion = null, bestSize = 0;
  for (let start = 0; start < w * h; start++) {
    if (nav.walkable[start] !== 1 || visited[start]) continue;
    const region = [start];
    visited[start] = 1;
    let qi = 0;
    while (qi < region.length) {
      const cur = region[qi++];
      const curX = cur % w, curZ = (cur / w) | 0;
      for (const [dx, dz] of dirs) {
        const nx = curX + dx, nz = curZ + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const nidx = nz * w + nx;
        if (nav.walkable[nidx] !== 1 || visited[nidx]) continue;
        visited[nidx] = 1;
        region.push(nidx);
      }
    }
    if (region.length > bestSize) { bestSize = region.length; bestRegion = region; }
  }
  if (!bestRegion) return;
  const keep = new Uint8Array(w * h);
  for (const idx of bestRegion) keep[idx] = 1;
  for (let i = 0; i < nav.walkable.length; i++) {
    if (nav.walkable[i] === 1 && !keep[i]) nav.walkable[i] = 0;
  }
}

/** Pick the walkable cell with the most walkable neighbours nearby — an open
 *  spot rather than a cramped corner — to use as a spawn/reference point. */
function findOpenCell(excludeNear) {
  let best = null, bestScore = -1;
  for (let cz = 0; cz < nav.h; cz++) {
    for (let cx = 0; cx < nav.w; cx++) {
      if (!navIsWalkable(cx, cz)) continue;
      if (excludeNear && Math.hypot(cx - excludeNear.x, cz - excludeNear.y) < 3) continue;
      let score = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (navIsWalkable(cx + dx, cz + dz)) score++;
        }
      }
      if (score > bestScore) { bestScore = score; best = { x: cx, y: cz }; }
    }
  }
  return best;
}

/* ---------------------------------------------------------------------
   6. Scene construction
--------------------------------------------------------------------- */
/** Generates a dark, faintly starry night-sky texture on a canvas so the
 *  void beyond the fog looks like an eerie night rather than flat black. */
function makeNightSkyTexture() {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "#05040a");
  grad.addColorStop(0.55, "#0b0714");
  grad.addColorStop(1, "#100a1a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size * 0.7; // stars mostly in the upper sky
    const r = Math.random() * 1.1 + 0.2;
    ctx.globalAlpha = Math.random() * 0.6 + 0.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
  return tex;
}

async function buildScene() {
  scene = new THREE.Scene();
  scene.background = makeNightSkyTexture();
  // Fog tinted to match the night sky (dark purple-black) instead of pure
  // black, so the corridor blends into an atmosphere rather than a void.
  scene.fog = new THREE.FogExp2(0x0b0714, 0.05);

  camera = new THREE.PerspectiveCamera(Settings.get("fov"), window.innerWidth / window.innerHeight, 0.05, 60);
  pitchObject = new THREE.Object3D();
  // Explicit, not just relying on the three.js default: the local camera
  // must only see layer 0. LOCAL_BODY_LAYER (1) is where the player's own
  // visible-body mesh lives (see attachLocalBodyModel) so it can never
  // wrap around / clip into the first-person view, no matter what the
  // model's rig looks like.
  camera.layers.enable(0);
  camera.layers.disable(LOCAL_BODY_LAYER);
  pitchObject.add(camera);
  yawObject = new THREE.Object3D();
  yawObject.add(pitchObject);
  scene.add(yawObject);
  setupLocalBody();

  // Antialiasing (MSAA) is a WebGL context-creation flag — it can't be
  // toggled after the renderer exists, so it has to be decided from the
  // saved quality setting right here. This is the single biggest GPU/heat
  // cost on weak phones, which is why "low" was still hot/laggy before:
  // AA was always on no matter what the quality dropdown said.
  const _initialQuality = Settings.get("graphicsQuality") || "high";
  renderer = new THREE.WebGLRenderer({
    canvas: $("gameCanvas"),
    antialias: _initialQuality !== "low",
    powerPreference: "high-performance"
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  applyGraphicsQuality();

  // Ambient — barely there, this is a horror house. Kept as a named
  // reference (not scene.add(new ...) inline) so updateHouseLighting()
  // below can dim it out during a blackout.
  houseAmbient = new THREE.AmbientLight(0x1a1620, 0.55);
  scene.add(houseAmbient);

  ambientFlickerLight = new THREE.PointLight(0xffb066, 1.1, 9, 2);
  scene.add(ambientFlickerLight);

  // Flashlight, parented to the camera rig so it always points where you look
  flashlight = new THREE.SpotLight(0xfff1d6, 0, 15, THREE.MathUtils.degToRad(32), 0.45, 1.6);
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(1024, 1024);
  flashlight.shadow.bias = -0.001;
  camera.add(flashlight);
  flashTarget = new THREE.Object3D();
  flashTarget.position.set(0, 0, -1);
  camera.add(flashTarget);
  flashlight.target = flashTarget;
  flashlight.position.set(0, 0, 0);

  mazeGroup = new THREE.Group();
  scene.add(mazeGroup);

  // --- Load the real map ---
  // Give the network load a hard timeout: if the CDN/hosting hiccups and
  // GLTFLoader never calls its success or error callback, we'd otherwise
  // sit on "جارٍ تحميل الموارد..." forever with no feedback at all.
  const modelGroup = await withTimeout(
    loadMapModel(currentMapId()),
    mapTimeout(currentMapId()),
    "map-load-timeout"
  );
  mapMeshGroup = modelGroup;
  modelGroup.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Correct for the model's export scale so 1 world unit here is really
  // about 1 meter — fixes the player ending up giant/tiny relative to the room.
  const scaleCorrection = MANUAL_SCALE_OVERRIDE || measureSceneScale(modelGroup);
  console.log(
    `[scale] applied ${scaleCorrection.toFixed(3)}` +
    (MANUAL_SCALE_OVERRIDE ? " (manual override)" : " (auto-measured — set MANUAL_SCALE_OVERRIDE in game.js if this still looks wrong)")
  );
  modelGroup.scale.multiplyScalar(scaleCorrection);
  modelGroup.updateMatrixWorld(true);

  scene.add(modelGroup);

  // Force materials double-sided *before* any raycasting against this model:
  // the free scan sometimes has faces with normals facing the wrong way
  // (a roof/ceiling panel is the classic case), which single-sided
  // materials would render as an invisible gap AND make invisible to a
  // downward raycast — letting the nav-grid probe below fall straight
  // through to open sky and get misread as "floor" through a hole that
  // isn't really there.
  modelGroup.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => { m.side = THREE.DoubleSide; });
    }
  });

  const box = new THREE.Box3().setFromObject(modelGroup);
  await buildNavGrid(modelGroup, box, (pct) => setLoadingProgressText(`تجهيز الخريطة… ${pct}%`));
  keepLargestWalkableRegion();

  // Hard outer boundary: no matter what gaps exist in the level geometry,
  // the player can never step past the model's own footprint, shrunk
  // inward by the player's collision radius.
  levelBounds = {
    minX: box.min.x + PLAYER_RADIUS,
    maxX: box.max.x - PLAYER_RADIUS,
    minZ: box.min.z + PLAYER_RADIUS,
    maxZ: box.max.z - PLAYER_RADIUS,
  };

  // --- Spawn, keys, exit, monster on the navigation grid ---
  const spawnCell = findOpenCell(null);
  spawnWorld = navCellToWorld(spawnCell.x, spawnCell.y);
  yawObject.position.set(spawnWorld.x, floorY + EYE_HEIGHT, spawnWorld.z);
  state.restY = floorY + EYE_HEIGHT; // keep the jump-free base in sync with the fresh spawn height
  ambientFlickerLight.position.set(spawnWorld.x, floorY + 2.2, spawnWorld.z);

  const dist = bfsDistances(spawnCell);
  const reachable = [];
  for (let cz = 0; cz < nav.h; cz++) {
    for (let cx = 0; cx < nav.w; cx++) {
      const d = dist[cz * nav.w + cx];
      if (d > 0) reachable.push({ x: cx, y: cz, d });
    }
  }
  reachable.sort((a, b) => a.d - b.d);

  if (reachable.length) {
    const exitCell = reachable[reachable.length - 1];
    exitWorld = navCellToWorld(exitCell.x, exitCell.y);
  } else {
    // Degenerate map (couldn't find a second reachable cell) — fall back to spawn.
    exitWorld = { x: spawnWorld.x, z: spawnWorld.z };
  }

  // Keys, exit marker, and monster placement — disabled for now, you're
  // rebuilding these yourself. Leaving placeKeys/buildExitMarker/buildMonster
  // defined below untouched in case you want to wire back into them, but
  // nothing calls them anymore, and totalKeys is forced to 0 so nothing in
  // the HUD/win-condition code expects keys that don't exist.
  state.totalKeys = 0;
}

/* ---------------------------------------------------------------------
   7. Keys (collectibles) — placed on reachable floor cells at spread-out
   BFS distances from the spawn point, so they pull the player through
   different parts of the real map instead of clustering near the start.
--------------------------------------------------------------------- */
function placeKeys(reachable) {
  const geo = new THREE.TorusKnotGeometry(0.16, 0.055, 64, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe8973a, emissive: 0x92500f, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.7,
  });

  const n = state.totalKeys;
  const pool = reachable.slice(0, Math.max(0, reachable.length - 1)); // leave the very farthest cell for the exit
  const used = [];

  for (let i = 0; i < n; i++) {
    // Aim each key at a different percentile of BFS distance from spawn.
    const targetIdx = Math.floor(((i + 1) / (n + 1)) * pool.length);
    let candidate = pool[clamp(targetIdx, 0, pool.length - 1)];
    // Nudge away from previously placed keys if too close.
    let tries = 0;
    while (candidate && used.some((u) => Math.hypot(u.x - candidate.x, u.y - candidate.y) < 3) && tries < 30) {
      candidate = pool[clamp(targetIdx + tries + 1, 0, pool.length - 1)];
      tries++;
    }
    if (!candidate) candidate = pool[pool.length - 1] || reachable[reachable.length - 1];
    if (!candidate) continue; // degenerate map with almost no reachable floor — skip this key
    used.push(candidate);

    const pos = navCellToWorld(candidate.x, candidate.y);
    const key = new THREE.Mesh(geo, mat);
    key.position.set(pos.x, floorY + 1.1, pos.z);
    key.castShadow = true;
    const light = new THREE.PointLight(0xe8973a, 1.4, 3.5, 2);
    light.position.set(0, 0, 0);
    key.add(light);
    key.userData.collected = false;
    mazeGroup.add(key);
    keyMeshes.push(key);
  }
  state.totalKeys = keyMeshes.length;
}

/* ---------------------------------------------------------------------
   8. Exit marker — the map has no physical door, so the exit is a lit
   marker at the reachable point farthest (by BFS) from the spawn. It's
   inert until all keys are collected.
--------------------------------------------------------------------- */
function buildExitMarker() {
  const ringGeo = new THREE.TorusGeometry(0.7, 0.06, 12, 32);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x5a1414, emissive: 0x8a1414, emissiveIntensity: 0.6, roughness: 0.5,
  });
  exitMarker = new THREE.Mesh(ringGeo, ringMat);
  exitMarker.rotation.x = Math.PI / 2;
  exitMarker.position.set(exitWorld.x, floorY + 0.05, exitWorld.z);
  scene.add(exitMarker);

  exitLight = new THREE.PointLight(0x8a1414, 0.9, 6, 2);
  exitLight.position.set(exitWorld.x, floorY + 1.4, exitWorld.z);
  scene.add(exitLight);
}

function unlockExit() {
  state.exitUnlocked = true;
  exitMarker.material.color.set(0x2a6fd8);
  exitMarker.material.emissive.set(0x4fa0ff);
  exitLight.color.set(0x88bfff);
  exitLight.intensity = 2.2;
  Audio3D.unlockSound();
  showToast("الباب مفتوح الآن... اهرب!");
}

/* ---------------------------------------------------------------------
   9. The Monster
--------------------------------------------------------------------- */
function buildMonster() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95 });
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 1.35, 8), bodyMat);
  torso.position.y = 0.9;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 10), bodyMat);
  head.position.y = 1.65;
  group.add(head);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1111, emissiveIntensity: 2.2 });
  const eyeGeo = new THREE.SphereGeometry(0.035, 6, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.09, 1.67, 0.19);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.09, 1.67, 0.19);
  group.add(eyeL, eyeR);
  const glow = new THREE.PointLight(0xff2222, 0, 4, 2);
  glow.position.set(0, 1.65, 0);
  group.add(glow);

  group.visible = false;
  scene.add(group);

  monster = {
    group, glow,
    pos: { x: 0, z: 0 },
    cell: { x: 0, y: 0 },
    path: [],
    mode: "idle",
    speed: 1.55,
    recalcTimer: 0,
    bobT: Math.random() * 10,
  };
}

function monsterSpawnFarFromPlayer() {
  const playerCell = worldToNavCell(yawObject.position.x, yawObject.position.z);
  const best = findOpenCell(playerCell) || playerCell;
  monster.cell = best;
  const w = navCellToWorld(best.x, best.y);
  monster.pos.x = w.x; monster.pos.z = w.z;
  monster.group.position.set(w.x, floorY, w.z);
  monster.group.visible = true;
  monster.mode = "patrol";
  state.monsterActive = true;
}

let mpMonsterSyncAcc = 0;

// In multiplayer, the host runs the real monster AI (below) and broadcasts
// its position/mode over Firebase a few times a second; guests just receive
// and smoothly follow that state so everyone in the room sees the same
// monster instead of each client hallucinating its own.
function updateMonster(dt) {
  const isGuest = state.mp.active && !state.mp.isHost;

  if (isGuest) {
    const remote = window.Multiplayer && Multiplayer.getMonsterState();
    if (!remote || !remote.active) {
      if (state.monsterActive) { state.monsterActive = false; if (monster) monster.group.visible = false; }
      updateDangerVignette(0);
      Audio3D.setDanger(0);
      return;
    }
    if (!state.monsterActive) { state.monsterActive = true; monster.group.visible = true; }
    monster.pos.x = lerp(monster.pos.x, remote.x, 0.35);
    monster.pos.z = lerp(monster.pos.z, remote.z, 0.35);
    monster.mode = remote.mode;
  } else {
    if (!state.monsterActive) return;
    monster.recalcTimer -= dt;

    const px = yawObject.position.x, pz = yawObject.position.z;
    const dxi = px - monster.pos.x, dzi = pz - monster.pos.z;
    const distNow = Math.hypot(dxi, dzi);

    if (monster.recalcTimer <= 0) {
      monster.recalcTimer = 0.55;
      const noiseRadius = state.sprinting ? 9.5 : state.moving ? 5.5 : 2.5;
      const playerCell = worldToNavCell(px, pz);

      if (monster.mode === "chase") {
        if (distNow > 17) monster.mode = "patrol";
      } else if (distNow < noiseRadius) {
        monster.mode = "chase";
      }

      if (monster.mode === "chase") {
        const path = bfsPath(monster.cell, playerCell);
        if (path) monster.path = path;
      } else if (!monster.path.length) {
        const target = { x: (Math.random() * nav.w) | 0, y: (Math.random() * nav.h) | 0 };
        const path = navIsWalkable(target.x, target.y) ? bfsPath(monster.cell, target) : null;
        if (path) monster.path = path;
      }
    }

    const diffMul = (DIFFICULTY_TABLE[currentDifficulty()] || DIFFICULTY_TABLE.normal).speedMul;
    monster.speed = (monster.mode === "chase" ? (state.exitUnlocked ? 2.55 : 2.05) : 1.35) * diffMul;

    if (monster.path.length) {
      const next = monster.path[0];
      const w = navCellToWorld(next.x, next.y);
      const mdx = w.x - monster.pos.x, mdz = w.z - monster.pos.z;
      const d = Math.hypot(mdx, mdz);
      const step = monster.speed * dt;
      if (d <= step) {
        monster.pos.x = w.x; monster.pos.z = w.z;
        monster.cell = { x: next.x, y: next.y };
        monster.path.shift();
      } else {
        monster.pos.x += (mdx / d) * step;
        monster.pos.z += (mdz / d) * step;
      }
    }

    if (state.mp.active && state.mp.isHost && window.Multiplayer) {
      mpMonsterSyncAcc += dt;
      if (mpMonsterSyncAcc > 0.15) {
        mpMonsterSyncAcc = 0;
        Multiplayer.sendMonsterState(monster.pos.x, monster.pos.z, monster.mode, true);
      }
    }
  }

  const px = yawObject.position.x, pz = yawObject.position.z;
  const dx = px - monster.pos.x, dz = pz - monster.pos.z;
  const distToPlayer = Math.hypot(dx, dz);

  monster.bobT += dt * 6;
  monster.group.position.set(monster.pos.x, floorY + Math.sin(monster.bobT) * 0.03, monster.pos.z);
  monster.group.rotation.y = Math.atan2(dx, dz);

  const closeGlow = clamp(1 - distToPlayer / 8, 0, 1);
  monster.glow.intensity = closeGlow * 2.2;

  const danger01 = clamp(1 - distToPlayer / 10, 0, 1) * (monster.mode === "chase" ? 1 : 0.35);
  updateDangerVignette(danger01);
  Audio3D.setDanger(monster.mode === "chase" ? danger01 : 0);

  if (distToPlayer < CATCH_RADIUS) {
    triggerDeath();
  }
}

/* ---------------------------------------------------------------------
   10. Player controller
--------------------------------------------------------------------- */
const pointerState = { locked: false, dragging: false, unavailable: false };
let footstepAcc = 0;

function setupPointerLock() {
  const canvas = $("gameCanvas");

  // Some embedding contexts (sandboxed iframes/webviews without
  // allow="pointer-lock", some in-app browsers) either lack
  // requestPointerLock entirely or silently reject every lock request.
  // Without a fallback, the look-around never works at all in those cases
  // even though the code above is fine on a normal desktop browser. So:
  // try pointer lock first, but if it's unsupported or fails, fall back to
  // click-and-drag look (still desktop-only; touch already has its own
  // lookZone drag handling).
  const hasPointerLock = !!canvas.requestPointerLock;
  if (!hasPointerLock) pointerState.unavailable = true;

  canvas.addEventListener("click", () => {
    if (!state.running || isCoarsePointer || pointerState.locked) return;
    if (hasPointerLock && !pointerState.unavailable) canvas.requestPointerLock();
  });
  document.addEventListener("pointerlockchange", () => {
    pointerState.locked = document.pointerLockElement === canvas;
  });
  document.addEventListener("pointerlockerror", () => {
    // Lock got rejected by the browser/embedder — stop trying and switch
    // to the drag fallback below instead of leaving the camera stuck.
    pointerState.unavailable = true;
    pointerState.locked = false;
  });

  // Drag-to-look fallback for when pointer lock isn't available.
  canvas.addEventListener("mousedown", (e) => {
    if (!state.running || isCoarsePointer || !pointerState.unavailable) return;
    pointerState.dragging = true;
    pointerState.lastX = e.clientX;
    pointerState.lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => { pointerState.dragging = false; });

  document.addEventListener("mousemove", (e) => {
    if (!state.running) return;
    const sens = 0.0022 * Settings.get("sensitivity");
    let dx = 0, dy = 0;
    if (pointerState.locked) {
      dx = e.movementX; dy = e.movementY;
    } else if (pointerState.unavailable && pointerState.dragging) {
      dx = e.clientX - pointerState.lastX; dy = e.clientY - pointerState.lastY;
      pointerState.lastX = e.clientX; pointerState.lastY = e.clientY;
    } else {
      return;
    }
    state.yaw -= dx * sens;
    state.pitch -= dy * sens;
    state.pitch = clamp(state.pitch, -1.3, 1.3);
  });
}

let noclip = false;
function setupKeyboard() {
  window.addEventListener("keydown", (e) => {
    state.keysHeld[e.code] = true;
    if (e.code === "KeyF") toggleFlashlight();
    if (e.code === "KeyE") tryInteract();
    if (e.code === "Space") triggerJump();
    if (e.code === "KeyN" && state.running) {
      noclip = !noclip;
      showToast(noclip ? "تصادم الجدران: إيقاف (تصحيح)" : "تصادم الجدران: تشغيل");
    }
    // Live height tuning: [ makes you shorter, ] makes you taller.
    // Once it looks right, note the number in the toast and set
    // EYE_HEIGHT to that value permanently near the top of game.js.
    if ((e.code === "BracketLeft" || e.code === "BracketRight") && state.running) {
      EYE_HEIGHT = clamp(EYE_HEIGHT + (e.code === "BracketRight" ? 0.05 : -0.05), 1.0, 2.2);
      showToast(`طول اللاعب: ${EYE_HEIGHT.toFixed(2)} م (اضبطه بـ [ و ] ثم دوّن الرقم بالكود)`);
    }
  });
  window.addEventListener("keyup", (e) => { state.keysHeld[e.code] = false; });
}

/* --- Mobile touch controls ---------------------------------------------
   The actual button/stick wiring (setupControls) now lives in controls.js
   — this shared `touch` object is what it reads from and writes to, and
   what updatePlayer() above reads every frame, so it stays declared here
   where the rest of the player-movement state lives. */
const touch = { moveActive: false, moveId: null, moveVec: { x: 0, y: 0 }, lookId: null, lastLook: null, runHeld: false };

function toggleFlashlight() {
  if (!state.flashlightOn && state.battery <= 1) return;
  state.flashlightOn = !state.flashlightOn;
}

// Starts a jump arc (see JUMP_SPEED/JUMP_GRAVITY + updatePlayer). Called
// from the Space key and from the touch jump button in controls.js.
// Ignored while already airborne, so holding/mashing it doesn't stack.
function triggerJump() {
  if (!state.running || state.jumping) return;
  state.jumping = true;
  state.jumpVel = JUMP_SPEED;
}

function tryInteract() {
  const p = yawObject.position;
  for (const key of keyMeshes) {
    if (key.userData.collected) continue;
    const d = Math.hypot(key.position.x - p.x, key.position.z - p.z);
    if (d < KEY_PICK_RADIUS) {
      collectKey(key);
      return;
    }
  }
}

function collectKey(key) {
  key.userData.collected = true;
  mazeGroup.remove(key);
  state.keysCollected++;
  Audio3D.pickupChime();
  const pip = $("pip" + (state.keysCollected - 1));
  if (pip) pip.classList.add("filled");
  showToast(`التقطتَ مفتاحًا (${state.keysCollected}/${state.totalKeys})`);
  const diff = DIFFICULTY_TABLE[currentDifficulty()] || DIFFICULTY_TABLE.normal;
  const canSpawnMonster = !state.mp.active || state.mp.isHost;
  if (!state.monsterActive && diff.monsterEnabled && canSpawnMonster) {
    setTimeout(() => {
      if (state.running && !state.gameOver) {
        monsterSpawnFarFromPlayer();
        showToast("شيء ما استيقظ في المنزل...");
      }
    }, diff.spawnDelay * 1000);
  }
  if (state.keysCollected >= state.totalKeys) {
    unlockExit();
  }
}

/** Is this world position inside a cell the navigation grid marked
 *  walkable? Built from real down/up raycasts against the visible model,
 *  so — unlike per-mesh bounding boxes — it can't be fooled by an
 *  irregularly-shaped scan chunk whose rectangular footprint spans past
 *  a doorway or gap that isn't actually solid there. */
function navWalkableAtWorld(x, z) {
  if (!nav) return true;
  const cell = worldToNavCell(x, z);
  return navIsWalkable(cell.x, cell.y);
}

/** Same check, but for the player's actual footprint (a circle of
 *  PLAYER_RADIUS), not just its center point. The old center-only check
 *  let the camera get right up against — and visually into — a wall
 *  whenever the wall's edge fell inside a "walkable" cell rather than
 *  exactly on a cell boundary, which is most of the time. Sampling around
 *  the radius catches that instead of only reacting once the exact
 *  center crosses into a blocked cell. */
function navWalkableCircle(x, z) {
  if (!nav) return true;
  if (!navWalkableAtWorld(x, z)) return false;
  const SAMPLES = 8;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    if (!navWalkableAtWorld(x + Math.cos(a) * PLAYER_RADIUS, z + Math.sin(a) * PLAYER_RADIUS)) return false;
  }
  return true;
}

/** Real-geometry backstop for the nav grid above. The grid only samples a
 *  floor point every NAV_STEP (0.55m) meters — perfectly fine for finding
 *  "is there floor here", but a wall or a closed door that's thinner than
 *  that gap (common on denser scanned maps like the hospital, less so on
 *  the original thick-walled corridor) can sit entirely *between* two
 *  sample points and never get marked solid. This casts a short ray from
 *  where the player currently is toward where they're trying to move, at
 *  a couple of body heights, against the actual loaded map mesh — so it
 *  catches thin geometry regardless of grid resolution. Extending the ray
 *  by PLAYER_RADIUS means it blocks the move once the player's body edge
 *  (not just the center point) would reach the wall, not only once the
 *  center itself has already passed through it. */
const wallRaycaster = new THREE.Raycaster();
function raySweepBlocked(x1, z1, x2, z2) {
  if (!mapMeshGroup) return false;
  const dx = x2 - x1, dz = z2 - z1;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-5) return false;
  const dir = new THREE.Vector3(dx / dist, 0, dz / dist);
  const checkDist = dist + PLAYER_RADIUS;
  // Ankle height catches low obstacles/door thresholds; chest height
  // catches most door/wall geometry without also snagging on low clutter.
  const heights = [0.35, Math.max(0.9, EYE_HEIGHT - 0.5)];
  for (let i = 0; i < heights.length; i++) {
    wallRaycaster.far = checkDist;
    wallRaycaster.set(new THREE.Vector3(x1, floorY + heights[i], z1), dir);
    const hits = wallRaycaster.intersectObject(mapMeshGroup, true);
    if (hits.length && hits[0].distance < checkDist) return true;
  }
  return false;
}

/** Combines both checks: the nav grid ("is there floor to stand on") and
 *  the real-geometry raycast above ("is a wall/door actually in the way
 *  along this specific move"). Both must pass. */
function pathClear(x1, z1, x2, z2) {
  return navWalkableCircle(x2, z2) && !raySweepBlocked(x1, z1, x2, z2);
}

function resolvePlayerCollision(pos, prevPos) {
  // Axis-separated: try the X move and Z move independently, so sliding
  // along a wall still works instead of getting fully stuck when only one
  // axis is blocked.
  let x = prevPos.x, z = prevPos.z;
  if (pathClear(prevPos.x, prevPos.z, pos.x, prevPos.z)) x = pos.x;
  if (pathClear(x, prevPos.z, x, pos.z)) z = pos.z;
  pos.x = x;
  pos.z = z;

  // Hard fallback: never allow the player past the level's outer footprint,
  // even if there's a gap in the wall geometry that the checks above miss.
  if (levelBounds) {
    pos.x = clamp(pos.x, levelBounds.minX, levelBounds.maxX);
    pos.z = clamp(pos.z, levelBounds.minZ, levelBounds.maxZ);
  }
}

/* ---------------------------------------------------------------------
   9b. House power / blackouts — the ambient room light and the warm
   point light that follows the player aren't on a fixed flicker forever;
   the house's power actually fails for stretches at a time, fading down
   over a couple of seconds (not an instant cut) and back up later, so you
   end up relying on the flashlight battery instead of always having some
   ambient light to fall back on.
--------------------------------------------------------------------- */
function updateHouseLighting(dt) {
  state.survivalTime += dt;

  if (state.survivalTime >= state.nextBlackoutAt) {
    const goingDark = state.power > 0.5;
    const target = goingDark ? 0 : 1;
    state.power = lerp(state.power, target, dt * (goingDark ? 0.7 : 0.2));
    if (Math.abs(state.power - target) < 0.02) {
      state.power = target;
      state.nextBlackoutAt = state.survivalTime + (target === 0 ? rand(9, 16) : rand(22, 38));
    }
  }

  // A bit of extra instability while the power is mid-transition (dying
  // down or limping back on) reads as electrical trouble rather than a
  // clean fade; fully-on or fully-off stays calmer.
  const unstable = state.power > 0.02 && state.power < 0.98;
  const flicker = unstable ? (Math.random() > 0.85 ? rand(0.5, 1) : 1) : 1;

  if (houseAmbient) houseAmbient.intensity = 0.55 * state.power * flicker;
  if (ambientFlickerLight) {
    ambientFlickerLight.intensity =
      (0.85 + Math.random() * 0.4 * (Math.random() > 0.94 ? 0.2 : 1)) * state.power * flicker;
  }
}

function updatePlayer(dt) {
  yawObject.rotation.y = state.yaw;
  pitchObject.rotation.x = state.pitch;

  let ix = 0, iz = 0;
  if (isCoarsePointer) {
    ix = touch.moveVec.x; iz = -touch.moveVec.y;
  } else {
    if (state.keysHeld["KeyW"]) iz += 1;
    if (state.keysHeld["KeyS"]) iz -= 1;
    if (state.keysHeld["KeyD"]) ix += 1;
    if (state.keysHeld["KeyA"]) ix -= 1;
  }
  const inputLen = Math.hypot(ix, iz);
  state.moving = inputLen > 0.05;

  state.sprinting = state.moving && (state.keysHeld["ShiftLeft"] || state.keysHeld["ShiftRight"] || touch.runHeld) && state.stamina > 1;
  if (state.sprinting) state.stamina = clamp(state.stamina - dt * 26, 0, 100);
  else state.stamina = clamp(state.stamina + dt * 14, 0, 100);
  if (state.stamina <= 0) state.sprinting = false;

  const speed = state.sprinting ? SPRINT_SPEED : WALK_SPEED;

  // Jump arc: simple velocity + gravity integration, added on top of the
  // normal eye-height below — see JUMP_SPEED/JUMP_GRAVITY and triggerJump().
  if (state.jumping) {
    state.jumpVel -= JUMP_GRAVITY * dt;
    state.jumpOffset += state.jumpVel * dt;
    if (state.jumpOffset <= 0) {
      state.jumpOffset = 0;
      state.jumpVel = 0;
      state.jumping = false;
    }
  }

  if (state.moving) {
    const euler = new THREE.Euler(0, state.yaw, 0, "YXZ");
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);
    const right = new THREE.Vector3(1, 0, 0).applyEuler(euler);
    const move = new THREE.Vector3();
    move.addScaledVector(forward, iz / inputLen);
    move.addScaledVector(right, ix / inputLen);
    move.normalize().multiplyScalar(speed * dt);

    const newPos = { x: yawObject.position.x + move.x, z: yawObject.position.z + move.z };
    if (!noclip) resolvePlayerCollision(newPos, { x: yawObject.position.x, z: yawObject.position.z });
    yawObject.position.x = newPos.x;
    yawObject.position.z = newPos.z;

    footstepAcc += dt;
    const stepInterval = state.sprinting ? 0.28 : 0.46;
    if (footstepAcc > stepInterval) {
      footstepAcc = 0;
      Audio3D.footstep();
    }
    // subtle head bob
    state.restY = floorY + EYE_HEIGHT + Math.sin(performance.now() * 0.012) * (state.sprinting ? 0.045 : 0.025);
    yawObject.position.y = state.restY + state.jumpOffset;
  } else {
    // Lerp toward eye-height from the last RESTING y (state.restY), not
    // from yawObject.position.y directly. The old version lerped from
    // position.y, which already had the previous frame's jumpOffset baked
    // into it — then added the new jumpOffset again on top, so every
    // still-standing jump frame compounded on top of a base that already
    // included jump height. That runaway stacking is what let a single
    // jump send the camera high enough to clip through the map ceiling
    // ("القفزة عالية جدًا لدرجة اني اخترقت الماب"). Keeping a clean,
    // jump-free base in state.restY and only adding jumpOffset once at
    // the end keeps the jump arc's actual peak (~0.6m, per JUMP_SPEED/
    // JUMP_GRAVITY) instead of letting it snowball.
    state.restY = lerp(state.restY, floorY + EYE_HEIGHT, 0.15);
    yawObject.position.y = state.restY + state.jumpOffset;
  }

  // Flashlight battery
  const battMul = (DIFFICULTY_TABLE[currentDifficulty()] || DIFFICULTY_TABLE.normal).batteryDrainMul;
  if (state.flashlightOn) {
    // Was 3.2 (~31s to fully drain on normal difficulty) — dropped a lot
    // per request, full battery now lasts several minutes of continuous
    // use instead of half a minute.
    state.battery = clamp(state.battery - dt * 0.35 * battMul, 0, 100);
    if (state.battery <= 0) state.flashlightOn = false;
  } else {
    state.battery = clamp(state.battery + dt * 1.3, 0, 100);
  }
  flashlight.intensity = state.flashlightOn ? 2.4 + Math.sin(performance.now() * 0.03) * 0.06 : 0;

  // Auto key-pickup prompt visibility
  let nearInteractable = false;
  for (const key of keyMeshes) {
    if (key.userData.collected) continue;
    if (Math.hypot(key.position.x - yawObject.position.x, key.position.z - yawObject.position.z) < KEY_PICK_RADIUS) {
      nearInteractable = true; break;
    }
  }
  $("interactPrompt").classList.toggle("show", nearInteractable);
  if (nearInteractable && isCoarsePointer) tryInteract();

  // Win check — reached the exit marker after all keys are collected
  if (state.exitUnlocked && !state.won) {
    const d = Math.hypot(yawObject.position.x - exitWorld.x, yawObject.position.z - exitWorld.z);
    if (d < 1.4) {
      triggerWin();
    }
  }

  // House power/blackouts handled centrally in updateHouseLighting().
}

/* ---------------------------------------------------------------------
   11. HUD
--------------------------------------------------------------------- */
function updateDangerVignette(v) {
  $("dangerVignette").style.opacity = v.toFixed(2);
}

let toastTimer = null;
function showToast(msg) {
  const el = $("objectiveToast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function updateHud() {
  const pct = Math.round(state.battery);
  $("batteryFill").style.width = state.battery + "%";
  $("batteryPercent").textContent = pct + "%";
  $("batteryHud").classList.toggle("low", state.battery <= 20);
  $("staminaFill").style.width = state.stamina + "%";
}

/* ---------------------------------------------------------------------
   12. Game lifecycle
--------------------------------------------------------------------- */
function resetState() {
  state.keysHeld = {};
  state.keysCollected = 0;
  state.exitUnlocked = false;
  state.battery = 100;
  state.flashlightOn = false;
  state.stamina = 100;
  state.sprinting = false;
  state.moving = false;
  state.jumping = false;
  state.jumpVel = 0;
  state.jumpOffset = 0;
  touch.runHeld = false;
  state.monsterActive = false;
  state.monsterMode = "idle";
  state.gameOver = false;
  state.won = false;
  state.yaw = 0;
  state.pitch = 0;
  state.power = 1;
  state.survivalTime = 0;
  state.nextBlackoutAt = rand(18, 30); // first blackout arrives a bit into the run
  wallList = [];
  levelBounds = null;
  keyMeshes = [];
  ["pip0", "pip1", "pip2"].forEach((id) => $(id).classList.remove("filled"));
}

function clearScene() {
  if (scene) {
    while (scene.children.length) scene.remove(scene.children[0]);
  }
  mpAvatars = {};
  localBody = null;
  mapMeshGroup = null;
}

/* ---------------------------------------------------------------------
   12b. Multiplayer avatars — other players in the same room are shown
   using a real character model when one is available for their gender
   (loaded below), falling back to a simple colored primitive figure for
   any gender that doesn't have one yet or while the real model is still
   downloading. Position is synced over Firebase Realtime Database (see
   multiplayer.js).
--------------------------------------------------------------------- */
let mpAvatars = {};
let mpSyncAcc = 0;

// --- Real character models (glTF) ---------------------------------------
// One entry per gender; add more here as models become available (e.g. a
// "monster" model). Loaded once and cached as a template, then cloned per
// avatar. A gender with no entry (or a failed load) silently falls back
// to buildPrimitiveCharacterModel below.
const CHARACTER_MODEL_URLS = {
  boy: "models/Zamour/Idle.fbx",
  girl: "models/Elora/Woman_01.gltf",
  boy2: "models/Karnak/Karnak.gltf",
};
// suffix names differ per model export (e.g. "basecolor" vs "Albedo"), so
// each map key is spelled out per gender instead of assumed. Any slot left
// out (e.g. boy2 has no roughness file) is simply skipped in
// applyCharacterTextures below and that PBR channel stays at its default.
// "boy" (Zamour) has no entry here — it's an .obj/.mtl export (see
// loadCharacterModel) whose material + textures come straight from its
// own .mtl file, so there's no separate PBR prefix to wire up for it.
const CHARACTER_TEX_PREFIX = {
  girl: {
    prefix: "models/Elora/texture/Woman_01_", ext: "jpg",
    basecolor: "basecolor", normal: "normal", roughness: "roughness", metallic: "metallic",
  },
  boy2: {
    prefix: "models/Karnak/textures/Man_Body_", ext: "png",
    basecolor: "Albedo", normal: "Normals",
    // No metallic or roughness file shipped for this export (only
    // Albedo/Normals/Ao — the "Ao" map isn't wired up here since it needs
    // a second UV set). There used to be a "metallic: 'Metallic'" entry
    // here pointing at a Man_Body_Metallic.png that was never actually
    // part of this export — that 404'd every load, leaving metalnessMap
    // null while the material's flat `metalness` base (see the
    // MeshStandardMaterial below) still applied at full strength to the
    // whole model. A fully metallic surface with no environment map to
    // reflect renders almost black except at grazing highlights, which is
    // exactly the "model looks dark/like before" bug — removing the dead
    // map reference lets the metalness default below fall back to 0 for
    // this character instead of silently staying a "metal" with nothing
    // to reflect.
  },
};
// Every valid character key, in the order they should appear as menu
// cards. Anything not in this list falls back to "boy".
const CHARACTER_KEYS = Object.keys(CHARACTER_MODEL_URLS);
function normalizeGender(g) {
  return CHARACTER_KEYS.includes(g) ? g : "boy";
}
// Used for any gender with no texture files above, so it renders as a
// tinted material instead of flat, characterless white.
const CHARACTER_FLAT_COLOR = {};
const CHARACTER_TARGET_HEIGHT = 1.75; // meters — normal adult standing height
const characterTemplates = {};        // gender -> loaded THREE.Group, once ready
const characterLoadPromises = {};     // gender -> in-flight/settled load promise
const characterAnimClips = {};        // gender -> gltf.animations array (may be empty) — see attachCharacterAnimator

// Plain THREE.Object3D.clone(true) does NOT give a SkinnedMesh its own
// independent skeleton — SkinnedMesh.copy() just repoints the clone's
// `skeleton` property at the SAME skeleton object as the source, bones
// and all. So every clone (and the original template) ends up sharing
// one set of bones: animating one clone's bones either does nothing
// visually (the mesh still skins against the original template's bone
// transforms) or, worse, animates every OTHER clone and the template
// too. THREE.SkeletonUtils.clone() is built specifically to rebuild a
// proper independent skeleton for each clone, which is what every
// character clone actually needs now that some of them get bones
// animated directly (walk/run cycle) or driven by an AnimationMixer
// (attachCharacterAnimator). Only setupLocalBody's clone used to do this
// correctly — this makes it the one path everyone goes through.
function cloneCharacterModel(template) {
  return (THREE.SkeletonUtils && THREE.SkeletonUtils.clone)
    ? THREE.SkeletonUtils.clone(template)
    : template.clone(true);
}

// --- Rest-pose correction (arms) -------------------------------------
// Both player models ship with their arms held out away from the body
// (a "T-pose"-ish rest pose baked into the rig — visible as the arms
// looking flared out / raised to the sides, like about to fly) instead
// of hanging naturally at the sides. There's no baked "idle" animation
// clip to fall back on, so this nudges the upper-arm bones back down
// toward the body once, right after the model loads — a permanent fix
// to the rest pose itself, not a per-frame animation. It's applied on
// the template (before any clones are made / before collectAnimBones
// captures baseRot on each clone), so every spawned copy — hub preview,
// lobby preview, and in-game — inherits the corrected pose automatically,
// and the existing idle-sway / walk-cycle code keeps working exactly as
// before, just layered on top of this new resting angle instead of the
// old flared one.
//
// Degrees are around each bone's own *local* Z axis (rotateZ — the same
// convention Three.js uses, applied in the bone's current local frame
// regardless of how it happens to be oriented), which on this rig's
// bone convention is the axis that swings the arm in/out from the body
// (X is already used elsewhere for the forward/back walk swing). L and R
// are mirrored on purpose — the two arms need opposite-signed angles.
//
// NOTE: these starting values (45°) are an untested first guess — I
// can't render the WebGL scene from here to see the actual result. If
// the arms move the WRONG way (more flared instead of less) after
// testing in the browser, flip both signs (45 -> -45); if they move the
// right way but not far/close enough, just raise or lower the number.
// A screenshot after trying it tells us exactly which and by how much.
const CHARACTER_POSE_FIX = {
  boy: {
    L_Upperarm: { z: 45 },
    R_Upperarm: { z: -45 },
  },
  girl: {
    // Elora (Woman_01.gltf) has no skeleton at all — just a single
    // static mesh node — so its arm pose can't be adjusted here; it can
    // only be fixed by re-posing/re-exporting the source model itself.
  },
  boy2: {
    // Karnak's own bind pose is a stiff, flared-out stance (basically a
    // loose T-pose) — not a hand-tuned guess like the "boy" fix above.
    // Instead of guessing angles, these are the EXACT rest-arm rotations
    // read directly out of Karnak's own embedded "mixamo_com" animation
    // clip (frame 0 of models/Karnak/Karnak.gltf's animations[0], via its
    // buffer.bin — every arm-chain bone that clip actually animates).
    // Applying them once here, statically, gives the same natural
    // relaxed-arms standing look the clip settles into — without needing
    // to actually run that clip through an AnimationMixer every frame.
    // That matters on weak devices: a live mixer is one more per-frame
    // cost, and running a second full WebGL scene for the hub preview
    // alongside the main game scene has already been observed losing its
    // GPU context entirely partway through on old/low-memory phones,
    // freezing mid-animation. A one-time static pose has none of that
    // risk — it's set once at load and never touched again.
    mixamorig_LeftShoulder:  { quat: [-0.667106, -0.332300,  0.539234, -0.392140] },
    mixamorig_LeftArm:       { quat: [ 0.486607,  0.250988,  0.056065,  0.834910] },
    mixamorig_LeftForeArm:   { quat: [-0.000165, -0.011149,  0.012734,  0.999857] },
    mixamorig_LeftHand:      { quat: [ 0.072936, -0.297533, -0.011085,  0.951857] },
    mixamorig_RightShoulder: { quat: [-0.661734,  0.335669, -0.558361, -0.371035] },
    mixamorig_RightArm:      { quat: [ 0.415706, -0.346903, -0.086051,  0.836327] },
    mixamorig_RightForeArm:  { quat: [ 0.006356,  0.143926, -0.058034,  0.987865] },
    mixamorig_RightHand:     { quat: [ 0.076550,  0.057359,  0.044018,  0.994441] },
  },
};

function applyRestPoseFix(root, gender) {
  const fix = CHARACTER_POSE_FIX[gender];
  if (!fix) return;
  root.traverse((o) => {
    const bf = fix[o.name];
    if (!bf) return;
    if (bf.quat) {
      // Absolute override — replaces the bone's bind rotation outright
      // (used for Karnak's arm-chain fix above), rather than rotating
      // relative to whatever it currently is.
      o.quaternion.set(bf.quat[0], bf.quat[1], bf.quat[2], bf.quat[3]);
      return;
    }
    if (bf.x) o.rotateX(THREE.MathUtils.degToRad(bf.x));
    if (bf.y) o.rotateY(THREE.MathUtils.degToRad(bf.y));
    if (bf.z) o.rotateZ(THREE.MathUtils.degToRad(bf.z));
  });
}

// --- Market: purchasable outfits for Karnak (the "boy2" character) -------
// Each item fully replaces the boy2 model/gltf (not a layered clothing
// system) — buying+equipping one points CHARACTER_MODEL_URLS.boy2 at a
// different file and forces that character to reload. Add more entries
// here (with matching folders under models/market/) for future items.
const MARKET_DEFAULT_BOY2_URL = CHARACTER_MODEL_URLS.boy2; // the original Karnak model, kept as the "no item equipped" fallback
const MARKET_BOY2_TEX_PREFIX_DEFAULT = CHARACTER_TEX_PREFIX.boy2; // original Karnak texture config, restored when unequipping
const MARKET_ITEMS = [
  {
    id: "outfit_karnak",
    name: "حزمة ملابس Karnak",
    desc: "طقم كامل جديد لشخصية Karnak.",
    category: "طقم",
    icon: "market-icons/outfit-karnak.png",
    modelUrl: "models/market/Outfit Bundle/Karnak/Karnak.gltf",
  },
  {
    id: "pants_karnak",
    name: "حزمة سروال Karnak",
    desc: "سروال جديد لشخصية Karnak.",
    category: "سروال",
    icon: "market-icons/pants-karnak.png",
    modelUrl: "models/market/Clothes/Pants/Karnak/Karnak.gltf",
  },
];

// Persisted as {owned: [ids...], equipped: id|null} — null equipped means
// Karnak's original default look (Karnak).
function marketLoadState() {
  try {
    const raw = localStorage.getItem("dlb_market");
    if (!raw) return { owned: [], equipped: null };
    const parsed = JSON.parse(raw);
    return { owned: Array.isArray(parsed.owned) ? parsed.owned : [], equipped: parsed.equipped || null };
  } catch { return { owned: [], equipped: null }; }
}
function marketSaveState(s) {
  try { localStorage.setItem("dlb_market", JSON.stringify(s)); } catch {}
}

// Points CHARACTER_MODEL_URLS.boy2 at the right file for whatever is
// currently equipped (or the default model if nothing is), and forces a
// fresh load next time boy2 is needed — the hub preview and char lobby
// preview both call getOrLoadCharacterModel/loadCharacterModel again on
// their own render loop, so clearing the cached template here is enough
// to make the swap visible without any extra reload call.
function marketApplyEquip() {
  const s = marketLoadState();
  const item = MARKET_ITEMS.find((i) => i.id === s.equipped);
  CHARACTER_MODEL_URLS.boy2 = item ? item.modelUrl : MARKET_DEFAULT_BOY2_URL;
  // The market items ship with their own self-contained materials (no
  // loose texture files), unlike the base Karnak export — so skip
  // the Man_Body_* texture pass for them, or it'll try to paint textures
  // meant for a completely different model onto this one.
  if (item) delete CHARACTER_TEX_PREFIX.boy2;
  else CHARACTER_TEX_PREFIX.boy2 = MARKET_BOY2_TEX_PREFIX_DEFAULT;
  delete characterTemplates.boy2;
  delete characterLoadPromises.boy2;
}

// Market view state — which tab, which category filter, which sort
// order. Kept in memory only (resets when you leave the screen); not
// persisted like owned/equipped since it's just a browsing preference.
let marketViewState = { tab: "market", category: "all", sortDir: "asc" };

function renderMarketScreen() {
  const s = marketLoadState();
  const grid = $("marketGrid");
  grid.innerHTML = "";

  // Tab decides which subset of items we start from:
  //  - market: everything
  //  - requests ("الطلبات" -> treated as "your items"): only owned items
  //  - shop ("المتجر" -> treated as "still available"): only not-yet-owned items
  let items = MARKET_ITEMS.slice();
  if (marketViewState.tab === "requests") items = items.filter((i) => s.owned.includes(i.id));
  else if (marketViewState.tab === "shop") items = items.filter((i) => !s.owned.includes(i.id));

  // Category filter (cycled by the FILTER button)
  if (marketViewState.category !== "all") {
    items = items.filter((i) => (i.category || "عنصر") === marketViewState.category);
  }

  // Alphabetical sort (direction toggled by the sort button)
  items.sort((a, b) => marketViewState.sortDir === "asc"
    ? a.name.localeCompare(b.name, "ar")
    : b.name.localeCompare(a.name, "ar"));

  if (items.length === 0) {
    grid.innerHTML = `<div class="market-empty">لا توجد عناصر هنا حالياً</div>`;
  }

  items.forEach((item) => {
    const owned = s.owned.includes(item.id);
    const equipped = s.equipped === item.id;
    const card = document.createElement("div");
    card.className = "market-card";
    const btnClass = equipped ? "equipped" : (owned ? "owned" : "");
    const btnLabel = equipped ? "مُفعّلة ✓" : (owned ? "تفعيل" : "احصل عليها");
    card.innerHTML = `
      <img src="${item.icon}" alt="${item.name}">
      <div class="market-card-body">
        <div class="market-card-category">${item.category || "عنصر"}</div>
        <div class="market-card-name">${item.name}</div>
        <div class="market-card-desc">${item.desc}</div>
        <button class="market-buy-btn ${btnClass}" data-id="${item.id}">${btnLabel}</button>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll(".market-buy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const cur = marketLoadState();
      if (!cur.owned.includes(id)) cur.owned.push(id);
      cur.equipped = (cur.equipped === id) ? null : id; // tap again to unequip back to default
      marketSaveState(cur);
      if (window.Multiplayer) Multiplayer.syncProfileData();
      marketApplyEquip();
      renderMarketScreen();
      showToast(cur.equipped === id ? "تم التفعيل" : "رجعت للشكل الافتراضي");
    });
  });
}

// Some character exports (the base Karnak model in particular) carry a
// leftover camera + point light baked right into the glTF scene graph —
// remnants of whatever tool exported them, not anything meant for this
// game. GLTFLoader instantiates those as real THREE.Light/THREE.Camera
// objects and wires them into the loaded root, so every spawned/cloned
// copy of that character silently drags its own extra light source into
// the scene — stacking with (and overpowering) the game's own designed
// lighting (houseAmbient / ambientFlickerLight / exitLight) instead of
// each character being lit by that shared lighting on its own. Strip
// them out right after load, before the model is cached as a template
// or cloned for any avatar.
function stripEmbeddedLightsAndCameras(root, gender) {
  const junk = [];
  root.traverse((o) => {
    if (o.isLight || o.isCamera) junk.push(o);
    // Disable per-object frustum culling on every mesh. Three.js computes
    // a mesh's culling bounding sphere once, from its BIND-POSE geometry.
    // Once bones actually animate (walk/run/idle sway), the true on-screen
    // position keeps moving away from that frozen sphere, so the engine
    // can start culling a character that is still plainly in view — this
    // is the "plays fine, then randomly disappears" bug. Set once here on
    // the shared template, it carries through to every SkeletonUtils clone
    // (Object3D.copy() copies frustumCulled), so this only needs doing once.
    if (o.isMesh) o.frustumCulled = false;
  });
  junk.forEach((o) => o.parent && o.parent.remove(o));
  if (junk.length) {
    console.warn(`[player model] "${gender}" export had ${junk.length} embedded light/camera node(s) baked in — removed them.`);
  }
}

// Some character exports (like Zamour's Idle.fbx — a Mixamo-style export
// with a baked "mixamo.com" animation take) come as .fbx instead of
// .gltf. FBXLoader hands its result straight back as the model's root
// Object3D (no ".scene" wrapper like GLTFLoader's result) with any clips
// on ".animations" — everything downstream (light/camera stripping,
// texture pass, scale/pose normalization, the animator) already works
// generically off a plain Object3D root, so only the loader + result
// shape differ here.
function isFbxUrl(url) {
  return /\.fbx($|\?)/i.test(url);
}

// FBX "takes" are rarely named anything the Idle/Walk/Run matcher in
// getLocomotionClips recognizes — Mixamo exports in particular are just
// called "mixamo.com" regardless of which animation they actually
// contain. Renaming the clip after the source *filename* (Idle.fbx ->
// "Idle") lets it be picked up as a real embedded clip instead of being
// ignored and silently replaced by a baked/procedural one.
function renameFbxClipsFromFilename(url, clips) {
  const base = (url.split("/").pop() || "").replace(/\.fbx$/i, "");
  if (!/idle|walk|run|sprint/i.test(base)) return;
  clips.forEach((clip) => { clip.name = base; });
}

function loadCharacterModel(gender) {
  if (characterLoadPromises[gender]) return characterLoadPromises[gender];
  const url = CHARACTER_MODEL_URLS[gender];
  if (!url) return Promise.resolve(null);

  const useFbx = isFbxUrl(url) && typeof THREE.FBXLoader !== "undefined";
  if (isFbxUrl(url) && !useFbx) {
    console.warn(`[player model] "${gender}" points at an .fbx file but THREE.FBXLoader isn't loaded — falling back to the primitive figure`);
  }

  characterLoadPromises[gender] = new Promise((resolve) => {
    if (!useFbx) {
      if (isFbxUrl(url)) { resolve(null); return; }
      const loader = new THREE.GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          const root = gltf.scene;
          stripEmbeddedLightsAndCameras(root, gender);
          applyCharacterTextures(root, gender);
          normalizeCharacterScale(root);
          applyRestPoseFix(root, gender);
          characterAnimClips[gender] = gltf.animations || []; // embedded clips (e.g. an "Idle" clip from an auto-rig site) — see attachCharacterAnimator
          characterTemplates[gender] = root;
          resolve(root);
        },
        undefined,
        (err) => {
          console.warn(`[player model] failed to load "${gender}" model, using fallback figure`, err);
          resolve(null);
        }
      );
      return;
    }

    const loader = new THREE.FBXLoader();
    // Idle.fbx embeds its textures as binary content baked into the file
    // itself, so FBXLoader normally never needs to fetch them externally.
    // This is only a fallback for the (unlikely) case a texture isn't
    // embedded — it points at the same folder the existing Zamour.gltf
    // export's loose textures already live in, since they share the same
    // image0.png..image8.png filenames.
    loader.setResourcePath("models/Zamour/textures/");
    loader.load(
      url,
      (object) => {
        try {
          const root = object;
          stripEmbeddedLightsAndCameras(root, gender);
          applyCharacterTextures(root, gender);
          normalizeCharacterScale(root);
          applyRestPoseFix(root, gender);
          const clips = object.animations || [];
          renameFbxClipsFromFilename(url, clips);
          characterAnimClips[gender] = clips;
          characterTemplates[gender] = root;
          resolve(root);
        } catch (err) {
          console.warn(`[player model] "${gender}" FBX loaded but failed to process, using fallback figure`, err);
          resolve(null);
        }
      },
      undefined,
      (err) => {
        console.warn(`[player model] failed to load "${gender}" FBX model, using fallback figure`, err);
        resolve(null);
      }
    );
  });
  return characterLoadPromises[gender];
}

// Some exports carry no image/texture references inside the glTF itself
// (just a bare material name) — common for AI-generated models whose PBR
// maps ship as loose files, or for untextured single-mesh conversions —
// so the maps (or a flat fallback tint) are wired up by hand here. flipY
// is turned off because glTF UVs assume a top-left origin, the opposite
// of THREE.TextureLoader's default.
//
// If a gender has no entry in CHARACTER_TEX_PREFIX at all (e.g. Zamour,
// or a market outfit — see marketApplyEquip), that means its glTF already
// ships fully self-contained materials/textures of its own, baked in at
// export time. Those are left completely alone here — this function used
// to always replace every mesh's material (with a flat gray fallback in
// that case), which silently wiped out any such model's real textures.
function applyCharacterTextures(root, gender) {
  const texCfg = CHARACTER_TEX_PREFIX[gender];
  if (!texCfg) {
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    return;
  }
  const texLoader = new THREE.TextureLoader();
  const load = (suffix, srgb) => {
    const tex = texLoader.load(`${texCfg.prefix}${suffix}.${texCfg.ext}`);
    tex.flipY = false;
    if (srgb && THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  };
  const material = new THREE.MeshStandardMaterial({
    map: texCfg.basecolor ? load(texCfg.basecolor, true) : null,
    normalMap: texCfg.normal ? load(texCfg.normal, false) : null,
    roughnessMap: texCfg.roughness ? load(texCfg.roughness, false) : null,
    metalnessMap: texCfg.metallic ? load(texCfg.metallic, false) : null,
    roughness: 1,
    // Flat `metalness` used to always be 1 regardless of whether a real
    // metalnessMap existed. With a map, 1 is the right multiplier (the map
    // itself carries the 0-1 detail per-pixel). Without one — Karnak has
    // no metallic map at all — a flat metallic base with no environment
    // map to reflect renders the whole character almost black, since a
    // pure metal has no diffuse response. Falling back to 0 (a normal
    // non-metal skin/cloth response to the room's lights) is what actually
    // keeps a map-less character visibly lit instead of going dark.
    metalness: texCfg.metallic ? 1 : 0,
  });
  root.traverse((o) => {
    if (o.isMesh) {
      o.material = material;
      o.castShadow = true;
      o.receiveShadow = false;
    }
  });
}

// AI-generated exports are frequently a couple of "generic" units tall
// rather than real-world meters (this one is ~0.98 units). Measure the
// model's own bounding box and rescale + re-anchor it to a normal human
// height standing on y=0, regardless of what scale/pivot it shipped at —
// same idea as measureSceneScale() above for the corridor model.
//
// Auto-rigging sites (e.g. Mixamo-style pipelines) commonly export with
// Z as the "up" axis instead of the Y-up convention glTF/three.js expect.
// Loaded as-is, a Z-up character ends up lying on its side/back instead
// of standing — which also throws off the height measurement below,
// since it then measures the model's WIDTH (much bigger than its real
// height) as if it were height, and scales the whole thing too big on
// top of leaving it flat. Detect that case from the raw bounding box
// (a standing humanoid is taller than it is wide/deep; a fallen-over one
// isn't) and rotate it upright before any scale/height math runs.
function fixModelOrientation(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const sizeY = box.max.y - box.min.y;
  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  const widestHorizontal = Math.max(sizeX, sizeZ);
  // A standing person is clearly taller than they are wide. If the
  // vertical extent is smaller than the widest horizontal one, the model
  // is lying flat rather than standing — almost certainly a Z-up export
  // loaded without conversion.
  if (widestHorizontal > 0.01 && sizeY < widestHorizontal * 0.85) {
    // Rotate Z-up to Y-up. Confirmed by testing: +90° about X is the
    // correct direction for this pipeline's exports (the first attempt
    // used -90° and that landed the model upside-down instead — see the
    // conversation this fix came from).
    root.rotateX(Math.PI / 2);
    root.updateMatrixWorld(true);
    console.warn("[player model] detected a flat (Z-up?) export — rotated upright. If it looks wrong in-game, see fixModelOrientation() in game.js.");
  }
}

function normalizeCharacterScale(root) {
  fixModelOrientation(root);
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  if (height > 0.01) {
    const scale = CHARACTER_TARGET_HEIGHT / height;
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
  }
  root.position.y -= box.min.y; // feet to y = 0
  root.updateMatrixWorld(true);

  // Eye height, measured off the model's own top-of-head instead of a
  // bone (this rig's "Head" bone actually sits down near the base of the
  // neck, not the crown — using it directly had the camera sitting near
  // chest height). An average adult's eyes sit a small, fairly constant
  // distance below the very top of the head regardless of body height,
  // so this works whether or not the model even has a skeleton (the girl
  // model doesn't). Stashed on the template so every clone reuses it.
  const EYE_BELOW_CROWN = 0.11; // meters
  root.userData.eyeHeight = box.max.y - EYE_BELOW_CROWN;
}

// --- Character animation system -------------------------------------
// Every character — whether its glTF shipped real animation clips or
// just a static bind pose — is now driven through ONE
// THREE.AnimationMixer with up to three blended states (Idle / Walk /
// Run), the same locomotion-blend approach a real game engine (or the
// reference glTF viewer at gltf-viewer.donmccurdy.com) uses to play a
// model's clips. This replaces the old split system, which had two bugs:
//   1. A model with an embedded clip played ONLY that one clip ("Idle")
//      forever through AnimationMixer — nothing ever drove Walk/Run
//      through that path, so those characters never appeared to move.
//   2. Every SkinnedMesh kept Three.js's default frustumCulled = true,
//      which culls against a bounding sphere computed once from the
//      static BIND POSE. As soon as bones actually animated away from
//      that pose, the (now stale) bounding sphere could fall outside the
//      camera frustum even though the character was still on screen —
//      which is exactly what "animation works, then the character
//      disappears" looks like. Fixed in stripEmbeddedLightsAndCameras().
//
// If a model has no embedded Idle/Walk/Run clips of its own (true for
// every character in this game right now), matching ones are BAKED once
// per template — from the same bone-role detection used everywhere else
// (BONE_ROLE_ALIASES) — into real THREE.AnimationClip keyframe tracks.
// From that point on, embedded-clip and procedural characters alike are
// driven through the exact same mixer/action/crossfade code.
const LEG_SWING_SIGN = 1;

// Different export pipelines name their bones differently — the original
// "boy" (Zamour) rig uses L_Thigh/R_Thigh/etc, but Karnak and most
// Mixamo-style auto-rig sites (including the one used for the new Karnak
// re-export) use names like "mixamorig_LeftUpLeg" instead. The animator
// below used to only ever look for the L_Thigh-style names — on any rig
// that doesn't use that exact convention, EVERY bone lookup silently
// failed (collectAnimBones found nothing), so the model never animated
// at all and just sat frozen in whatever pose the file shipped with —
// almost always a T-pose. This maps a handful of known naming
// conventions onto the same canonical role names the animator uses, so
// idle sway / walk / run apply regardless of which convention a given
// character's rig happens to use.
const BONE_ROLE_ALIASES = {
  L_Thigh:    ["l_thigh", "leftupleg", "mixamorig_leftupleg", "mixamorig:leftupleg", "upperleg_l", "thigh_l"],
  R_Thigh:    ["r_thigh", "rightupleg", "mixamorig_rightupleg", "mixamorig:rightupleg", "upperleg_r", "thigh_r"],
  L_Calf:     ["l_calf", "leftleg", "mixamorig_leftleg", "mixamorig:leftleg", "lowerleg_l", "calf_l", "shin_l"],
  R_Calf:     ["r_calf", "rightleg", "mixamorig_rightleg", "mixamorig:rightleg", "lowerleg_r", "calf_r", "shin_r"],
  L_Upperarm: ["l_upperarm", "leftarm", "mixamorig_leftarm", "mixamorig:leftarm", "upperarm_l"],
  R_Upperarm: ["r_upperarm", "rightarm", "mixamorig_rightarm", "mixamorig:rightarm", "upperarm_r"],
  Spine01:    ["spine01", "spine1", "mixamorig_spine1", "mixamorig:spine1", "spine_01"],
  Spine02:    ["spine02", "spine2", "mixamorig_spine2", "mixamorig:spine2", "spine_02"],
};
const ANIM_BONE_NAMES = Object.keys(BONE_ROLE_ALIASES);

/** Finds the bones this animator drives, once per model instance, and
 *  records each one's original (bind-pose) rotation so animation can be
 *  applied as an offset from it rather than overwriting it. Matches each
 *  canonical role (L_Thigh, R_Thigh, ...) against every known naming
 *  convention in BONE_ROLE_ALIASES, case-insensitively, so it works
 *  whichever rig/export pipeline a given character came from. */
function collectAnimBones(root) {
  const bones = {};
  root.traverse((o) => {
    const lname = o.name.toLowerCase();
    for (const role of ANIM_BONE_NAMES) {
      if (bones[role]) continue; // first match wins
      if (BONE_ROLE_ALIASES[role].includes(lname)) bones[role] = o;
    }
  });
  for (const k in bones) bones[k].userData.baseRot = bones[k].rotation.clone();
  return bones;
}

/** Locates the neck bone (scaling it to ~0 hides neck+head — used for the
 *  local player's own body, see setupLocalBody) and the head bone (used to
 *  measure eye height). Either may be null if the rig doesn't have them.
 *  Same multi-convention matching as collectAnimBones above — the
 *  original code only ever matched "NeckTwist01"/"Head" literally, which
 *  a mixamorig_-style rig (Karnak, and most auto-rigged exports) never
 *  has, so the neck-hide trick silently never fired for those models. */
function locateHeadBones(root) {
  let neck = null, head = null;
  const NECK_NAMES = ["necktwist01", "neck", "mixamorig_neck", "mixamorig:neck"];
  const HEAD_NAMES = ["head", "mixamorig_head", "mixamorig:head"];
  root.traverse((o) => {
    const lname = o.name.toLowerCase();
    if (!neck && NECK_NAMES.includes(lname)) neck = o;
    if (!head && HEAD_NAMES.includes(lname)) head = o;
  });
  return { neck, head };
}

/** Same per-role swing formulas the old hand-written per-frame animator
 *  used (see git history), just evaluated at fixed sample times so they
 *  can be baked into a real keyframe track instead of being re-computed
 *  every frame. speed 0..1 (1 = full sprint); speed < 0.03 is treated as
 *  "standing" (idle breathing sway) by the caller, not by this function. */
function sampleLocomotionSwing(role, t, speed) {
  if (speed <= 0) {
    const breathe = Math.sin(t * 1.6) * 0.02;
    const sway = Math.sin(t * 0.7) * 0.02;
    switch (role) {
      case "Spine02": return breathe;
      case "Spine01": return breathe * 0.5;
      case "L_Upperarm": return sway;
      case "R_Upperarm": return -sway;
      default: return 0;
    }
  }
  const freq = 6 + speed * 4;
  const legAmp = 0.5 * speed;
  const kneeAmp = 0.85 * speed;
  const armAmp = 0.45 * speed;
  const phase = t * freq;
  switch (role) {
    case "L_Thigh": return Math.sin(phase) * legAmp;
    case "R_Thigh": return Math.sin(phase + Math.PI) * legAmp;
    case "L_Calf": return Math.max(0, -Math.sin(phase + 0.6)) * kneeAmp;
    case "R_Calf": return Math.max(0, -Math.sin(phase + Math.PI + 0.6)) * kneeAmp;
    case "L_Upperarm": return Math.sin(phase + Math.PI) * armAmp;
    case "R_Upperarm": return Math.sin(phase) * armAmp;
    case "Spine02": return Math.sin(phase) * 0.03;
    default: return 0;
  }
}

/** Bakes one real THREE.AnimationClip (a QuaternionKeyframeTrack per
 *  detected bone) out of sampleLocomotionSwing, looping seamlessly over
 *  `duration` seconds at `fps` keyframes/sec. `bones` comes from
 *  collectAnimBones() run on the TEMPLATE — the resulting clip's tracks
 *  target bones by NAME, so THREE.AnimationMixer resolves them correctly
 *  against any clone (or the template itself), same as an embedded clip
 *  would be. Returns null if there are no recognized bones to animate. */
function bakeLocomotionClip(name, bones, duration, fps, speed) {
  const roles = Object.keys(bones);
  if (!roles.length) return null;
  const steps = Math.max(2, Math.round(duration * fps));
  const times = [];
  for (let i = 0; i <= steps; i++) times.push((i / steps) * duration);

  const tracks = [];
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (const role of roles) {
    const bone = bones[role];
    const base = bone.userData.baseRot;
    if (!base) continue;
    euler.order = bone.rotation.order;
    const values = [];
    for (const t of times) {
      const dx = sampleLocomotionSwing(role, t, speed);
      euler.set(base.x + dx * LEG_SWING_SIGN, base.y, base.z);
      quat.setFromEuler(euler);
      values.push(quat.x, quat.y, quat.z, quat.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  return tracks.length ? new THREE.AnimationClip(name, duration, tracks) : null;
}

const characterLocomotionClips = {}; // gender -> { idle, walk, run } (THREE.AnimationClip | null), cached once

/** Resolves the Idle/Walk/Run clip set for a gender: prefers the glTF's
 *  own embedded clips (matched by name), and bakes any missing ones from
 *  the detected rig bones (see bakeLocomotionClip). Computed once per
 *  gender and cached — every clone reuses the same clip objects. */
function getLocomotionClips(gender) {
  if (characterLocomotionClips[gender]) return characterLocomotionClips[gender];
  const embedded = characterAnimClips[gender] || [];
  const findEmbedded = (re) => embedded.find((c) => re.test(c.name)) || null;
  let idle = findEmbedded(/idle/i);
  let walk = findEmbedded(/walk/i);
  let run = findEmbedded(/run|sprint/i);

  const template = characterTemplates[gender];
  if ((!idle || !walk || !run) && template) {
    const bones = collectAnimBones(template);
    if (Object.keys(bones).length) {
      const WALK_SPEED = 0.55, RUN_SPEED = 1.0;
      idle = idle || bakeLocomotionClip("Idle", bones, 20, 10, 0);
      walk = walk || bakeLocomotionClip("Walk", bones, (2 * Math.PI) / (6 + 4 * WALK_SPEED), 30, WALK_SPEED);
      run = run || bakeLocomotionClip("Run", bones, (2 * Math.PI) / (6 + 4 * RUN_SPEED), 30, RUN_SPEED);
    }
  }
  characterLocomotionClips[gender] = { idle, walk, run };
  return characterLocomotionClips[gender];
}

/** Attaches a full locomotion-blended animator to a model instance: one
 *  THREE.AnimationMixer with up to three actions (Idle/Walk/Run — each
 *  either the glTF's own embedded clip or a baked one, see
 *  getLocomotionClips) whose weights are cross-blended every frame by
 *  update(dt, speed). This is the single animation path for every
 *  character now — replaces the old attachIdleAnimation (which only ever
 *  played "Idle", forever, for models with embedded clips) and
 *  animateCharacterBones (hand-rotated bones, used only for models
 *  without embedded clips). Returns null if this gender has no playable
 *  clips at all (e.g. a model with no skeleton). */
function attachCharacterAnimator(model, gender) {
  const clips = getLocomotionClips(gender);
  if (!clips.idle && !clips.walk && !clips.run) return null;

  const mixer = new THREE.AnimationMixer(model);
  const makeAction = (clip) => {
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.play();
    action.setEffectiveWeight(0);
    return action;
  };
  const actions = { idle: makeAction(clips.idle), walk: makeAction(clips.walk), run: makeAction(clips.run) };
  const first = actions.idle || actions.walk || actions.run;
  first.setEffectiveWeight(1);

  return {
    mixer,
    actions,
    update(dt, speed) {
      speed = clamp(speed || 0, 0, 1);
      // Two-segment blend: 0 = full idle, 0.5 = full walk, 1 = full run.
      const hasWalkOrRun = !!(actions.walk || actions.run);
      const wWalk = speed <= 0.5 ? clamp(speed / 0.5, 0, 1) : clamp(1 - (speed - 0.5) / 0.5, 0, 1);
      const wRun = clamp((speed - 0.5) / 0.5, 0, 1);
      const wIdle = hasWalkOrRun ? clamp(1 - speed / 0.5, 0, 1) : 1;
      if (actions.idle) actions.idle.setEffectiveWeight(wIdle);
      if (actions.walk) actions.walk.setEffectiveWeight(wWalk);
      if (actions.run) actions.run.setEffectiveWeight(wRun);
      mixer.update(dt);
    },
  };
}

/** Returns the best available model for a gender right now: a clone of the
 *  real glTF model if it's already loaded, otherwise the primitive
 *  fallback figure. Also kicks off loading the real model in the
 *  background if nobody has requested it yet, so upgradeAvatarModels()
 *  can swap it in once it's ready. */
function buildCharacterModel(gender) {
  const g = normalizeGender(gender);
  if (characterTemplates[g]) return cloneCharacterModel(characterTemplates[g]);
  loadCharacterModel(g); // fire and forget — upgraded later if/when it resolves
  return buildPrimitiveCharacterModel(g);
}

/** Swaps any already-spawned avatars of this gender from the primitive
 *  fallback figure over to the real model, once it finishes loading. */
function upgradeAvatarModels(gender) {
  const template = characterTemplates[gender];
  if (!template) return;
  for (const uid in mpAvatars) {
    const rec = mpAvatars[uid];
    if (rec.gender !== gender || rec.usingRealModel) continue;
    rec.group.remove(rec.charModel);
    rec.charModel = cloneCharacterModel(template);
    rec.anim = attachCharacterAnimator(rec.charModel, gender);
    rec.group.add(rec.charModel);
    rec.usingRealModel = true;
  }
}

/* ---------------------------------------------------------------------
   12c. Hub screen character preview — a small standalone Three.js scene
   rendered into the character card on the main hub, showing the same
   model the player will appear as to others. It stands still (a subtle
   idle sway, not a spinning turntable like the model's source page) —
   drag with the mouse/finger to look at it from other angles. Falls back
   to the ninja glyph until a real model exists/loads for the current
   gender.
--------------------------------------------------------------------- */
let hubPreview = null; // { scene, camera, renderer, rig, model, bones, animT, rafId, gender, yaw, dragging }

function initHubPreview() {
  if (hubPreview) return hubPreview;
  const canvas = $("hubCharCanvas");
  if (!canvas || typeof THREE === "undefined") return null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10);

  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(1.5, 2.5, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xec4899, 0.6);
  rim.position.set(-2, 1.5, -1.5);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0x9fb0c8, 0.55));

  // antialias off + capped pixel ratio: this canvas runs as a SECOND,
  // simultaneous WebGL context alongside the main game renderer. On a
  // weak/old phone GPU (low VRAM), keeping two live contexts running at
  // once — especially with a fairly large character texture set loaded
  // for both — can silently lose one of the contexts a few frames in.
  // That would look exactly like "plays for an instant, then freezes
  // completely" (whatever was drawn right before the context died just
  // stays on screen, since draw calls after a context loss silently do
  // nothing) — which matches what's actually being seen. Trimming this
  // context's own footprint (no MSAA, pixelRatio capped at 1 instead of
  // up to 2) gives it a much better chance of staying alive on hardware
  // like this. See the contextlost listener below for confirmation.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(1);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
  });

  const rig = new THREE.Group();
  scene.add(rig);

  hubPreview = {
    scene, camera, renderer, rig, model: null, anim: null, animT: 0,
    rafId: null, gender: null, templateRef: null, yaw: 0.35, dragging: false, lastX: 0,
  };

  // Drag-to-rotate — mouse and touch. The model itself never auto-spins;
  // only your own dragging turns it.
  const onDown = (x) => { hubPreview.dragging = true; hubPreview.lastX = x; };
  const onMove = (x) => {
    if (!hubPreview.dragging) return;
    hubPreview.yaw += (x - hubPreview.lastX) * 0.012;
    hubPreview.lastX = x;
  };
  const onUp = () => { hubPreview.dragging = false; };

  canvas.addEventListener("mousedown", (e) => onDown(e.clientX));
  window.addEventListener("mousemove", (e) => onMove(e.clientX));
  window.addEventListener("mouseup", onUp);
  canvas.addEventListener("touchstart", (e) => { if (e.touches[0]) onDown(e.touches[0].clientX); }, { passive: true });
  canvas.addEventListener("touchmove", (e) => { if (e.touches[0]) onMove(e.touches[0].clientX); }, { passive: true });
  canvas.addEventListener("touchend", onUp);

  return hubPreview;
}

function resizeHubPreview() {
  if (!hubPreview) return;
  const canvas = $("hubCharCanvas");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  hubPreview.renderer.setSize(w, h, false);
  hubPreview.camera.aspect = w / h;
  hubPreview.camera.updateProjectionMatrix();
  frameHubPreviewCamera();
}

/** Points the camera at the model using its own measured height (rather
 *  than an assumed constant), so it's framed fully in the card instead of
 *  being cropped/too tall regardless of exactly how the model scales. */
function frameHubPreviewCamera() {
  const hp = hubPreview;
  if (!hp || !hp.model) return;
  const box = new THREE.Box3().setFromObject(hp.model);
  const h = box.max.y - box.min.y || CHARACTER_TARGET_HEIGHT;
  const fovRad = THREE.MathUtils.degToRad(hp.camera.fov);
  const dist = (h / 2) / Math.tan(fovRad / 2) * 1.55; // headroom margin
  hp.camera.position.set(0, h * 0.52, dist);
  hp.camera.lookAt(0, h * 0.52, 0);
}

/** Rebuilds the previewed figure for whichever gender is currently
 *  selected, using the real model if it's loaded and the primitive
 *  fallback otherwise (with the ninja glyph shown instead until either
 *  one is ready to display). */
function refreshHubPreviewModel() {
  const hp = initHubPreview();
  const silhouette = $("hubSilhouette");
  const canvas = $("hubCharCanvas");
  if (!hp) { if (silhouette) silhouette.style.opacity = "1"; return; }

  const gender = normalizeGender(window.Multiplayer ? Multiplayer.getGender() : "boy");
  const template = characterTemplates[gender];

  // Keep the glyph up until we actually have something worth showing (the
  // real model), so the preview never flashes the placeholder capsule.
  if (!template) {
    loadCharacterModel(gender).then(() => {
      // Unconditional: whatever the preview was showing before (nothing,
      // or a stale template that has since been replaced — e.g. after
      // marketApplyEquip() deletes characterTemplates[gender] to force a
      // reload), re-run refresh now that a template exists again. Gating
      // this on hubPreview.gender being null (the old check) meant it
      // never fired once the preview had shown *any* model for this
      // gender before, since gender stays set from that point on.
      refreshHubPreviewModel();
    });
    if (silhouette) silhouette.style.opacity = "1";
    if (canvas) canvas.classList.remove("ready");
    return;
  }

  // Already showing this exact model — compare the underlying template
  // object, not just gender, so a market equip/unequip (which swaps in a
  // *different* template for the same gender) is correctly detected as a
  // change instead of being skipped as "already showing this".
  if (hp.gender === gender && hp.templateRef === template && hp.model) return;

  if (hp.model) hp.rig.remove(hp.model);
  const model = cloneCharacterModel(template);
  hp.rig.add(model);
  hp.model = model;
  hp.templateRef = template;
  // Preview runs its own rAF loop (tick(), below) rather than the main
  // gameLoop, so its animator is stepped there directly.
  hp.anim = attachCharacterAnimator(model, gender);
  hp.gender = gender;
  frameHubPreviewCamera();

  if (silhouette) silhouette.style.opacity = "0";
  if (canvas) canvas.classList.add("ready");
}

function startHubPreview() {
  const hp = initHubPreview();
  if (!hp) return;
  resizeHubPreview();
  refreshHubPreviewModel();
  if (hp.rafId) return; // loop already running
  const tick = () => {
    hp.rafId = requestAnimationFrame(tick);
    try {
      hp.rig.rotation.y = hp.yaw;
      hp.animT += 0.016;
      if (hp.anim) hp.anim.update(0.016, 0); // idle only — preview never "walks"
      hp.renderer.render(hp.scene, hp.camera);
    } catch (err) {
      if (!hp.loggedTickError) {
        hp.loggedTickError = true; // don't spam — this'd otherwise fire every frame
        console.error("[hub preview] tick() error (frozen from here on):", err);
      }
    }
  };
  tick();
}

function stopHubPreview() {
  if (!hubPreview || hubPreview.rafId === null) return;
  cancelAnimationFrame(hubPreview.rafId);
  hubPreview.rafId = null;
}

window.addEventListener("resize", () => { if (hubPreview && hubPreview.rafId) resizeHubPreview(); });

function makeNameSprite(text) {
  const cnv = document.createElement("canvas");
  cnv.width = 256; cnv.height = 64;
  const c = cnv.getContext("2d");
  c.font = "bold 34px sans-serif";
  c.textAlign = "center";
  c.fillStyle = "rgba(0,0,0,0.55)";
  c.fillRect(0, 10, 256, 44);
  c.fillStyle = "#f1e6df";
  c.fillText(text.slice(0, 14), 128, 42);
  const tex = new THREE.CanvasTexture(cnv);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.4, 0.35, 1);
  sprite.position.y = 1.95;
  return sprite;
}

/** Builds a simple, reasonably-proportioned low-poly human figure out of
 *  primitives (no external model needed) — distinct silhouette + colors
 *  for "boy" vs "girl" so friends are recognizable at a glance in the
 *  multiplayer room. Used as an instant placeholder while (or if) no real
 *  model is available. Returns a THREE.Group centered at the feet (y=0). */
function buildPrimitiveCharacterModel(gender) {
  const isGirl = gender === "girl";
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b394, roughness: 0.8 });
  const clothes = new THREE.MeshStandardMaterial({ color: isGirl ? 0xb43a6b : 0x2f5f9e, roughness: 0.75 });
  const bottoms = new THREE.MeshStandardMaterial({ color: isGirl ? 0x3a2540 : 0x24242c, roughness: 0.8 });
  const hairMat = new THREE.MeshStandardMaterial({ color: isGirl ? 0x2c1810 : 0x1a1310, roughness: 0.9 });

  const g = new THREE.Group();

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.085, 0.075, 0.82, 8);
  const legL = new THREE.Mesh(legGeo, bottoms); legL.position.set(-0.11, 0.41, 0);
  const legR = new THREE.Mesh(legGeo, bottoms); legR.position.set(0.11, 0.41, 0);
  g.add(legL, legR);

  // Torso (slightly tapered) — a dress silhouette (wider at hem) for girl, a
  // straight shirt for boy.
  const torsoGeo = isGirl
    ? new THREE.CylinderGeometry(0.24, 0.30, 0.62, 10)
    : new THREE.CylinderGeometry(0.23, 0.20, 0.58, 10);
  const torso = new THREE.Mesh(torsoGeo, clothes);
  torso.position.y = isGirl ? 1.13 : 1.11;
  g.add(torso);

  // Arms
  const armGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.56, 8);
  const armL = new THREE.Mesh(armGeo, skin); armL.position.set(-0.30, 1.14, 0); armL.rotation.z = 0.06;
  const armR = new THREE.Mesh(armGeo, skin); armR.position.set(0.30, 1.14, 0); armR.rotation.z = -0.06;
  g.add(armL, armR);

  // Neck + head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 8), skin);
  neck.position.y = 1.46;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 14, 12), skin);
  head.position.y = 1.60;
  g.add(neck, head);

  // Hair — short cap for boy, longer volume + ponytail for girl
  if (isGirl) {
    const hairTop = new THREE.Mesh(new THREE.SphereGeometry(0.165, 12, 10), hairMat);
    hairTop.position.set(0, 1.63, -0.01);
    hairTop.scale.set(1, 1.05, 1.05);
    const ponytail = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.42, 8), hairMat);
    ponytail.position.set(0, 1.42, -0.16);
    ponytail.rotation.x = 0.35;
    g.add(hairTop, ponytail);
  } else {
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    hairCap.position.y = 1.635;
    g.add(hairCap);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

function ensureMpAvatar(uid, name, gender) {
  if (mpAvatars[uid]) return mpAvatars[uid];
  const g = normalizeGender(gender);
  const group = new THREE.Group();
  const charModel = buildCharacterModel(g);
  group.add(charModel);
  group.add(makeNameSprite(name || "لاعب"));
  scene.add(group);
  const rec = {
    group, charModel, gender: g, usingRealModel: !!characterTemplates[g],
    anim: attachCharacterAnimator(charModel, g),
    animT: Math.random() * 10,
    x: 0, z: 0, yaw: 0, targetX: 0, targetZ: 0, targetYaw: 0,
  };
  mpAvatars[uid] = rec;
  loadCharacterModel(g).then(() => upgradeAvatarModels(g));
  return rec;
}

function updateMultiplayerAvatars(dt) {
  if (!state.mp.active || !window.Multiplayer) return;

  mpSyncAcc += dt;
  if (mpSyncAcc > 0.12) {
    mpSyncAcc = 0;
    Multiplayer.sendPosition(yawObject.position.x, yawObject.position.z, state.yaw);
    if (window.VoiceChat && VoiceChat.isActive()) {
      VoiceChat.syncPeers(Object.keys(Multiplayer.getPlayers()));
    }
  }

  const players = Multiplayer.getPlayers();
  const seen = new Set();
  for (const uid in players) {
    if (uid === Multiplayer.myId()) continue;
    seen.add(uid);
    const p = players[uid];
    const rec = ensureMpAvatar(uid, p.name, p.gender);
    rec.targetX = p.x || 0;
    rec.targetZ = p.z || 0;
    rec.targetYaw = p.yaw || 0;
    const prevX = rec.x, prevZ = rec.z;
    rec.x = lerp(rec.x, rec.targetX, 0.25);
    rec.z = lerp(rec.z, rec.targetZ, 0.25);
    rec.group.position.set(rec.x, floorY, rec.z);
    rec.group.rotation.y = rec.targetYaw;

    // Animate legs/arms from how fast this avatar is actually covering
    // ground (smoothed), so friends walk/run instead of gliding statically.
    const movedPerSec = dt > 0 ? Math.hypot(rec.x - prevX, rec.z - prevZ) / dt : 0;
    const targetSpeed = clamp(movedPerSec / SPRINT_SPEED, 0, 1);
    rec.animSpeed = lerp(rec.animSpeed || 0, targetSpeed, 0.2);
    rec.animT = (rec.animT || 0) + dt;
    if (rec.anim) rec.anim.update(dt, rec.animSpeed);
  }
  for (const uid in mpAvatars) {
    if (!seen.has(uid)) {
      scene.remove(mpAvatars[uid].group);
      delete mpAvatars[uid];
    }
  }
}

async function startGame() {
  showOverlay(null);
  $("loadingScreen").classList.remove("hidden");
  setLoadingProgressText("");

  try {
    resetState();
    clearScene();
    await buildScene();
  } catch (err) {
    console.error("Failed to load the map model:", err);
    $("loadingScreen").classList.add("hidden");
    $("hubScreen").classList.remove("hidden");
    startHubPreview();
    const msg = (err && err.message === "map-load-timeout")
      ? "استغرق تحميل الخريطة وقتًا طويلًا جدًا — تحقق من سرعة الاتصال وحاول مجددًا"
      : (err && err.message === "navgrid-timeout")
      ? "استغرق تجهيز الخريطة وقتًا طويلًا جدًا على هذا الجهاز — جرّب خريطة الممر بدل المستشفى"
      : "تعذر تحميل خريطة المنزل، تحقق من الاتصال وحاول مجددًا";
    showToast(msg);
    return;
  }
  $("loadingScreen").classList.add("hidden");

  Audio3D.init();
  Audio3D.setDanger(0);

  $("hud").classList.add("active");

  // Keys/exit toast removed for now along with the key/door/monster system —
  // add it back once your own version of that is wired in.

  state.running = true;
  state.startTime = performance.now();
  clock = new THREE.Clock();
  requestAnimationFrame(gameLoop);

  requestImmersiveMode();

  // Mic + chat bar now shows in every mode (solo, co-op multiplayer, and
  // Freddy) per your call — always start it.
  startInGameSocial();
}

function requestImmersiveMode() {
  // Best-effort: hide browser chrome and lock orientation so the game feels
  // like a native app rather than a web page. Silently ignored where unsupported.
  const root = document.documentElement;
  const goFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
  if (goFullscreen) {
    try {
      const p = goFullscreen.call(root);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }
  if (isCoarsePointer && screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("landscape").catch(() => {});
  }
  if (!isCoarsePointer) {
    const canvas = $("gameCanvas");
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  }
}

function triggerDeath() {
  if (state.gameOver || state.won) return;
  state.gameOver = true;
  state.running = false;
  Audio3D.jumpscare();
  Audio3D.stopAll();
  flashScreen();
  document.exitPointerLock && document.exitPointerLock();
  setTimeout(() => {
    $("hud").classList.remove("active");
    $("deathScreen").classList.remove("hidden");
  }, 500);
}

function triggerWin() {
  if (state.won || state.gameOver) return;
  state.won = true;
  state.running = false;
  state.finalTime = (performance.now() - state.startTime) / 1000;
  Audio3D.stopAll();
  document.exitPointerLock && document.exitPointerLock();
  const t = state.finalTime.toFixed(1);
  $("winStats").textContent = `جمعتَ ${state.keysCollected} من ${state.totalKeys} مفاتيح وخرجتَ حيًا خلال ${t} ثانية.`;
  if (window.Multiplayer && Multiplayer.addXp) Multiplayer.addXp(100 + state.keysCollected * 20);
  setTimeout(() => {
    $("hud").classList.remove("active");
    $("winScreen").classList.remove("hidden");
    if (Leaderboard.isReady()) {
      $("scoreSubmitBox").style.display = "block";
      $("submitScoreBtn").disabled = false;
      $("submitScoreBtn").textContent = "إرسال النتيجة للترتيب العالمي";
    }
  }, 400);
}

function flashScreen() {
  const el = $("staticFlash");
  el.style.transition = "none";
  el.style.opacity = "1";
  requestAnimationFrame(() => {
    el.style.transition = "opacity 0.6s ease";
    el.style.opacity = "0";
  });
}

/* ---------------------------------------------------------------------
   12d. Local player's own visible body — a rigged clone on a ground-level
   rig that follows the camera's x/z position and yaw (but not pitch, and
   not the head-bob), with its own head/neck bones scaled away so they
   don't clip into the first-person view. This is what lets you look down
   and actually see yourself, and gives the walk/run cycle above somewhere
   to play for the local player too.
--------------------------------------------------------------------- */
let localBody = null; // { group, model, anim, animT }

function setupLocalBody() {
  localBody = { group: new THREE.Group(), model: null, anim: null, animT: 0 };
  scene.add(localBody.group);
  attachLocalBodyModel();
}

function attachLocalBodyModel() {
  const gender = normalizeGender(window.Multiplayer ? Multiplayer.getGender() : "boy");
  loadCharacterModel(gender).then((template) => {
    // Scene may have been torn down (new game / left) by the time this
    // resolves, or this gender might not have a real model yet — bail.
    if (!template || !localBody) return;

    // SkeletonUtils gives this clone its own independent bones, so hiding
    // its head below doesn't affect the shared template other avatars use.
    const model = cloneCharacterModel(template);

    const { neck } = locateHeadBones(model);
    if (neck) neck.scale.setScalar(0.001); // collapses neck+head out of view (rigged models)

    // Belt-and-suspenders fix for the "seeing yourself from inside" bug:
    // scaling the neck bone only works if the rig actually has one (the
    // girl model has no skeleton at all, so `neck` is null above and the
    // whole head/torso stayed wrapped around the camera). Instead, put the
    // ENTIRE local-body mesh on a render layer that only the local camera
    // ignores. Other players still render it normally on their own
    // cameras (see updateRemoteAvatar / wherever remote clones are built —
    // they never touch this layer), so this can't affect what others see.
    model.traverse((o) => { if (o.isMesh) o.layers.set(LOCAL_BODY_LAYER); });

    if (localBody.model) localBody.group.remove(localBody.model);
    localBody.model = model;
    localBody.anim = attachCharacterAnimator(model, gender);
    localBody.group.add(model);

    // Plant the first-person camera at this exact model's measured eye
    // height instead of the old guessed constant, so what you see lines up
    // with where your visible body's own head actually is.
    if (template.userData.eyeHeight) {
      EYE_HEIGHT = clamp(template.userData.eyeHeight, 1.2, 2.1);
      if (yawObject) {
        yawObject.position.y = floorY + EYE_HEIGHT;
        state.restY = floorY + EYE_HEIGHT; // keep in sync — see updatePlayer's jump-offset fix
      }
    }
  });
}

function updateLocalBody(dt) {
  if (!localBody || !yawObject) return;
  localBody.group.position.set(yawObject.position.x, floorY, yawObject.position.z);
  localBody.group.rotation.y = state.yaw;

  const speed = !state.moving ? 0 : (state.sprinting ? 1 : 0.55);
  localBody.animT += dt;
  if (localBody.anim) localBody.anim.update(dt, speed);
}

/* ---------------------------------------------------------------------
   13. Main loop
--------------------------------------------------------------------- */
let _lastFrameAt = 0;
function gameLoop() {
  if (!state.running) return;

  // Optional FPS cap (0 = unlimited). Skip the frame's work entirely when
  // we're ahead of schedule instead of just throttling the render, so
  // capped frame rates also translate into real battery/CPU savings.
  const cap = Settings.get("fpsCap") || 0;
  if (cap > 0) {
    const minDelta = 1000 / cap;
    const now = performance.now();
    if (now - _lastFrameAt < minDelta) {
      requestAnimationFrame(gameLoop);
      return;
    }
    _lastFrameAt = now;
  }

  const dt = Math.min(clock.getDelta(), 0.05);

  updatePlayer(dt);
  updateMonster(dt);
  updateMultiplayerAvatars(dt);
  updateLocalBody(dt);
  updateHouseLighting(dt);
  for (const key of keyMeshes) {
    key.rotation.y += dt * 1.2;
    key.position.y = floorY + 1.1 + Math.sin(performance.now() * 0.002 + key.position.x) * 0.08;
  }
  updateHud();

  // Each character instance (remote avatars, local body, hub preview) now
  // advances its own AnimationMixer via anim.update(dt, speed) at its own
  // call site — see attachCharacterAnimator — instead of a shared list.

  renderer.render(scene, camera);
  requestAnimationFrame(gameLoop);
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* ---------------------------------------------------------------------
   14. Leaderboard UI
--------------------------------------------------------------------- */
function renderLeaderboard(list) {
  const ol = $("leaderboardList");
  ol.innerHTML = "";
  if (!list.length) {
    $("leaderboardPanel").style.display = "none";
    return;
  }
  $("leaderboardPanel").style.display = "block";
  list.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.name} — ${entry.timeSeconds.toFixed(1)} ث (${entry.keysCollected}/3 مفاتيح)`;
    ol.appendChild(li);
  });
}

async function refreshLeaderboard() {
  if (!Leaderboard.isReady()) return;
  const list = await Leaderboard.topScores(10);
  renderLeaderboard(list);
}

/* ---------------------------------------------------------------------
   15. Boot
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   14. Menu, settings & multiplayer lobby wiring
--------------------------------------------------------------------- */
const OVERLAY_IDS = ["menuScreen", "hubScreen", "charLobbyScreen", "deathScreen", "winScreen",
  "settingsScreen", "freddySettingsScreen", "friendsScreen", "marketScreen",
  "mpChoiceScreen", "mpCreateScreen", "mpJoinScreen", "mpLobbyScreen",
  "mpLocalHostScreen", "mpLocalJoinScreen"];

const DIFFICULTY_LABELS = { none: "بدون وحش", easy: "سهل", normal: "عادي", hard: "صعب" };

/* ---------------------------------------------------------------------
   Public room browser — lists open rooms (name/map, mode, players) so
   the person can pick one instead of being auto-joined to a random room.
--------------------------------------------------------------------- */
let mpBrowseTab = "online";
let mpBrowseRooms = [];
// Tracks a room the player is still connected to after leaving the lobby
// screen to browse the hub/shop (see mpLobbyBrowseBtn) — lets the floating
// "back to my room" button reopen it and show a live player count.
let mpBgLobby = null;

function updateMpReturnBtn() {
  const btn = $("mpReturnToRoomBtn");
  if (!btn) return;
  const onLobbyScreen = !$("mpLobbyScreen").classList.contains("hidden");
  if (mpBgLobby && !state.running && !onLobbyScreen) {
    btn.classList.remove("hidden");
    $("mpReturnToRoomCount").textContent = mpBgLobby.playerCount || 1;
  } else {
    btn.classList.add("hidden");
  }
}

function mpRoomRowHtml(room) {
  const mapName = (MAPS[room.mapId] || MAPS[DEFAULT_MAP_ID]).name;
  const modeLabel = DIFFICULTY_LABELS[room.difficulty] || "عادي";
  return `
    <div class="mp-room-row" data-code="${room.code}">
      <div class="mp-col-star"><i class="fa-regular fa-star"></i></div>
      <div class="mp-col-name">
        <div class="mp-room-code">#${room.code}</div>
        <div class="mp-room-host">${room.hostName}</div>
        <div class="mp-room-map">${mapName}</div>
      </div>
      <div class="mp-col-mode">${modeLabel}</div>
      <div class="mp-col-settings">-</div>
      <div class="mp-col-players">${room.playerCount}/${room.maxPlayers}</div>
    </div>`;
}

async function renderMpBrowseList() {
  const list = $("mpBrowseList");
  const refreshBtn = $("mpBrowseRefreshBtn");
  refreshBtn.classList.add("spinning");

  // "محلي" (LAN) — no automatic device discovery is possible from a web
  // page, so instead of a room list this tab is two buttons: start hosting
  // (generates a code to send the other player) or join with a host's code.
  if (mpBrowseTab === "local") {
    list.innerHTML = `
      <div class="mp-browse-empty" style="display:flex; flex-direction:column; gap:12px; align-items:center;">
        <div>لعب مباشر بين جهازين على نفس الشبكة — بدون إنترنت، بدون حساب.</div>
        <button class="btn" id="mpLocalHostBtn" style="max-width:260px;">استضافة (إنشاء كود)</button>
        <button class="btn secondary" id="mpLocalJoinBtn" style="max-width:260px;">الانضمام بكود مضيف</button>
      </div>`;
    refreshBtn.classList.remove("spinning");
    $("mpLocalHostBtn").addEventListener("click", () => showOverlay("mpLocalHostScreen"));
    $("mpLocalJoinBtn").addEventListener("click", () => showOverlay("mpLocalJoinScreen"));
    return;
  }

  try {
    mpBrowseRooms = await Multiplayer.listPublicRooms();
  } catch (e) {
    list.innerHTML = `<div class="mp-browse-empty">تعذّر تحميل الغرف، تحقق من الاتصال.</div>`;
    refreshBtn.classList.remove("spinning");
    return;
  }

  const query = ($("mpBrowseSearchInput").value || "").trim().toUpperCase();
  const rooms = query ? mpBrowseRooms.filter((r) => r.code.includes(query)) : mpBrowseRooms;

  list.innerHTML = rooms.length
    ? rooms.map(mpRoomRowHtml).join("")
    : `<div class="mp-browse-empty">ما في غرف عامة مفتوحة الحين — اضغط "إنشاء غرفة" وابدأ وحدة جديدة.</div>`;

  list.querySelectorAll(".mp-room-row").forEach((row) => {
    row.addEventListener("click", async () => {
      const code = row.dataset.code;
      row.style.opacity = "0.5";
      try {
        await Multiplayer.joinRoom(code);
        enterLobby(code, false);
      } catch (e) {
        showToast("تعذّر الانضمام — الغرفة ممتلئة أو أُغلقت.");
        renderMpBrowseList();
      }
    });
  });

  refreshBtn.classList.remove("spinning");
}

function showOverlay(id) {
  OVERLAY_IDS.forEach((o) => $(o).classList.add("hidden"));
  if (id) $(id).classList.remove("hidden");
  // hubScreen has its own gear icon + version tag baked into the layout,
  // so the old floating ones only show for the other screens.
  $("settingsGearBtn").style.display = (id === "menuScreen") ? "flex" : "none";
  $("versionTag").style.display = (id === "menuScreen") ? "block" : "none";
  // The character preview only needs to render while the hub is actually
  // visible — stop the loop the moment we navigate away from it.
  if (id === "hubScreen") startHubPreview(); else stopHubPreview();
  updateMpReturnBtn();
}

async function leaveMultiplayerIfActive() {
  if (state.mp.active) {
    state.mp = { active: false, roomCode: null, difficulty: "normal", isHost: false };
  }
  mpBgLobby = null;
  updateMpReturnBtn();
  stopInGameSocial();
  if (window.Multiplayer) {
    try { await Multiplayer.leaveRoom(); } catch (e) { /* ignore */ }
  }
}

/* ---------------------------------------------------------------------
   In-game mic + text chat — only relevant while state.mp.active.
--------------------------------------------------------------------- */
let chatHasUnread = false;

function appendChatMessage(msg) {
  const box = $("chatMessages");
  const line = document.createElement("div");
  line.className = "msg";
  const nameEl = document.createElement("b");
  nameEl.textContent = (msg.name || "لاعب") + ": ";
  const textEl = document.createElement("span");
  textEl.textContent = msg.text || "";
  line.appendChild(nameEl);
  line.appendChild(textEl);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 60) box.removeChild(box.firstChild);

  if ($("chatPanel").classList.contains("hidden")) {
    chatHasUnread = true;
    $("chatToggleBtn").classList.add("has-unread");
  }
}

async function startInGameSocial() {
  $("mpSocialBar").classList.remove("hidden");
  $("chatMessages").innerHTML = "";
  chatHasUnread = false;
  $("chatToggleBtn").classList.remove("has-unread");

  // The mic button always shows (so it's never "missing") — clicking it
  // both starts voice chat on first use and mutes/unmutes afterward.
  $("voiceMicBtn").style.display = "flex";
  $("voiceMicBtn").classList.remove("muted");
  $("voiceMicBtn").innerHTML = '<i class="fa-solid fa-microphone"></i>';

  // Chat history / voice peers only make sense with an actual multiplayer
  // room behind them — solo play shows the same bar (no one to talk to
  // yet, but the buttons are there), without touching Firebase/WebRTC.
  if (!window.Multiplayer || !state.mp.roomCode) return;
  Multiplayer.listenChat(appendChatMessage);
  await tryStartVoiceChat();
}

async function tryStartVoiceChat() {
  if (!state.mp.roomCode) {
    showToast("المايك يشتغل بس لما تكون بغرفة ملتيبلاير");
    return false;
  }
  if (!window.VoiceChat || !VoiceChat.available()) {
    $("voiceMicBtn").style.display = "none";
    return false;
  }
  if (VoiceChat.isActive()) return true;
  const peerIds = Object.keys(Multiplayer.getPlayers() || {}).filter((u) => u !== Multiplayer.myId());
  const ok = await VoiceChat.start(state.mp.roomCode, Multiplayer.myId(), peerIds);
  if (ok) {
    VoiceChat.setMuted(false);
  } else {
    showToast("تعذّر تشغيل المايك — تأكد إنك وافقت على صلاحية المايك بالمتصفح");
  }
  return ok;
}

function stopInGameSocial() {
  $("mpSocialBar").classList.add("hidden");
  $("chatPanel").classList.add("hidden");
  if (window.Multiplayer) Multiplayer.stopChatListener();
  if (window.VoiceChat) VoiceChat.stop();
}

function renderLobbyPlayers(players, hostId) {
  const list = $("mpLobbyPlayers");
  list.innerHTML = "";
  Object.entries(players || {}).forEach(([uid, p]) => {
    const li = document.createElement("li");
    const isHostPlayer = uid === hostId;
    li.innerHTML = `<span><i class="fa-solid ${p.gender === "girl" ? "fa-venus" : "fa-mars"}"></i> ${p.name || "لاعب"}</span>` +
      (isHostPlayer ? `<span class="host-tag"><i class="fa-solid fa-star"></i> مضيف</span>` : "");
    list.appendChild(li);
  });
}

function setupMenuAndMultiplayer() {
  let mpAvailable = window.Multiplayer && Multiplayer.init();
  // Firebase can fail to be ready at the exact instant the page loads
  // (slow network, first paint before the SDK finishes initializing).
  // Re-check right before anything that actually needs it instead of
  // trusting a single check done once at startup — otherwise a single
  // bad moment on page load permanently disables multiplayer AND silently
  // breaks saving your name (see settingsBackBtn below), even once the
  // connection is fine again.
  function recheckMultiplayer() {
    if (!mpAvailable && window.Multiplayer) mpAvailable = Multiplayer.init();
    return mpAvailable;
  }

  setupFriendsAndSocial();

  /* ----- Hub screen wiring ----- */
  $("hubSettingsBtn").addEventListener("click", () => $("settingsGearBtn").click());
  // "الغرف" = search a public room to play with strangers, or create/join
  // a private one by code with friends — all live inside mpChoiceScreen.
  $("hubRoomsBtn").addEventListener("click", () => $("playWithFriendsBtn").click());
  $("hubPlayWithFriendsBtn2").addEventListener("click", () => $("playWithFriendsBtn").click());
  // "أصدقاء" opens the friends panel — request/accept + room invites.
  $("hubFriendsBtn").addEventListener("click", () => showOverlay("friendsScreen"));
  $("friendsBackBtn").addEventListener("click", () => showOverlay("hubScreen"));
  // PLAY never starts the game directly from the hub — it opens the
  // character + map lobby screen first.
  $("hubPlayNavBtn").addEventListener("click", () => openCharLobby());
  $("startBtn").addEventListener("click", () => openCharLobby());
  $("hubInventoryBtn").addEventListener("click", () => showToast("قريبًا"));
  $("hubMarketBtn").addEventListener("click", () => { renderMarketScreen(); showOverlay("marketScreen"); });
  $("marketBackBtn").addEventListener("click", () => showOverlay("hubScreen"));
  // Tabs actually filter the grid now (see renderMarketScreen): market =
  // everything, requests = items you own, shop = items you don't own yet.
  ["marketTabMarket", "marketTabRequests", "marketTabShop"].forEach((id, idx) => {
    const tabKey = ["market", "requests", "shop"][idx];
    $(id).addEventListener("click", () => {
      document.querySelectorAll(".market-tab").forEach((t) => t.classList.remove("active"));
      $(id).classList.add("active");
      marketViewState.tab = tabKey;
      renderMarketScreen();
    });
  });
  // Filter — cycles through the item categories found in MARKET_ITEMS
  // (الكل → طقم → سروال → الكل ...) and re-renders filtered.
  $("marketFilterBtn").addEventListener("click", () => {
    const cats = ["all", ...new Set(MARKET_ITEMS.map((i) => i.category || "عنصر"))];
    const curIdx = cats.indexOf(marketViewState.category);
    marketViewState.category = cats[(curIdx + 1) % cats.length];
    const label = marketViewState.category === "all" ? "فلترة" : marketViewState.category;
    $("marketFilterBtn").innerHTML = `<i class="fa-solid fa-sliders"></i> ${label}`;
    renderMarketScreen();
  });
  // Sort — toggles A→Z / Z→A by item name and flips the icon direction.
  $("marketSortBtn").addEventListener("click", () => {
    marketViewState.sortDir = marketViewState.sortDir === "asc" ? "desc" : "asc";
    $("marketSortBtn").innerHTML = marketViewState.sortDir === "asc"
      ? `<i class="fa-solid fa-arrow-down-short-wide"></i>`
      : `<i class="fa-solid fa-arrow-up-wide-short"></i>`;
    renderMarketScreen();
  });
  // Tab pills — only "السوق" has real content right now (the MARKET_ITEMS
  // grid); "الطلبات" / "المتجر" are visual placeholders for now, matching
  // the reference design's tab bar. Wire real screens to them later.
  ["marketTabMarket", "marketTabRequests", "marketTabShop"].forEach((id) => {
    $(id).addEventListener("click", () => {
      document.querySelectorAll(".market-tab").forEach((t) => t.classList.remove("active"));
      $(id).classList.add("active");
      if (id !== "marketTabMarket") showToast("قريبًا");
    });
  });
  // Filter/sort — cosmetic for now (no filter/sort logic wired up yet).
  $("marketFilterBtn").addEventListener("click", () => showToast("قريبًا"));
  $("marketSortBtn").addEventListener("click", () => showToast("قريبًا"));

  /* ----- Character + map lobby screen ----- */
  function updateXpDisplay() {
    const xp = (window.Multiplayer && Multiplayer.getXp) ? Multiplayer.getXp() : 0;
    const cap = 1200;
    const pct = Math.min(100, Math.round((xp / cap) * 100));
    $("hubXpVal").textContent = `${xp}/${cap}`;
    $("hubXpBar").style.width = pct + "%";
    $("clXpVal").textContent = `${xp}/${cap}`;
    $("clXpBar").style.width = pct + "%";
  }
  function openCharLobby() {
    updateXpDisplay();
    document.querySelectorAll(".map-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.map === currentMapId());
    });
    showOverlay("charLobbyScreen");
  }
  $("clBackBtn").addEventListener("click", () => showOverlay("hubScreen"));
  document.querySelectorAll(".map-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.classList.contains("soon")) { showToast("هاي الخريطة قريبًا"); return; }
      document.querySelectorAll(".map-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      Settings.set("mapId", card.dataset.map);
    });
  });
  $("clPlayBtn").addEventListener("click", () => { leaveMultiplayerIfActive(); startGame(); });

  /* ----- Freddy-specific settings (monster difficulty, name & look) ----- */
  $("clFreddyBtn").addEventListener("click", () => {
    $("freddyDifficultySelect").value = Settings.get("difficulty");
    if (window.Multiplayer) {
      $("freddyPlayerNameField").value = Multiplayer.getName();
      const g = Multiplayer.getGender();
      document.querySelector(`input[name="freddyGenderPick"][value="${g}"]`).checked = true;
    }
    showOverlay("freddySettingsScreen");
  });
  $("freddySettingsBackBtn").addEventListener("click", () => {
    Settings.set("difficulty", $("freddyDifficultySelect").value);
    if (window.Multiplayer) {
      const genderInput = document.querySelector('input[name="freddyGenderPick"]:checked');
      const name = Multiplayer.setName($("freddyPlayerNameField").value);
      const gender = Multiplayer.setGender(genderInput ? genderInput.value : "boy");
      if (recheckMultiplayer()) Multiplayer.updateSelf({ name, gender });
    }
    showOverlay("charLobbyScreen");
  });

  function refreshHubAccountUI(user) {
    const label = $("hubAccountLabel");
    const btnLabel = $("hubGoogleBtnLabel");
    const img = $("hubAvatarImg");
    const nameTag = $("hubNameTag");
    // Guests now also get a real Firebase session (signInGuestPersistent),
    // so `user` alone no longer means "signed in with Google" — an
    // anonymous user object has no displayName/photoURL and isAnonymous
    // is true. This section is specifically about Google account status,
    // so anonymous sessions should still show the "sign in with Google"
    // prompt, not a false "signed in" state.
    if (user && !user.isAnonymous) {
      label.textContent = user.displayName || "لاعب";
      btnLabel.textContent = "تسجيل خروج";
      if (user.photoURL) { img.src = user.photoURL; img.classList.remove("hidden"); }
    } else {
      label.textContent = "ما سجّلت دخول بعد";
      btnLabel.textContent = "دخول بحساب Google";
      img.classList.add("hidden");
    }
    if (window.Multiplayer) nameTag.textContent = Multiplayer.getName();
  }
  $("hubGoogleBtn").addEventListener("click", async () => {
    if (!window.Multiplayer || !Multiplayer.authAvailable()) {
      showToast("تسجيل الدخول غير مفعّل بعد على هذا المشروع");
      return;
    }
    try {
      if (Multiplayer.currentGoogleUser()) {
        await Multiplayer.signOutGoogle();
      } else {
        await Multiplayer.signInWithGoogle();
      }
    } catch (e) {
      console.error("Google sign-in failed:", e);
      showToast("تعذّر: " + (e.code || e.message || "unknown"));
    }
  });
  if (window.Multiplayer && Multiplayer.authAvailable()) {
    Multiplayer.watchAuth(refreshHubAccountUI);
  } else {
    refreshHubAccountUI(null);
  }

  /* ----- Settings screen (تبويبات: جرافيك / أصوات / عامة) ----- */
  document.querySelectorAll(".settings-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
      tabBtn.classList.add("active");
      $("tab" + tabBtn.dataset.tab.charAt(0).toUpperCase() + tabBtn.dataset.tab.slice(1)).classList.add("active");
    });
  });
  $("settingsGearBtn").addEventListener("click", () => {
    $("graphicsQualitySelect").value = Settings.get("graphicsQuality");
    $("fpsCapSelect").value = String(Settings.get("fpsCap"));
    $("monsterVolRange").value = Settings.get("monsterVolume");
    $("monsterVolVal").textContent = Settings.get("monsterVolume") + "%";
    $("gameVolRange").value = Settings.get("gameVolume");
    $("gameVolVal").textContent = Settings.get("gameVolume") + "%";
    $("sensRange").value = Settings.get("sensitivity");
    $("sensVal").textContent = Settings.get("sensitivity").toFixed(1);
    $("fovRange").value = Settings.get("fov");
    $("fovVal").textContent = Settings.get("fov");
    $("povRange").value = Settings.get("pov");
    $("povVal").textContent = Settings.get("pov") === 1 ? "من الخلف (قريبًا)" : "منظور اللاعب";
    if (window.Multiplayer) {
      $("accountIdVal").textContent = Multiplayer.myId();
      $("accountNameVal").textContent = Multiplayer.getName();
    }
    $("accountError").textContent = "";
    showOverlay("settingsScreen");
  });
  $("copyAccountIdBtn").addEventListener("click", () => {
    const id = $("accountIdVal").textContent;
    navigator.clipboard.writeText(id).then(() => showToast("تم نسخ المعرّف")).catch(() => {});
  });
  $("accountLogoutBtn").addEventListener("click", async () => {
    if (window.Multiplayer) await Multiplayer.logout();
    location.reload();
  });
  $("accountDeleteBtn").addEventListener("click", async () => {
    if (!confirm("متأكد إنك تبي تحذف حسابك؟ هذا الإجراء ما ينرجع.")) return;
    const btn = $("accountDeleteBtn");
    btn.disabled = true;
    try {
      if (window.Multiplayer) await Multiplayer.deleteAccount();
      location.reload();
    } catch (e) {
      $("accountError").textContent = "تعذّر حذف الحساب — حاول مرة ثانية.";
      btn.disabled = false;
    }
  });
  $("sensRange").addEventListener("input", (e) => {
    $("sensVal").textContent = parseFloat(e.target.value).toFixed(1);
  });
  $("fovRange").addEventListener("input", (e) => {
    $("fovVal").textContent = e.target.value;
  });
  $("povRange").addEventListener("input", (e) => {
    $("povVal").textContent = e.target.value === "1" ? "من الخلف (قريبًا)" : "منظور اللاعب";
  });
  $("monsterVolRange").addEventListener("input", (e) => {
    $("monsterVolVal").textContent = e.target.value + "%";
  });
  $("gameVolRange").addEventListener("input", (e) => {
    $("gameVolVal").textContent = e.target.value + "%";
  });
  $("settingsBackBtn").addEventListener("click", () => {
    Settings.set("graphicsQuality", $("graphicsQualitySelect").value);
    Settings.set("fpsCap", parseInt($("fpsCapSelect").value, 10));
    Settings.set("monsterVolume", parseInt($("monsterVolRange").value, 10));
    Settings.set("gameVolume", parseInt($("gameVolRange").value, 10));
    Audio3D.setMonsterVolume(Settings.get("monsterVolume"));
    Audio3D.setGameVolume(Settings.get("gameVolume"));
    Settings.set("sensitivity", parseFloat($("sensRange").value));
    Settings.set("fov", parseInt($("fovRange").value, 10));
    Settings.set("pov", parseInt($("povRange").value, 10));
    applyGraphicsQuality();
    if (camera) camera.fov = Settings.get("fov"), camera.updateProjectionMatrix();
    showOverlay("hubScreen");
  });
  $("exitGameBtn").addEventListener("click", async () => {
    // Wait for the room-cleanup network request to finish before the tab
    // closes — otherwise the delete can be aborted mid-flight and the
    // room is left behind in the database (shows up as a duplicate next
    // time this player hosts).
    await leaveMultiplayerIfActive();
    window.close();
    setTimeout(() => showToast("أغلق تبويب المتصفح يدويًا للخروج"), 300);
  });

  /* ----- Play with friends: the room list is the screen itself now, so
     open straight into it and load the rooms immediately instead of
     waiting for a "search" button click. ----- */
  $("playWithFriendsBtn").addEventListener("click", () => {
    if (!recheckMultiplayer()) {
      showToast("ميزة اللعب الجماعي غير متاحة حاليًا (تحقق من الاتصال)");
      return;
    }
    showOverlay("mpChoiceScreen");
    renderMpBrowseList();
  });
  $("mpChoiceBackBtn").addEventListener("click", () => showOverlay("hubScreen"));

  $("mpBrowseRefreshBtn").addEventListener("click", () => renderMpBrowseList());
  $("mpBrowseSearchInput").addEventListener("input", () => renderMpBrowseList());
  // No filter options yet (only one game mode axis — difficulty — exists
  // today) — toast instead of a dead button that looks broken like the
  // market buy button did.
  $("mpFilterBtn").addEventListener("click", () => showToast("خيارات التصفية قريبًا"));
  $("mpTabOnline").addEventListener("click", () => {
    mpBrowseTab = "online";
    $("mpTabOnline").classList.add("active");
    $("mpTabLocal").classList.remove("active");
    renderMpBrowseList();
  });
  $("mpTabLocal").addEventListener("click", () => {
    mpBrowseTab = "local";
    $("mpTabLocal").classList.add("active");
    $("mpTabOnline").classList.remove("active");
    renderMpBrowseList();
  });
  /* ----- Create room ----- */
  $("mpCreateEnterBtn").addEventListener("click", () => {
    $("mpCreateError").textContent = "";
    showOverlay("mpCreateScreen");
  });
  $("mpCreateBackBtn").addEventListener("click", () => showOverlay("mpChoiceScreen"));
  $("mpCreateSubmitBtn").addEventListener("click", async () => {
    const btn = $("mpCreateSubmitBtn");
    btn.disabled = true;
    $("mpCreateError").textContent = "";
    try {
      const code = await Multiplayer.createRoom({
        difficulty: $("mpDifficultySelect").value,
        maxPlayers: clamp(parseInt($("mpMaxPlayers").value, 10) || 4, 2, 8),
        isPrivate: $("mpPrivateToggle").checked,
        mapId: $("mpMapSelect").value,
      });
      enterLobby(code, true);
    } catch (e) {
      // Surface the real Firebase error code (e.g. PERMISSION_DENIED means
      // the Realtime Database rules were never published, not a network
      // problem) so it's actually diagnosable instead of always blaming
      // "check your connection".
      console.error("createRoom failed:", e);
      const reason = (e && (e.code || e.message)) || "";
      $("mpCreateError").textContent = reason.includes("PERMISSION_DENIED")
        ? "الخادم رفض الإنشاء (قواعد Realtime Database غير منشورة في Firebase)."
        : "تعذّر إنشاء الخادم، تحقق من الاتصال. (" + reason + ")";
    }
    btn.disabled = false;
  });

  /* ----- Join room ----- */
  $("mpJoinEnterBtn").addEventListener("click", () => {
    $("mpJoinError").textContent = "";
    $("mpJoinCodeInput").value = "";
    showOverlay("mpJoinScreen");
  });
  $("mpJoinBackBtn").addEventListener("click", () => showOverlay("mpChoiceScreen"));
  $("mpJoinSubmitBtn").addEventListener("click", async () => {
    const btn = $("mpJoinSubmitBtn");
    const code = $("mpJoinCodeInput").value.trim().toUpperCase();
    if (code.length !== 5) { $("mpJoinError").textContent = "الكود مكوّن من 5 رموز."; return; }
    btn.disabled = true;
    $("mpJoinError").textContent = "";
    try {
      await Multiplayer.joinRoom(code);
      enterLobby(code, false);
    } catch (e) {
      const msg = {
        "room-not-found": "لا يوجد خادم بهذا الكود.",
        "room-full": "الغرفة ممتلئة.",
        "room-already-started": "اللعبة بدأت بالفعل في هذه الغرفة.",
      }[e.message] || "تعذّر الانضمام، تحقق من الاتصال.";
      $("mpJoinError").textContent = msg;
    }
    btn.disabled = false;
  });

  /* ----- Local (LAN) play — direct WebRTC, manual code exchange ----- */
  function copyCodeFromField(fieldId, toastMsg) {
    const field = $(fieldId);
    field.select();
    field.setSelectionRange(0, 99999);
    (navigator.clipboard ? navigator.clipboard.writeText(field.value) : Promise.reject())
      .then(() => showToast(toastMsg))
      .catch(() => document.execCommand("copy"));
  }

  $("mpLocalHostBackBtn").addEventListener("click", async () => { await Multiplayer.leaveRoom(); showOverlay("mpChoiceScreen"); });
  $("mpLocalHostGenBtn").addEventListener("click", async () => {
    const btn = $("mpLocalHostGenBtn");
    btn.disabled = true;
    $("mpLocalHostError").textContent = "";
    try {
      const code = await Multiplayer.createLocalRoom({
        difficulty: $("mpLocalDifficultySelect").value,
        mapId: $("mpLocalMapSelect").value,
      });
      $("mpLocalHostOfferField").value = code;
      $("mpLocalHostStep2").style.display = "block";
    } catch (e) {
      $("mpLocalHostError").textContent = "تعذّر إنشاء الاتصال — متصفحك قد لا يدعم WebRTC.";
    }
    btn.disabled = false;
  });
  $("mpLocalHostCopyBtn").addEventListener("click", () => copyCodeFromField("mpLocalHostOfferField", "تم نسخ الكود — أرسله للاعب الثاني"));
  $("mpLocalHostConnectBtn").addEventListener("click", async () => {
    const btn = $("mpLocalHostConnectBtn");
    const answer = $("mpLocalHostAnswerField").value.trim();
    if (!answer) { $("mpLocalHostError").textContent = "الصق كود الرد أولاً."; return; }
    btn.disabled = true;
    $("mpLocalHostError").textContent = "";
    try {
      await Multiplayer.completeLocalRoom(answer);
      enterLobby(Multiplayer.currentRoomCode(), true);
    } catch (e) {
      $("mpLocalHostError").textContent = "كود الرد غير صالح.";
    }
    btn.disabled = false;
  });

  $("mpLocalJoinBackBtn").addEventListener("click", async () => { await Multiplayer.leaveRoom(); showOverlay("mpChoiceScreen"); });
  $("mpLocalJoinGenBtn").addEventListener("click", async () => {
    const btn = $("mpLocalJoinGenBtn");
    const offer = $("mpLocalJoinOfferField").value.trim();
    if (!offer) { $("mpLocalJoinError").textContent = "الصق كود المضيف أولاً."; return; }
    btn.disabled = true;
    $("mpLocalJoinError").textContent = "";
    try {
      const answer = await Multiplayer.joinLocalRoom(offer);
      $("mpLocalJoinAnswerField").value = answer;
      $("mpLocalJoinStep2").style.display = "block";
    } catch (e) {
      $("mpLocalJoinError").textContent = "كود المضيف غير صالح.";
    }
    btn.disabled = false;
  });
  $("mpLocalJoinCopyBtn").addEventListener("click", () => copyCodeFromField("mpLocalJoinAnswerField", "تم نسخ الرد — أرسله للمضيف"));
  $("mpLocalJoinEnterLobbyBtn").addEventListener("click", () => {
    enterLobby(Multiplayer.currentRoomCode(), false);
  });

  /* ----- Lobby ----- */
  function enterLobby(code, isHost) {
    $("mpLobbyCode").textContent = code;
    $("mpStartGameBtn").style.display = isHost ? "inline-block" : "none";
    $("mpWaitingNote").style.display = isHost ? "none" : "block";
    showOverlay("mpLobbyScreen");
    mpBgLobby = { code, isHost, playerCount: mpBgLobby ? mpBgLobby.playerCount : 1 };

    Multiplayer.onPlayers((players) => {
      const room = { hostId: null };
      renderLobbyPlayers(players, Multiplayer.amHost() ? Multiplayer.myId() : Object.keys(players).find((u) => players[u].isHost));
      if (mpBgLobby) mpBgLobby.playerCount = Object.keys(players).length;
      updateMpReturnBtn();
    });

    Multiplayer.onRoomStatus((val) => {
      if (!val) {
        // Room was closed (host left), whether we were looking at the
        // lobby screen or had stepped out to browse the hub/shop.
        const wasWatching = !$("mpLobbyScreen").classList.contains("hidden") || !!mpBgLobby;
        mpBgLobby = null;
        updateMpReturnBtn();
        if (wasWatching) {
          showToast("أغلق المضيف الغرفة.");
          showOverlay("hubScreen");
        }
        return;
      }
      if (val.status === "playing" && !state.running) {
        state.mp = { active: true, roomCode: code, difficulty: val.difficulty || "normal", mapId: MAPS[val.mapId] ? val.mapId : DEFAULT_MAP_ID, isHost: Multiplayer.amHost() };
        mpBgLobby = null;
        showOverlay(null);
        startGame();
      }
    });
  }

  $("mpStartGameBtn").addEventListener("click", () => {
    Multiplayer.startRoomGame();
  });

  // Leave the lobby screen without leaving the room itself — you can shop,
  // change your model, or check the room list, and the floating button
  // (bottom-right) lets you jump straight back in.
  $("mpLobbyBrowseBtn").addEventListener("click", () => {
    showOverlay("hubScreen");
    showToast("لسا متصل بالغرفة — اضغط الزر العائم للرجوع لها.");
  });
  $("mpReturnToRoomBtn").addEventListener("click", () => {
    if (!mpBgLobby) return;
    enterLobby(mpBgLobby.code, mpBgLobby.isHost);
  });

  /* ----- Friends: requests, list, invite-straight-into-my-room ----- */
  function setupFriendsAndSocial() {
    if (!window.Multiplayer) return;

    $("myFriendCodeVal").textContent = Multiplayer.myId();
    $("copyFriendCodeBtn").addEventListener("click", () => {
      const code = $("myFriendCodeVal").textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => showToast("انسخ الكود!")).catch(() => {});
      }
    });

    $("friendAddBtn").addEventListener("click", async () => {
      $("friendAddError").textContent = "";
      if (!recheckMultiplayer()) { $("friendAddError").textContent = "الاتصال بالسيرفر غير متاح حاليًا."; return; }
      const code = $("friendAddInput").value.trim();
      if (!code) return;
      try {
        await Multiplayer.sendFriendRequest(code);
        $("friendAddInput").value = "";
        showToast("تم إرسال طلب الصداقة");
      } catch (e) {
        const map = {
          "user-not-found": "ما لقينا لاعب بهذا الكود.",
          "self-add": "هاد كودك انت",
          "empty-code": "اكتب كود صحيح."
        };
        $("friendAddError").textContent = map[e.message] || "تعذّر إرسال الطلب — تحقق من الاتصال.";
      }
    });

    if (!recheckMultiplayer()) return; // everything below needs a live connection

    Multiplayer.listenFriendRequests((requests) => {
      const ids = Object.keys(requests || {});
      $("friendsBadge").textContent = ids.length;
      $("friendsBadge").classList.toggle("hidden", ids.length === 0);
      $("friendRequestsBox").style.display = ids.length ? "block" : "none";
      const list = $("friendRequestsList");
      list.innerHTML = "";
      ids.forEach((fromUid) => {
        const req = requests[fromUid];
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = req.name || "لاعب";
        const actions = document.createElement("div");
        actions.className = "friend-row-actions";
        const acceptBtn = document.createElement("button");
        acceptBtn.className = "fr-accept";
        acceptBtn.textContent = "قبول";
        acceptBtn.addEventListener("click", () => Multiplayer.acceptFriendRequest(fromUid, req.name));
        const declineBtn = document.createElement("button");
        declineBtn.className = "fr-decline";
        declineBtn.textContent = "رفض";
        declineBtn.addEventListener("click", () => Multiplayer.declineFriendRequest(fromUid));
        actions.appendChild(acceptBtn);
        actions.appendChild(declineBtn);
        li.appendChild(nameSpan);
        li.appendChild(actions);
        list.appendChild(li);
      });
    });

    Multiplayer.listenFriends((friends) => {
      const ids = Object.keys(friends || {});
      const list = $("friendsList");
      list.innerHTML = "";
      if (!ids.length) {
        list.innerHTML = "<li><span>ما عندك أصدقاء مضافين لسا</span></li>";
        return;
      }
      ids.forEach((fUid) => {
        const f = friends[fUid];
        const li = document.createElement("li");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = f.name || "صديق";
        const inviteBtn = document.createElement("button");
        inviteBtn.className = "fr-invite";
        inviteBtn.textContent = "دعوة للغرفة";
        inviteBtn.disabled = !Multiplayer.currentRoomCode();
        inviteBtn.addEventListener("click", async () => {
          try { await Multiplayer.inviteFriendToRoom(fUid); showToast("تم إرسال الدعوة"); }
          catch (e) { showToast("لازم تكون داخل غرفة أول عشان تدعوه"); }
        });
        li.appendChild(nameSpan);
        li.appendChild(inviteBtn);
        list.appendChild(li);
      });
    });

    // A friend invited us straight into their room — no code typing needed,
    // just tap "انضمام" on the popup.
    Multiplayer.listenInvites((invites) => {
      const codes = Object.keys(invites || {});
      const toast = $("inviteToast");
      if (!codes.length) { toast.classList.add("hidden"); return; }
      const code = codes[codes.length - 1];
      const inv = invites[code];
      toast.innerHTML = "";
      const label = document.createElement("span");
      label.textContent = `${inv.fromName || "صديق"} دعاك لغرفة`;
      const joinBtn = document.createElement("button");
      joinBtn.className = "join-btn";
      joinBtn.textContent = "انضمام";
      joinBtn.addEventListener("click", async () => {
        toast.classList.add("hidden");
        await Multiplayer.dismissInvite(code);
        try {
          await Multiplayer.joinRoom(code);
          enterLobby(code, false);
        } catch (e) {
          showToast("تعذّر الانضمام للغرفة — ربما أُغلقت.");
        }
      });
      const dismissBtn = document.createElement("button");
      dismissBtn.className = "dismiss-btn";
      dismissBtn.textContent = "تجاهل";
      dismissBtn.addEventListener("click", () => { Multiplayer.dismissInvite(code); toast.classList.add("hidden"); });
      toast.appendChild(label);
      toast.appendChild(joinBtn);
      toast.appendChild(dismissBtn);
      toast.classList.remove("hidden");
    });
  }
  $("mpLeaveLobbyBtn").addEventListener("click", async () => {
    mpBgLobby = null;
    updateMpReturnBtn();
    await Multiplayer.leaveRoom();
    showOverlay("hubScreen");
  });
}

async function boot() {
  marketApplyEquip(); // apply any previously-purchased/equipped Karnak outfit before any character model loads
  setupPointerLock();
  setupKeyboard();
  window.addEventListener("resize", onResize);

  // Touch stick/look/flashlight/run/jump + in-game mic/chat buttons are
  // all wired up together in controls.js (see setupControls there).
  setupControls();

  $("retryBtn").addEventListener("click", () => {
    $("deathScreen").classList.add("hidden");
    startGame();
  });
  $("menuFromDeathBtn").addEventListener("click", () => {
    leaveMultiplayerIfActive();
    $("deathScreen").classList.add("hidden");
    showOverlay("hubScreen");
  });
  $("playAgainBtn").addEventListener("click", () => {
    $("winScreen").classList.add("hidden");
    $("scoreSubmitBox").style.display = "none";
    startGame();
  });
  $("submitScoreBtn").addEventListener("click", async () => {
    const btn = $("submitScoreBtn");
    btn.disabled = true;
    btn.textContent = "جارٍ الإرسال...";
    const name = $("playerNameInput").value;
    const ok = await Leaderboard.submitScore(name, state.finalTime, state.keysCollected);
    btn.innerHTML = ok ? "تم الإرسال <i class=\"fa-solid fa-check\"></i>" : "تعذّر الإرسال";
    await refreshLeaderboard();
  });

  setupMenuAndMultiplayer();
  setupAuthScreen();
  loadCharacterModel("boy"); // warm the cache early so it's ready before anyone joins a room
  loadCharacterModel("girl");

  Leaderboard.init();
  refreshLeaderboard();

  $("loadingScreen").classList.add("hidden");
  // The auth screen is the very first thing the player ever sees — the
  // hub only appears once they pick an entry method (Google / name / guest).
  // Once they've logged in once, we remember it (dlb_logged_in) and skip
  // straight to the hub on every visit after that.
  OVERLAY_IDS.forEach((o) => $(o).classList.add("hidden"));

  // Google sign-in uses signInWithRedirect (see multiplayer.js), which
  // fully reloads the page — so a login started from authGoogleBtn only
  // finishes HERE, on the next boot, not inside that button's click
  // handler. Check for that before deciding which screen to show, or a
  // player who just signed in with Google would be bounced right back to
  // the auth screen instead of landing in the hub.
  let justSignedInWithGoogle = false;
  let persistedFirebaseUser = null;
  if (window.Multiplayer && Multiplayer.authAvailable()) {
    const redirectUser = await Multiplayer.resolveGoogleRedirect();
    if (redirectUser) {
      justSignedInWithGoogle = true;
    } else {
      // Independent second check: even if our own "dlb_logged_in" flag in
      // localStorage didn't survive, Firebase keeps its own session record
      // (covers Google AND, now, anonymous guest/name logins too — see
      // signInGuestPersistent in multiplayer.js). If either one survived,
      // the player should not be sent back to the login screen.
      persistedFirebaseUser = await Multiplayer.waitForAuthState();
    }
  }

  if (localStorage.getItem("dlb_logged_in") === "1") {
    showOverlay("hubScreen");
  } else if (justSignedInWithGoogle || persistedFirebaseUser) {
    enterHubAfterAuth();
  } else {
    $("authScreen").classList.remove("hidden");
    $("settingsGearBtn").style.display = "none";
    $("versionTag").style.display = "none";
  }

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

/* ---------------------------------------------------------------------
   16. Auth / splash screen — first screen, fullscreen + landscape lock,
   then Google / name / guest login before the hub ever appears.
--------------------------------------------------------------------- */
let rotateOverlayDismissed = false;

// Re-checked continuously (not just once right after login) — a one-shot
// check missed cases like: the fullscreen/landscape-lock APIs not being
// supported at all (all of iOS Safari, plus many Android browsers outside
// an installed PWA), or simply testing the game in a normal, resizable
// browser window instead of a real phone. In both cases the overlay used
// to pop up once and then never get removed by anything, permanently
// covering the character-pick screen (and everything else) since it sits
// above every other screen — so taps on "boy"/"girl" looked like they did
// nothing at all.
function updateRotateOverlay() {
  const needed = window.innerWidth < window.innerHeight;
  $("rotateOverlay").classList.toggle("show", needed && !rotateOverlayDismissed);
}

function requestFullscreenLandscape() {
  const el = document.documentElement;
  const goFullscreen = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  const tryLock = () => {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  };
  if (goFullscreen) {
    try {
      const p = goFullscreen.call(el);
      if (p && p.then) p.then(tryLock).catch(tryLock);
      else tryLock();
    } catch (e) { tryLock(); }
  } else {
    tryLock();
  }
  // If the device is still in portrait after trying (unsupported browser),
  // show the "please rotate" fallback instead of silently breaking the UI.
  setTimeout(updateRotateOverlay, 400);
}

window.addEventListener("resize", updateRotateOverlay);
window.addEventListener("orientationchange", updateRotateOverlay);
window.addEventListener("load", () => {
  $("rotateContinueBtn").addEventListener("click", () => {
    rotateOverlayDismissed = true;
    $("rotateOverlay").classList.remove("show");
  });
});

function enterHubAfterAuth() {
  localStorage.setItem("dlb_logged_in", "1");
  $("authScreen").classList.add("hidden");
  $("skinPickScreen").classList.remove("hidden");
}

function finishSkinPick(gender) {
  // Give instant visual feedback the tap registered before anything else
  // runs — on a slow phone the hub/preview setup below can take a beat,
  // and without this the card just sits there looking unresponsive.
  document.querySelectorAll(".skin-pick-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.gender === gender);
  });
  try {
    if (window.Multiplayer) Multiplayer.setGender(gender);
  } catch (e) {
    console.error("setGender failed:", e);
  }
  $("skinPickScreen").classList.add("hidden");
  $("boySkinPickScreen").classList.add("hidden");
  showOverlay("hubScreen");
}

function setupAuthScreen() {
  $("authScreen").addEventListener("click", requestFullscreenLandscape, { once: true });

  $("authGoogleBtn").addEventListener("click", async () => {
    requestFullscreenLandscape();
    if (!window.Multiplayer || !Multiplayer.authAvailable()) {
      $("authError").textContent = "تسجيل الدخول بـ Google غير مفعّل بعد على هذا المشروع — جرّب الدخول بالاسم أو كضيف.";
      return;
    }
    try {
      // This navigates away to Google and back (see multiplayer.js) — the
      // page fully reloads, so nothing below this line actually runs.
      // The login is picked up on the next boot() instead.
      await Multiplayer.signInWithGoogle();
    } catch (e) {
      console.error("Google sign-in failed:", e);
      $("authError").textContent = "تعذّر تسجيل الدخول بحساب Google.";
    }
  });

  $("authNameToggleBtn").addEventListener("click", () => {
    $("authNameForm").classList.toggle("show");
  });
  $("authNameSubmitBtn").addEventListener("click", async () => {
    const v = $("authNameInput").value.trim();
    if (!v) { $("authError").textContent = "اكتب اسمك أولًا."; return; }
    requestFullscreenLandscape();
    // loginWithName is the "type your name to get your stuff back" system:
    // if this exact name was used before, it pulls the saved skin/xp/
    // cosmetics down from Firebase and restores them here — works even
    // after clearing browser data, since the name itself (not a random
    // local id) is the recovery key. See multiplayer.js.
    if (window.Multiplayer) {
      await Multiplayer.loginWithName(v);
      marketApplyEquip(); // re-apply in case a restored save changed the equipped outfit
    }
    enterHubAfterAuth();
  });

  $("authGuestBtn").addEventListener("click", async () => {
    requestFullscreenLandscape();
    if (window.Multiplayer) {
      // Establish a real, Firebase-remembered session for this guest (not
      // just a localStorage flag) — see signInGuestPersistent in
      // multiplayer.js. "dlb_name" only exists once this device has
      // picked/received a name before: first-ever guest login → ask
      // Firebase for the next sequential GuestNN number; every time after
      // that → keep reusing the name that's already saved.
      await Multiplayer.signInGuestPersistent();
      if (!localStorage.getItem("dlb_name")) {
        const guestName = await Multiplayer.nextGuestName();
        Multiplayer.setName(guestName);
      } else {
        Multiplayer.syncUserProfile();
      }
    }
    enterHubAfterAuth();
  });

  document.querySelectorAll(".skin-pick-card").forEach((card) => {
    if (card.id === "skinPickBoyBtn") return; // handled separately below — opens a sub-menu instead of picking directly
    card.addEventListener("click", () => finishSkinPick(card.dataset.gender));
  });

  // Tapping "ولد" doesn't pick a skin directly — it opens the sub-screen
  // to choose between the boy skins (ولد 1 / ولد 2) first.
  $("skinPickBoyBtn").addEventListener("click", () => {
    $("skinPickScreen").classList.add("hidden");
    $("boySkinPickScreen").classList.remove("hidden");
  });
  $("boySkinPickBackBtn").addEventListener("click", () => {
    $("boySkinPickScreen").classList.add("hidden");
    $("skinPickScreen").classList.remove("hidden");
  });
}

window.addEventListener("load", boot);
