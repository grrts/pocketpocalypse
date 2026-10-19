import { CHUNK_TEXELS, lonLatToWorld, metersPerTexel, pointInRing, worldToLonLat, type Vec2 } from './core/geo';
import { hashString } from './core/rng';
import { getCountry } from './country/registry';
import type { PackManifest } from './data/types';
import { Camera, FlyTo, easeInOut } from './engine/camera';
import { ChunkManager } from './engine/chunks';
import { OverviewLayer } from './engine/overviewLayer';
import { Renderer } from './engine/renderer';
import { WorkerPool } from './engine/workerPool';
import { GameWorld, type Container, type Input } from './game/world';
import { IndexedDbKV } from './persist/kv';
import { LocalWorldStore, SAVE_VERSION, type PlayerSave, type WorldSave } from './persist/worldStore';
import { regionStateAt, simulateOutbreak, type RegionState } from './sim/outbreak';
import { TouchControls } from './ui/touch';
import { UI } from './ui/ui';
import type { InitMsg } from './worker/protocol';

type Mode = 'menu' | 'select' | 'flying' | 'playing' | 'map' | 'dead';

const params = new URLSearchParams(location.search);
const country = getCountry(params.get('country') ?? 'nl');
const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = new UI(document.getElementById('ui')!);
const kv = new IndexedDbKV();
const store = new LocalWorldStore(kv);
const cam = new Camera();
/** Street-level zoom: the shorter screen side shows about 75 m of ground, so phones see as much as desktops. */
function defaultPlayZoom(): number {
  const short = Math.min(innerWidth, innerHeight) || 800;
  return Math.max(18.6, Math.min(20.5, 18 + Math.log2(short / 200)));
}

let manifest: PackManifest;
let mode: Mode = 'menu';
let chunkPool: WorkerPool | null = null;
let overviewPool: WorkerPool | null = null;
let overview: OverviewLayer | null = null;
let dataErrorShown = false;
let chunks: ChunkManager | null = null;
let renderer: Renderer | null = null;
let world: GameWorld | null = null;
let playZoom = defaultPlayZoom();
let debug = params.has('debug');
let selectMarker: Vec2 | null = null;
let hover: Vec2 | null = null;
let region: RegionState | null = null;
let regionTimer = 0;
const fast = params.has('fast');

interface Flight {
  fly: FlyTo;
  t: number;
  target: Vec2;
  label: string;
  wait: boolean;
  waited: number;
  then: () => void;
}
let flight: Flight | null = null;
let search: { c: Container; t: number; dur: number } | null = null;
let lootOpen: Container | null = null;

