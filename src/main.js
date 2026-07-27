import * as THREE from 'three';
import { EventBus } from './shared/events.js';
import { CONFIG } from './shared/config.js';
import Input from './core/input.js';
import TouchControls, { shouldEnableTouchControls } from './core/touch-controls.js';
import World from './world/map.js';
import { MaterialSystem } from './gfx/materials/index.js';
import { PostChain } from './gfx/post/index.js';
import Player from './player/player.js';
import PlayerProfile from './player/profile.js';
import Weapons from './weapons/weapons.js';
import ViewModel from './weapons/viewmodel.js';
import Combat from './combat/combat.js';
import Bots from './ai/bots.js';
import Rounds from './game/rounds.js';
import HUD from './ui/hud.js';
import AudioSys from './audio/audio.js';
import Effects from './effects/effects.js';
import Multiplayer from './network/multiplayer.js';
import LeaderboardClient from './leaderboard/client.js';
import { DEFAULT_MAP_ID, normalizeMapId } from './maps/catalog.js';

const loadingScreen = globalThis.TINY_STRIKE_LOADING;
loadingScreen?.setStage?.('Initializing renderer', 18);

const app = document.getElementById('app');
const savedMapId = (() => {
  try { return localStorage.getItem('tiny-strike-map'); } catch { return null; }
})();
const queryMapId = new URLSearchParams(location.search).get('map');
const TOUCH_DEVICE = shouldEnableTouchControls();

// ?trailer — cinematic recording mode (tools/trailer.js): acts as debug mode
// and needs one extra body per side for the scripted kill choreography.
const TRAILER = new URLSearchParams(location.search).has('trailer');
if (TRAILER) CONFIG.MATCH.BOTS_PER_TEAM = 6;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });

function layoutViewportSize() {
  const root = document.documentElement;
  const width = Math.max(1, Math.round(root.clientWidth || window.innerWidth));
  const height = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
  return { width, height };
}

function visibleViewport(layout) {
  const visual = window.visualViewport;
  const scale = Number(visual?.scale ?? 1);
  if (!visual || !Number.isFinite(scale) || Math.abs(scale - 1) > 0.02) {
    return { ...layout, left: 0, top: 0 };
  }

  const width = Math.min(layout.width, Math.max(1, Math.round(visual.width || layout.width)));
  const height = Math.min(layout.height, Math.max(1, Math.round(visual.height || layout.height)));
  const left = Math.max(0, Math.min(layout.width - width, Math.round(visual.offsetLeft || 0)));
  const top = Math.max(0, Math.min(layout.height - height, Math.round(visual.offsetTop || 0)));
  return { width, height, left, top };
}

function syncViewportCss(layout) {
  const visible = visibleViewport(layout);
  const root = document.documentElement.style;
  root.setProperty('--layout-width', `${layout.width}px`);
  root.setProperty('--layout-height', `${layout.height}px`);
  root.setProperty('--app-width', `${visible.width}px`);
  root.setProperty('--app-height', `${visible.height}px`);
  root.setProperty('--app-left', `${visible.left}px`);
  root.setProperty('--app-top', `${visible.top}px`);
}

function targetPixelRatio(width, height) {
  const device = Math.max(1, Number(window.devicePixelRatio) || 1);
  if (!TOUCH_DEVICE) return Math.min(device, 2);
  // Keep high-density phone output crisp without asking large tablets to
  // shade several million pixels every frame.
  const cap = width * height > 1_000_000 ? 1.25 : 1.5;
  return Math.min(device, cap);
}

const initialViewport = layoutViewportSize();
syncViewportCss(initialViewport);
renderer.setPixelRatio(targetPixelRatio(initialViewport.width, initialViewport.height));
renderer.setSize(initialViewport.width, initialViewport.height);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = TOUCH_DEVICE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);
loadingScreen?.setStage?.('Building battleground', 38);
await loadingScreen?.waitForPaint?.();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  CONFIG.PLAYER.FOV,
  initialViewport.width / initialViewport.height,
  0.05,
  400
);
scene.add(camera);

const game = {
  config: CONFIG,
  events: new EventBus(),
  renderer,
  scene,
  camera,
  canvas: renderer.domElement,
  hudRoot: document.getElementById('hud'),
  debug: new URLSearchParams(location.search).has('test') || TRAILER,
  sessionMode: 'solo',
  selectedMapId: normalizeMapId(queryMapId || savedMapId || DEFAULT_MAP_ID),
  state: {
    phase: 'menu',
    round: 0,
    scores: { ct: 0, t: 0 },
    timer: 0,
    money: CONFIG.ECON.START_MONEY,
    bomb: { planted: false, site: null, pos: null, defusingBy: null, defuseProgress: 0, carrierId: null },
    canBuy: false,
    buyOpen: false,
  },
};