// ---------------------------------------------------------------- input
const keys = new Set<string>();
const mouse = { x: 0, y: 0, down: false, dragging: false, sx: 0, sy: 0, touch: false };
let pressedInteract = false;

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  mouse.touch = false;
  keys.add(e.code);
  if (e.code === 'KeyE') pressedInteract = true;
  if (e.code === 'KeyF' && lootOpen && world) {
    world.take(lootOpen, 'all');
    ui.loot(world, lootOpen, () => undefined);
  }
  if ((e.code === 'KeyI' || e.code === 'Tab') && world && mode === 'playing') {
    e.preventDefault();
    toggleInventory();
  }
  if (e.code === 'Escape') {
    ui.hide('inv', 'loot');
    lootOpen = null;
  }
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'F3') {
    e.preventDefault();
    debug = !debug;
    if (!debug) ui.debug(null);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// Pointer events cover mouse, pen and touch alike. One finger drags the map
// and taps to choose; two fingers pinch to zoom, in every mode.
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { dist: number; zoom: number } | null = null;

function zoomAt(sx: number, sy: number, zoom: number) {
  const before = cam.screenToWorld(sx * cam.dpr, sy * cam.dpr);
  cam.zoom = Math.max(4, Math.min(21, zoom));
  const after = cam.screenToWorld(sx * cam.dpr, sy * cam.dpr);
  cam.center.x += before.x - after.x;
  cam.center.y += before.y - after.y;
}

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') document.body.classList.add('touch');
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  mouse.touch = e.pointerType !== 'mouse';
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (pointers.size === 1) {
    mouse.down = true;
    mouse.dragging = false;
    mouse.sx = e.clientX;
    mouse.sy = e.clientY;
  } else if (pointers.size === 2) {
    // a second finger turns the gesture into a pinch, never a tap
    mouse.dragging = true;
    pinch = { dist: pinchState().dist, zoom: mode === 'playing' ? playZoom : cam.zoom };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) {
    // hovering mouse
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    return;
  }
  if (pinch && pointers.size >= 2) {
    const before = pinchState();
    prev.x = e.clientX;
    prev.y = e.clientY;
    const now = pinchState();
    const z = pinch.zoom + Math.log2(now.dist / pinch.dist);
    if (mode === 'playing') playZoom = Math.max(17.6, Math.min(22, z));
    else if (mode === 'select' || mode === 'map') {
      zoomAt(now.mx, now.my, z);
      cam.center.x -= ((now.mx - before.mx) * cam.dpr) / cam.ppt;
      cam.center.y -= ((now.my - before.my) * cam.dpr) / cam.ppt;
    }
    return;
  }
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  prev.x = e.clientX;
  prev.y = e.clientY;
  if (mouse.down && Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > (mouse.touch ? 10 : 4)) mouse.dragging = true;
  if (mouse.down && mouse.dragging && (mode === 'select' || mode === 'map')) {
    cam.center.x -= (dx * cam.dpr) / cam.ppt;
    cam.center.y -= (dy * cam.dpr) / cam.ppt;
  }
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});
function pointerUp(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size < 2) pinch = null;
  if (pointers.size > 0) return;
  if (e.type === 'pointerup' && mode === 'select' && mouse.down && !mouse.dragging) {
    const w = cam.screenToWorld(e.clientX * cam.dpr, e.clientY * cam.dpr);
    const ll = worldToLonLat(w.x, w.y);
    choose(ll.lon, ll.lat, nearestPlaceName(ll.lon, ll.lat));
  }
  mouse.down = false;
}
canvas.addEventListener('pointerup', pointerUp);
canvas.addEventListener('pointercancel', pointerUp);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode === 'playing') {
    playZoom = Math.max(17.6, Math.min(22, playZoom - e.deltaY * 0.0015));
  } else if (mode === 'select' || mode === 'map') {
    zoomAt(e.clientX, e.clientY, cam.zoom - e.deltaY * 0.002);
  }
}, { passive: false });

const touch = new TouchControls(document.getElementById('ui')!, {
  interact: () => { pressedInteract = true; },
  bag: () => toggleInventory(),
  map: () => toggleMap(),
});
if (touch.enabled) document.body.classList.add('touch');

function toggleInventory() {
  if (!world || mode !== 'playing') return;
  if (ui.isOpen('inv')) ui.hide('inv');
  else ui.inventory(world);
}

let lastMove: Vec2 = { x: 0, y: 1 };

/** On touch there is no cursor: face the nearest zombie in reach, else where the survivor walks. */
function touchAim(): Vec2 {
  const p = world!.player;
  const reach = 8 / metersPerTexel(p.y);
  let best: Vec2 | null = null, bd = reach;
  for (const z of world!.allZombies()) {
    const d = Math.hypot(z.x - p.x, z.y - p.y);
    if (d < bd) { bd = d; best = z; }
  }
  return best ? { x: best.x, y: best.y } : { x: p.x + lastMove.x, y: p.y + lastMove.y };
}

function readInput(): Input {
  const modal = ui.isOpen('inv');
  let moveX = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let moveY = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  if (!moveX && !moveY) {
    moveX = touch.moveX;
    moveY = touch.moveY;
  }
  if (modal) moveX = moveY = 0;
  if (moveX || moveY) lastMove = { x: moveX, y: moveY };
  const aim = mouse.touch ? touchAim() : cam.screenToWorld(mouse.x * cam.dpr, mouse.y * cam.dpr);
  return {
    moveX,
    moveY,
    sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.sprint,
    aim,
    // a finger on the map is never an attack; the HIT button is
    attack: !modal && ((mouse.down && !mouse.touch) || keys.has('Space') || touch.attack),
    interact: pressedInteract,
  };
}

// ---------------------------------------------------------------- world setup
function insideCountry(lon: number, lat: number): boolean {
  return manifest.outline.some((ring) => pointInRing(lon, lat, ring.flat()));
}

function nearestPlaceName(lon: number, lat: number): string {
  let best = 'the countryside', bd = Infinity;
  for (const c of manifest.cities.slice(0, 200)) {
    const d = Math.hypot((c.lon - lon) * Math.cos((lat * Math.PI) / 180), c.lat - lat) * 111;
    if (d < bd) { bd = d; best = c.name; }
  }
  return bd < 2.5 ? best : `outside ${best}`;
}

async function startWorld(save: WorldSave, player: PlayerSave | null) {
  chunkPool?.dispose();
  overviewPool?.dispose();
  const init: InitMsg = {
    type: 'init',
    // relative paths: the page fetches them for the workers (see worker/fetchProxy.ts)
    packUrl: country.packUrl,
    bakedDetailUrl: country.bakedDetailUrl,
    bundleUrl: country.bundleUrl,
    elevationUrl: country.elevationUrl,
    // everything comes from the baked country data; nothing live while playing
    useOverpass: false,
    seed: save.seed,
    history: save.history,
  };
  const cores = navigator.hardwareConcurrency || 4;
  chunkPool = new WorkerPool(Math.max(1, Math.min(3, cores - 2)), init);
  overviewPool = new WorkerPool(cores >= 6 ? 2 : 1, init);
  overview = new OverviewLayer(overviewPool);
  world = null;
  const listener = {
    onChunkReady: (c: Parameters<GameWorld['onChunkReady']>[0]) => {
      // never fail silently: say when the baked map could not be read
      if (c.stats?.dataError && !dataErrorShown) {
        dataErrorShown = true;
        ui.toast(`Map data failed to load here: ${c.stats.dataError}`);
      }
      world?.onChunkReady(c);
    },
    onChunkError: (c: { error?: string }) => {
      if (dataErrorShown) return;
      dataErrorShown = true;
      ui.toast(`The map could not be generated here: ${c.error}`);
    },
    onChunkUnload: (c: Parameters<GameWorld['onChunkUnload']>[0]) => world?.onChunkUnload(c),
  };
  chunks = new ChunkManager(chunkPool, listener);
  world = new GameWorld(save, store, chunks);
  if (player) world.player.load(player);
  world.onDeath = () => {
    mode = 'dead';
    ui.hide('loot', 'inv');
    setTimeout(() => world && ui.death(world, world.player.hp <= 0 && world.player.hunger <= 0 ? 'starvation' : 'zombie', respawn), 900);
  };
  renderer = new Renderer(canvas, cam, overview, chunks);
  renderer.resize();
  renderer.setCountry(manifest, save.history);
  ui.attribution(manifest.attribution + ' · Elevation: AWS Terrain Tiles · Natural Earth');
}

function countryCenter(): Vec2 {
  const [w, s, e, n] = manifest.bbox;
  return lonLatToWorld((w + e) / 2, (s + n) / 2);
}

function countryZoom(): number {
  const [w, s, e, n] = manifest.bbox;
  const a = lonLatToWorld(w, n), b = lonLatToWorld(e, s);
  return cam.zoomForSpan(Math.max(b.x - a.x, (b.y - a.y) * (cam.width / cam.height)) * 1.25);
}

async function newWorld(seedText: string) {
  ui.hide('menu');
  const seed = seedText ? hashString(seedText) : (Math.random() * 2 ** 32) >>> 0;
  const history = simulateOutbreak(seed, country, manifest.cities);
  const save: WorldSave = { version: SAVE_VERSION, seed, countryId: country.id, createdAt: Date.now(), history, playerCorpses: [] };
  await store.reset();
  await store.saveWorld(save);
  await startWorld(save, null);
  enterSelect();
}