// Procedural PBR surfaces (src/gfx/materials) bake on the GPU the first time a
// material is asked for, so this costs nothing until the world builds. Phones
// get half-resolution texture sets; the shading is identical either way.
// One graphics tier for the whole session: texture budget, IBL resolution, the
// baked-sky refresh rate and how much set dressing a map gets all read it.
game.gfxQuality = TOUCH_DEVICE ? 'low' : 'high';
game.materials = new MaterialSystem({
  renderer,
  quality: game.gfxQuality,
  anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
});

// HDR post chain (src/gfx/post): render to a half-float target so emissives,
// muzzle flashes, tracers and the sun disc keep their real radiance, then bloom
// and tone map on the way to the canvas. It also owns the screen-space ambient
// occlusion pass, whose result the material shader reads while the beauty pass
// is being drawn (src/gfx/post/ssao.js).
//
// Off on 'low'. Phones are the reason the tier exists, and the chain costs a
// full-resolution RGBA16F target plus a pyramid of reads — bandwidth, which is
// the one thing a mobile tile GPU has least of, and the AO block adds a second
// geometry submit on top. On 'low' nothing below changes: the renderer keeps its
// own ACES tone mapping, the sky dome keeps applying its copy of the same curve,
// the AO term's master amount stays at 0 so the material shader short-circuits
// it on a uniform branch, and the frame goes straight to the canvas with the
// context's own MSAA, exactly as it did before this chain existed.
//
// ?post=off  force the direct path
// ?post=msaa|fxaa|none  pin the antialiasing instead of probing for it
// ?ssao=off  keep the HDR chain but drop the AO passes (A/B the term)
const SEARCH = new URLSearchParams(location.search);
const POST_PARAM = SEARCH.get('post');
const POST_AA = ['msaa', 'fxaa', 'none'].includes(POST_PARAM) ? POST_PARAM : 'auto';
game.post =
  POST_PARAM !== 'off' && game.gfxQuality !== 'low' && PostChain.supported(renderer)
    ? new PostChain(game, { aa: POST_AA, ssao: SEARCH.get('ssao') !== 'off' })
    : null;

// Construction order per SPEC.md — later modules may hold references to earlier ones.
game.profile = new PlayerProfile(game);
game.input = new Input(game);
game.world = new World(game);
loadingScreen?.setStage?.('Deploying operatives', 72);
game.effects = new Effects(game);
game.audio = new AudioSys(game);
game.player = new Player(game);
game.weapons = new Weapons(game);
game.viewmodel = new ViewModel(game);
game.combat = new Combat(game);
game.bots = new Bots(game);
game.rounds = new Rounds(game);
game.leaderboard = new LeaderboardClient(game);
game.hud = new HUD(game);
game.touchControls = new TouchControls(game);
game.multiplayer = new Multiplayer(game);
loadingScreen?.setStage?.('Calibrating combat systems', 92);

/**
 * The one place a frame gets drawn. Anything that drives its own loop should
 * call this rather than `renderer.render`, or it silently drops the post chain
 * — and with it the sky, which writes raw radiance while the chain is active.
 */
game.renderFrame = () => {
  if (game.post) game.post.render(scene, camera);
  else renderer.render(scene, camera);
  loadingScreen?.finish?.();
};

window.__game = game;

if (TRAILER) {
  import('../tools/trailer.js')
    .then((m) => m.default(game))
    .catch((err) => console.warn('[trailer] failed to load:', err));
}

function resizeRenderer() {
  const { width, height } = layoutViewportSize();
  syncViewportCss({ width, height });
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(targetPixelRatio(width, height));
  renderer.setSize(width, height);
  // Reads the drawing buffer size back off the renderer, so it stays correct
  // when the pixel ratio changes without the CSS size changing.
  game.post?.setSize();
}

window.addEventListener('resize', resizeRenderer, { passive: true });
window.visualViewport?.addEventListener?.('resize', resizeRenderer, { passive: true });

const UPDATE_ORDER = [
  // The world drives the sky: its LUT/IBL bakes must land before anything is
  // drawn with them.
  'world', 'rounds', 'touchControls', 'player', 'weapons', 'viewmodel', 'bots',
  // Spectator runs after replicated/AI actors so deaths, disconnects, and
  // poses affect the observer camera in the same rendered frame.
  'combat', 'multiplayer', 'spectator', 'effects', 'hud', 'audio', 'input',
  // Not gameplay: releases the texture forge's scratch targets once the bake
  // burst after a map load has clearly finished.
  'materials',
];

const clock = new THREE.Clock();
let frames = 0;
let fpsTime = 0;
game.fps = 60;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  frames++;
  fpsTime += dt;
  if (fpsTime >= 1) {
    game.fps = frames / fpsTime;
    frames = 0;
    fpsTime = 0;
  }

  for (const key of UPDATE_ORDER) {
    const sys = game[key];
    if (sys && typeof sys.update === 'function') sys.update(dt);
  }

  game.renderFrame();
});