function enterSelect() {
  mode = 'select';
  cam.center = countryCenter();
  cam.zoom = 3.2;
  startFlight({ center: countryCenter(), zoom: countryZoom() }, '', false, () => {
    mode = 'select';
  });
  mode = 'select';
  ui.select(world!.save.history);
}

function choose(lon: number, lat: number, name: string) {
  if (!world || flight?.wait) return;
  if (!insideCountry(lon, lat)) {
    ui.toast(`That's outside the ${country.name}. This proof of concept covers the ${country.name} only.`);
    return;
  }
  ui.hide('select');
  const target = lonLatToWorld(lon, lat);
  selectMarker = target;
  startFlight({ center: target, zoom: (playZoom = defaultPlayZoom()) }, `Descending to ${name}`, true, () => spawnAt(target, name));
}

function startFlight(to: { center: Vec2; zoom: number }, label: string, wait: boolean, then: () => void) {
  const fly = new FlyTo(cam, { center: { ...cam.center }, zoom: cam.zoom }, to, fast ? 6 : 1);
  flight = { fly, t: 0, target: to.center, label, wait, waited: 0, then };
  if (wait) mode = 'flying';
  // warm up the coarse overview levels along the way
  overview?.prefetch(cam, [5, 6, 7, 8]);
}

function spawnAt(target: Vec2, name: string) {
  if (!world || !chunks) return;
  const p = world.player;
  const pos = p.alive ? chunks.findWalkable(target, 300) ?? target : target;
  p.x = pos.x;
  p.y = pos.y;
  if (!p.spawnName) {
    p.spawn = { ...pos };
    p.spawnName = name;
    p.add('water_bottle', 2);
    p.add('stroopwafel', 2);
    p.add('bandage', 2);
    p.add('kitchen_knife', 1);
    p.equipped = 'kitchen_knife';
    world.say(`Day ${world.save.history.presentDay}. ${name}. Find food, water and something better to fight with.`);
  }
  selectMarker = null;
  ui.hide('flight');
  if (!p.alive) {
    // saved while dead: pick up at the death screen
    mode = 'dead';
    ui.death(world, 'zombie', respawn);
    return;
  }
  world.paused = false;
  mode = 'playing';
  ui.hud();
  void store.savePlayer(p.toSave());
}

async function continueWorld() {
  const save = await store.loadWorld();
  const player = await store.loadPlayer();
  if (!save) return;
  ui.hide('menu');
  await startWorld(save, player);
  if (!player || !player.spawnName) return enterSelect();
  cam.center = countryCenter();
  cam.zoom = 3.2;
  const target = { x: player.x, y: player.y };
  startFlight({ center: target, zoom: (playZoom = defaultPlayZoom()) }, `Returning to ${player.spawnName}`, true, () => spawnAt(target, player.spawnName));
}

function respawn() {
  if (!world) return;
  ui.hide('death');
  const p = world.respawn();
  world.paused = true;
  startFlight({ center: p, zoom: (playZoom = defaultPlayZoom()) }, `Survivor #${world.player.survivor}`, true, () => spawnAt(p, world!.player.spawnName));
}

function toggleMap() {
  if (!world) return;
  if (mode === 'playing') {
    world.paused = true;
    ui.hide('loot', 'inv');
    lootOpen = null;
    mode = 'map';
    startFlight({ center: { x: world.player.x, y: world.player.y }, zoom: 12.5 }, '', false, () => undefined);
  } else if (mode === 'map') {
    const p = { x: world.player.x, y: world.player.y };
    startFlight({ center: p, zoom: playZoom }, '', true, () => {
      world!.paused = false;
      mode = 'playing';
      ui.hide('flight');
    });
  }
}

// ---------------------------------------------------------------- frame loop
let last = performance.now();
let fps = 60;

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
  if (renderer) renderer.resize();
  else drawSpace();

  if (flight) {
    const f = flight;
    let step = dt / f.fly.duration;
    const ready = !f.wait || (chunks!.isReadyAround(f.target, 1) && world!.isAttached(Math.floor(f.target.x / CHUNK_TEXELS), Math.floor(f.target.y / CHUNK_TEXELS)));
    // hover above the rooftops until the street data has arrived
    if (f.wait && !ready && cam.zoom > 17.2 && f.t > 0.5) {
      f.waited += dt;
      step *= 0.02;
      const n = chunks!.loading;
      ui.flight(f.label, `Scouting the streets… loading map data (${n} area${n === 1 ? '' : 's'} left)`);
      if (f.waited > 90) {
        ui.toast('Map data is taking too long here; continuing with terrain only.');
        f.wait = false;
      }
    } else if (f.wait && f.label) ui.flight(f.label, '');
    f.t = Math.min(1, f.t + step);
    const s = f.fly.at(easeInOut(f.t));
    cam.center = s.center;
    cam.zoom = s.zoom;
    if (f.t >= 1) {
      flight = null;
      f.then();
    }
  }

  if (world && chunks) {
    const p = world.player;
    if (mode === 'playing') {
      const input = readInput();
      world.update(dt, input);
      handleInteraction(dt, input);
      // camera follows the survivor
      const k = 1 - Math.exp(-dt * 8);
      cam.center.x += (p.x - cam.center.x) * k;
      cam.center.y += (p.y - cam.center.y) * k;
      cam.zoom += (playZoom - cam.zoom) * (1 - Math.exp(-dt * 6));
      regionTimer -= dt;
      if (regionTimer <= 0) {
        regionTimer = 0.5;
        const ll = worldToLonLat(p.x, p.y);
        region = regionStateAt(world.save.history, ll.lon, ll.lat);
      }
      updateHud();
    } else if (mode === 'dead') {
      world.update(dt, { moveX: 0, moveY: 0, sprint: false, aim: { x: p.x, y: p.y }, attack: false, interact: false });
    }
    pressedInteract = false;
    const focus: Vec2[] = [];
    if (mode === 'playing' || mode === 'dead') focus.push({ x: p.x, y: p.y });
    if (flight?.wait) focus.push(flight.target);
    chunks.update(cam, focus, now);
    if (mode === 'select') {
      const w = cam.screenToWorld(mouse.x * cam.dpr, mouse.y * cam.dpr);
      hover = w;
    } else hover = null;
    renderer!.render(world, { debug, showCities: mode === 'select' || mode === 'map' || mode === 'flying', marker: selectMarker, hover }, now);
  }
  touch.setMode(mode === 'playing' ? 'playing' : mode === 'map' ? 'map' : 'off');
  if (debug) showDebug();
  requestAnimationFrame(frame);
}

function handleInteraction(dt: number, input: Input) {
  if (!world) return;
  const p = world.player;
  const near = world.nearestInteractable();
  if (lootOpen && (!near || near.id !== lootOpen.id)) {
    ui.hide('loot');
    lootOpen = null;
  }
  if (search) {
    if (input.moveX || input.moveY || !near || near.id !== search.c.id || !p.alive) search = null;
    else {
      search.t += dt;
      if (search.t >= search.dur) {
        lootOpen = search.c;
        ui.loot(world, search.c, () => undefined);
        search = null;
      }
    }
  } else if (input.interact && near && p.alive) {
    if (world.isSearched(near)) {
      lootOpen = near;
      ui.loot(world, near, () => undefined);
    } else {
      search = { c: near, t: 0, dur: near.kind === 'building' ? 1.4 : 0.8 };
      // rummaging is not silent
      world.makeNoise(p.x, p.y, 4 / metersPerTexel(p.y));
    }
  }
}

function updateHud() {
  if (!world) return;
  const p = world.player;
  const near = world.nearestInteractable();
  let prompt: string | null = null;
  if (near && !lootOpen && !search) {
    const empty = world.isSearched(near) && !(near.items?.length);
    prompt = `${touch.enabled ? '' : '[E] '}${world.isSearched(near) ? 'Open' : 'Search'} ${near.label}${empty ? ' (empty)' : ''}`;
  }
  const ll = worldToLonLat(p.x, p.y);
  const coords = `${ll.lat.toFixed(5)}°N ${ll.lon.toFixed(5)}°E`;
  let compass = null;
  if (world.save.playerCorpses.length && p.alive) {
    const pc = world.save.playerCorpses[world.save.playerCorpses.length - 1];
    const dx = pc.x - p.x, dy = pc.y - p.y;
    const m = Math.hypot(dx, dy) * metersPerTexel(p.y);
    if (m > 6) {
      const a = Math.atan2(dy, dx);
      const s = cam.worldToScreen(p.x, p.y);
      const r = 90;
      compass = { x: s.x / cam.dpr + Math.cos(a) * r, y: s.y / cam.dpr + Math.sin(a) * r, angle: a, text: `your body ${m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'}` };
    }
  }
  ui.updateHud(world, region, coords, prompt, search ? search.t / search.dur : null, compass);
}

function showDebug() {
  const lines = [
    `fps ${fps.toFixed(0)}  render ${renderer?.frameMs.toFixed(1) ?? '-'} ms`,
    `zoom ${cam.zoom.toFixed(2)}  mode ${mode}`,
  ];
  if (chunks) {
    let ready = 0, err = 0, ms = 0, n = 0;
    for (const c of chunks.chunks.values()) {
      if (c.state === 'ready') ready++;
      if (c.state === 'error') err++;
      if (c.stats) { ms += c.stats.ms; n++; }
    }
    lines.push(`chunks ${ready} ready / ${chunks.loading} loading / ${err} err  avg gen ${n ? (ms / n).toFixed(0) : '-'} ms`);
    lines.push(`queue chunk ${chunkPool?.queued}/${chunkPool?.busy}  overview ${overviewPool?.queued}/${overviewPool?.busy} (${overview?.pending} tiles)`);
  }
  if (world) {
    let z = 0;
    for (const _ of world.allZombies()) z++;
    lines.push(`zombies loaded ${z}  attached chunks ${world.ents.size}`);
  }
  ui.debug(lines.join('\n'));
}

const stars = Array.from({ length: 220 }, () => [Math.random(), Math.random(), Math.random()]);
function drawSpace() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  cam.width = canvas.width;
  cam.height = canvas.height;
  cam.dpr = dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [x, y, b] of stars) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + b * 0.8})`;
    ctx.fillRect(Math.floor(x * canvas.width), Math.floor(y * canvas.height), dpr, dpr);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void world?.flush();
});
window.addEventListener('pagehide', () => void world?.flush());

// ---------------------------------------------------------------- boot
async function boot() {
  const res = await fetch(`${country.packUrl}/manifest.json`);
  manifest = (await res.json()) as PackManifest;
  const save = await store.loadWorld().catch(() => null);
  const player = save ? await store.loadPlayer() : null;
  ui.menu(
    {
      hasSave: !!save,
      saveText: player?.spawnName ? `survivor #${player.survivor} near ${player.spawnName}` : 'choose a spawn',
      attribution: manifest.attribution,
    },
    { continue: () => void continueWorld(), newWorld: (s) => void newWorld(s) },
  );
  requestAnimationFrame(frame);
  if (params.has('autostart')) {
    await newWorld(params.get('seed') ?? 'test');
    const sp = params.get('spawn');
    if (sp) {
      const [lon, lat] = sp.split(',').map(Number);
      choose(lon, lat, nearestPlaceName(lon, lat));
    }
  } else if (params.has('continue') && save) {
    await continueWorld();
  }
}

// Hooks for automated tests and debugging from the console
(window as unknown as Record<string, unknown>).__pp = {
  get mode() { return mode; },
  get world() { return world; },
  get chunks() { return chunks; },
  cam,
  choose,
  respawn,
  toggleMap,
  flush: () => world?.flush(),
};

void boot();

