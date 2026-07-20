// ============================================================================
// TINY STRIKE — World maps, collision, and navigation graphs.
//
// Coordinates: X east(+)/west(-), Z south(+)/north(-). CT spawn north (z<0),
// T spawn south (z>0). Playable bounds roughly x[-50,50], z[-40,40].
// Zones: A site = elevated platform NE (warm ochre), B site = tunnel-fed room
// NW (cool stone), open mid lane with catwalk + double doors, long A lane east.
// All solids are axis-aligned boxes (spec rule 7).
// ============================================================================
import * as THREE from 'three';
import {
  makeWallTexture,
  makeFloorTexture,
  makeCrateTexture,
  makeMetalTexture,
  makeSkyTexture,
  makeSiteMarkerTexture,
} from './textures.js';
import { DEFAULT_MAP_ID, mapById, normalizeMapId } from '../maps/catalog.js';
import { worldMapDefinition } from './maps/registry.js';
import { buildDefinitionGeometry, buildDefinitionNavigation } from './maps/runtime-builder.js';

const WALL_H = 5; // default interior wall height

// scratch objects for hot paths (never allocate per frame)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export default class World {
  constructor(game) {
    this.game = game;

    // ---- internals -------------------------------------------------------
    this._unitBox = new THREE.BoxGeometry(1, 1, 1);
    this._cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
    this._raycaster = new THREE.Raycaster();
    this._rayHits = [];
    this._moveResult = { pos: new THREE.Vector3(), onGround: false, hitCeiling: false };
    this._nearCache = [];        // scratch for randomPointNear
    this._loaded = false;

    this.loadMap(this._requestedMapId(), { force: true });

    const select = (payload) => {
      const requested = typeof payload === 'string' ? payload : payload && (payload.mapId || payload.id);
      if (!requested) return;
      const phase = this.game.state && this.game.state.phase;
      if (phase && phase !== 'menu' && phase !== 'gameEnd') {
        this.game.events.emit('hud:notice', { text: 'Maps can be changed before a match starts.' });
        return;
      }
      this.loadMap(requested);
    };
    if (game.events && typeof game.events.on === 'function') {
      this._offMapSelect = game.events.on('ui:map-select', select);
      this._offWorldSelect = game.events.on('world:select-map', select);
    }
  }

  _requestedMapId() {
    if (this.game.selectedMapId) return normalizeMapId(this.game.selectedMapId);
    if (typeof location !== 'undefined') {
      const query = new URLSearchParams(location.search).get('map');
      if (query) return normalizeMapId(query);
    }
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('tiny-strike-map');
      if (saved) return normalizeMapId(saved);
    }
    return DEFAULT_MAP_ID;
  }

  // Rebuild the complete static world. The menu calls this before systems
  // spawn a round, but the method itself is intentionally public for hosts
  // applying a synchronized room map before `ui:start`.
  loadMap(value, { force = false } = {}) {
    const mapId = normalizeMapId(value);
    if (!force && this._loaded && mapId === this.mapId) return false;

    this._disposeLoadedMap();
    this.mapId = mapId;
    this.mapMeta = mapById(mapId);
    this.mapDefinition = worldMapDefinition(mapId);

    // ---- public API state ------------------------------------------------
    this.colliders = [];                 // THREE.Box3[] (world-space, static)
    this.solids = new THREE.Group();     // meshes for raycasts
    this.solids.name = `world-solids:${mapId}`;
    this.environment = new THREE.Group();
    this.environment.name = `world-environment:${mapId}`;
    this.spawns = { ct: [], t: [] };
    this.bombSites = [];
    this.waypoints = { nodes: [], edges: [] };
    this.botTactics = { attackRoutes: {}, defenseAreas: [] };
    this._adjacency = null;
    this._pathCache = new Map();

    this._initMaterials();
    this._buildSky();
    this._buildLights();
    this._buildMap();
    this._buildWaypoints();

    this.game.scene.add(this.environment);
    this.game.scene.add(this.solids);
    this.solids.updateMatrixWorld(true);
    this.environment.updateMatrixWorld(true);
    this._loaded = true;
    this.game.selectedMapId = mapId;
    if (this.game.state) this.game.state.mapId = mapId;
    if (typeof localStorage !== 'undefined') localStorage.setItem('tiny-strike-map', mapId);

    if (this.game.debug) this._validateNav();
    if (this.game.events && typeof this.game.events.emit === 'function') {
      this.game.events.emit('map:changed', { mapId });
    }
    return true;
  }

  _disposeLoadedMap() {
    if (!this._loaded) return;
    const scene = this.game.scene;
    if (this.solids) scene.remove(this.solids);
    if (this.environment) scene.remove(this.environment);

    const geometries = new Set();
    const materials = new Set();
    const visit = (root) => {
      if (!root) return;
      root.traverse((object) => {
        if (object.geometry && object.geometry !== this._unitBox && object.geometry !== this._cylGeo) {
          geometries.add(object.geometry);
        }
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const mat of objectMaterials) if (mat) materials.add(mat);
      });
    };
    visit(this.solids);
    visit(this.environment);
    for (const geometry of geometries) geometry.dispose();

    if (this.mats) for (const mat of Object.values(this.mats)) if (mat) materials.add(mat);
    const textures = new Set();
    for (const mat of materials) {
      for (const value of Object.values(mat)) if (value && value.isTexture) textures.add(value);
      mat.dispose();
    }
    for (const texture of textures) texture.dispose();
    if (this._sourceTextures) {
      for (const texture of this._sourceTextures) texture.dispose();
      this._sourceTextures = null;
    }
    scene.fog = null;
    this.sun = null;
  }

  // =========================================================================
  // Materials / textures
  // =========================================================================
  _initMaterials() {
    const theme = this.mapDefinition ? this.mapDefinition.theme : {
      key: 'desert',
      wall: '#c8a878', wallA: '#cfa368', wallB: '#a8a69c', floor: '#b3a07c',
      trim: '#8f7a58', metal: '#7a7f85', wood: '#9c8a6a', fog: 0xd9b48a,
      fogNear: 70, fogFar: 165, skyTint: 0xffffff, sun: 0xffd9a6,
      sunIntensity: 2.6, sunPosition: [58, 52, -26], hemiSky: 0x9db0d6,
      hemiGround: 0x9a7a52, ambient: 0x4a4038, ambientIntensity: 0.5,
      accentA: '#d98e3f', accentB: '#657f91', markerA: '#ffb050', markerB: '#7fb2d9',
    };
    this.theme = theme;

    const texWallN = makeWallTexture({ base: theme.wall, accent: theme.trim });
    const texWallA = makeWallTexture({ base: theme.wallA, accent: theme.accentA });
    const texWallB = makeWallTexture({ base: theme.wallB, accent: theme.accentB });
    const texFloor = makeFloorTexture({ base: theme.floor });
    const texCrate = makeCrateTexture();
    const texMetal = makeMetalTexture({ base: theme.metal });
    this._sourceTextures = [texWallN, texWallA, texWallB, texFloor, texCrate, texMetal];

    const rep = (tex, x, y) => {
      const t = tex.clone();
      t.repeat.set(x, y);
      t.needsUpdate = true;
      return t;
    };
    const std = (map, color = 0xffffff, rough = 0.9, metal = 0.0) =>
      new THREE.MeshStandardMaterial({ map, color, roughness: rough, metalness: metal });

    this.mats = {
      ground: std(rep(texFloor, 22, 18)),
      padWarm: std(rep(texFloor, 6, 5), theme.wallA),
      padCool: std(rep(texFloor, 6, 5), theme.wallB),
      padPlat: std(rep(texFloor, 4, 4), theme.wallA),
      padPlatB: std(rep(texFloor, 4, 4), theme.wallB),
      wallN: std(rep(texWallN, 4, 1.6)),
      wallNs: std(rep(texWallN, 1.2, 1.2)),
      wallA: std(rep(texWallA, 4, 1.6)),
      wallAs: std(rep(texWallA, 1.2, 1.2)),
      wallB: std(rep(texWallB, 4, 1.6)),
      wallBs: std(rep(texWallB, 1.2, 1.2)),
      trim: std(rep(texWallN, 2, 0.5), theme.trim),
      crate: std(rep(texCrate, 1, 1), 0xffffff, 0.85),
      crateDark: std(rep(texCrate, 1, 1), theme.wood, 0.85),
      metal: std(rep(texMetal, 1, 1), 0xffffff, 0.55, 0.45),
      metalDoor: std(rep(texMetal, 1, 1), theme.metal, 0.5, 0.5),
      metalDark: std(rep(texMetal, 1, 1), 0x29323a, 0.48, 0.55),
      barrel: std(rep(texMetal, 2, 1), 0x77855f, 0.6, 0.35),
      barrelRed: std(rep(texMetal, 2, 1), 0xa8543a, 0.6, 0.35),
      sandbag: new THREE.MeshStandardMaterial({ color: 0xa39469, roughness: 1.0 }),
      wood: std(rep(texCrate, 2, 0.6), theme.wood, 0.9),
      snow: std(rep(texFloor, 10, 10), 0xe8f3f4, 1.0),
      solar: new THREE.MeshStandardMaterial({ color: 0x18344e, roughness: 0.3, metalness: 0.65 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x8ed5e8, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.55 }),
      iceGlow: new THREE.MeshStandardMaterial({ color: 0x78ddff, emissive: 0x2f9fc7, emissiveIntensity: 1.4 }),
      accentA: std(rep(texMetal, 1, 1), theme.accentA, 0.5, 0.5),
      accentB: std(rep(texMetal, 1, 1), theme.accentB, 0.5, 0.5),
      hotMetal: new THREE.MeshStandardMaterial({ color: 0x6d3828, emissive: 0xff4c18, emissiveIntensity: 0.45, roughness: 0.45, metalness: 0.65 }),
      neonA: new THREE.MeshStandardMaterial({ color: theme.accentA, emissive: theme.accentA, emissiveIntensity: 2.8 }),
      neonB: new THREE.MeshStandardMaterial({ color: theme.accentB, emissive: theme.accentB, emissiveIntensity: 2.8 }),
      metalGrid: std(rep(texMetal, 5, 5), 0x778a94, 0.4, 0.72),
      warning: new THREE.MeshStandardMaterial({ color: 0xffc23d, emissive: 0x8a3a00, emissiveIntensity: 0.6, roughness: 0.6 }),
      water: new THREE.MeshStandardMaterial({ color: 0x2f7186, roughness: 0.18, metalness: 0.3, transparent: true, opacity: 0.78 }),
      stoneDark: std(rep(texWallB, 1.5, 1.5), 0x605a51, 1.0),
      stoneLight: std(rep(texFloor, 3, 3), 0xc0a986, 0.95),
    };
  }

  // =========================================================================
  // Sky, fog, lights
  // =========================================================================
  _buildSky() {
    const scene = this.game.scene;
    const theme = this.theme;
    const skyTex = makeSkyTexture();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(185, 32, 16),
      new THREE.MeshBasicMaterial({
        map: skyTex, color: theme.skyTint, side: THREE.BackSide, fog: false, depthWrite: false,
      })
    );
    dome.name = 'sky';
    dome.rotation.y = -Math.PI * 0.35; // put the sun glow toward the real sun azimuth
    this.environment.add(dome);
    scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);
  }

  _buildLights() {
    const theme = this.theme;

    // Warm late-afternoon sun (~35 deg elevation) with one big shadow map.
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
    sun.position.fromArray(theme.sunPosition);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -78;
    cam.right = 78;
    cam.top = 78;
    cam.bottom = -78;
    cam.near = 10;
    cam.far = 230;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    this.environment.add(sun);
    this.environment.add(sun.target);
    this.sun = sun;

    // Sky/ground fill.
    const hemi = new THREE.HemisphereLight(
      theme.hemiSky,
      theme.hemiGround,
      theme.hemiIntensity || 0.55
    );
    this.environment.add(hemi);
    const amb = new THREE.AmbientLight(theme.ambient, theme.ambientIntensity);
    this.environment.add(amb);

    // Small warm fills in the dim interiors (no shadows — cheap).
    if (this.mapDefinition) return;
    const tun = new THREE.PointLight(0xffb066, 6, 14, 1.8);
    tun.position.set(-36, 2.1, 7);
    this.environment.add(tun);
    const bRoom = new THREE.PointLight(0xffc788, 5, 16, 1.8);
    bRoom.position.set(-30, 3.2, -14);
    this.environment.add(bRoom);
    const corr = new THREE.PointLight(0xffb066, 4, 10, 1.8);
    corr.position.set(-10, 2.2, -14);
    this.environment.add(corr);
  }

  // =========================================================================
  // Geometry helpers
  // =========================================================================

  // Solid box by center + size. Adds mesh (into solids) + collider.
  box(x, y, z, w, h, d, material, surface = 'concrete') {
    const mesh = new THREE.Mesh(this._unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = surface;
    this.solids.add(mesh);
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)
    ));
    return mesh;
  }

  // Solid box by min/max spans (x0<x1, y0<y1, z0<z1) — layout tables use this.
  slab(x0, x1, y0, y1, z0, z1, material, surface = 'concrete') {
    return this.box(
      (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
      x1 - x0, y1 - y0, z1 - z0, material, surface
    );
  }

  // Decorative (non-solid, no collider) box — cornices, door leaves' handles...
  deco(x, y, z, w, h, d, material) {
    const mesh = new THREE.Mesh(this._unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.environment.add(mesh);
    return mesh;
  }

  // Archway: lintel over an opening in a wall running along `axis` ('x'|'z').
  // (cx,cz) center of opening, `width` opening span, wall thickness `t`.
  arch(cx, cz, width, axis, t, yBot, yTop, material) {
    if (axis === 'x') {
      this.slab(cx - width / 2 - 0.45, cx + width / 2 + 0.45, yBot, yTop, cz - t / 2, cz + t / 2, material);
      // slightly proud pillars
      this.slab(cx - width / 2 - 0.45, cx - width / 2, 0, yBot, cz - t / 2 - 0.12, cz + t / 2 + 0.12, material);
      this.slab(cx + width / 2, cx + width / 2 + 0.45, 0, yBot, cz - t / 2 - 0.12, cz + t / 2 + 0.12, material);
    } else {
      this.slab(cx - t / 2, cx + t / 2, yBot, yTop, cz - width / 2 - 0.45, cz + width / 2 + 0.45, material);
      this.slab(cx - t / 2 - 0.12, cx + t / 2 + 0.12, 0, yBot, cz - width / 2 - 0.45, cz - width / 2, material);
      this.slab(cx - t / 2 - 0.12, cx + t / 2 + 0.12, 0, yBot, cz + width / 2, cz + width / 2 + 0.45, material);
    }
  }

  // Wooden crate (cube `s`) at feet position; stack via yBase.
  crate(x, z, s, yBase = 0, mat = null) {
    return this.box(x, yBase + s / 2, z, s, s, s, mat || this.mats.crate, 'wood');
  }

  // Metal barrel: cylinder visual + box collider.
  barrel(x, z, red = false, yBase = 0) {
    const r = 0.42;
    const h = 1.05;
    const mesh = new THREE.Mesh(this._cylGeo, red ? this.mats.barrelRed : this.mats.barrel);
    mesh.position.set(x, yBase + h / 2, z);
    mesh.scale.set(r, h, r);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = 'metal';
    this.solids.add(mesh);
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - r, yBase, z - r),
      new THREE.Vector3(x + r, yBase + h, z + r)
    ));
    return mesh;
  }

  // Architectural cylinder with a conservative box collider. Towers, tanks,
  // stacks, and crane pylons share this low-poly primitive across maps.
  column(x, z, radius, height, material, yBase = 0) {
    const mesh = new THREE.Mesh(this._cylGeo, material);
    mesh.position.set(x, yBase + height / 2, z);
    mesh.scale.set(radius, height, radius);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = 'concrete';
    this.solids.add(mesh);
    this.colliders.push(new THREE.Box3(
      new THREE.Vector3(x - radius, yBase, z - radius),
      new THREE.Vector3(x + radius, yBase + height, z + radius)
    ));
    return mesh;
  }

  // Sandbag wall: one collider box + several jittered bag meshes (decorative).
  sandbags(x0, x1, z0, z1, h = 1.0, yBase = 0) {
    this.slab(x0, x1, yBase, yBase + h, z0, z1, this.mats.sandbag, 'sand');
    // bag detail meshes (non-colliding, sit just proud of the collider)
    const alongX = (x1 - x0) >= (z1 - z0);
    const len = alongX ? (x1 - x0) : (z1 - z0);
    const rows = Math.max(1, Math.round(h / 0.34));
    const bags = Math.max(1, Math.round(len / 0.62));
    for (let r = 0; r < rows; r++) {
      for (let b = 0; b < bags; b++) {
        const t = (b + 0.5 + (r % 2) * 0.28) / bags;
        if (t >= 1) continue;
        const bx = alongX ? x0 + t * (x1 - x0) : (x0 + x1) / 2;
        const bz = alongX ? (z0 + z1) / 2 : z0 + t * (z1 - z0);
        const m = this.deco(
          bx, yBase + 0.17 + r * 0.33, bz,
          alongX ? 0.66 : (x1 - x0) + 0.08,
          0.34,
          alongX ? (z1 - z0) + 0.08 : 0.66,
          this.mats.sandbag
        );
        m.rotation.y = ((r * 31 + b * 17) % 7 - 3) * 0.02;
      }
    }
  }

  // Stairs: axis-aligned run of box treads. dir: '+z','-z','+x','-x' = climb direction.
  stairs(x0, x1, z0, z1, steps, rise, dir, mat, yBase = 0) {
    for (let i = 0; i < steps; i++) {
      const top = yBase + rise * (i + 1);
      let sx0 = x0, sx1 = x1, sz0 = z0, sz1 = z1;
      if (dir === '-z') { // climbing toward -z: lowest tread at z1 (south)
        const d = (z1 - z0) / steps;
        sz0 = z1 - d * (i + 1);
        sz1 = z1 - d * i;
      } else if (dir === '+z') {
        const d = (z1 - z0) / steps;
        sz0 = z0 + d * i;
        sz1 = z0 + d * (i + 1);
      } else if (dir === '-x') {
        const d = (x1 - x0) / steps;
        sx0 = x1 - d * (i + 1);
        sx1 = x1 - d * i;
      } else {
        const d = (x1 - x0) / steps;
        sx0 = x0 + d * i;
        sx1 = x0 + d * (i + 1);
      }
      this.slab(sx0, sx1, yBase, top, sz0, sz1, mat, 'concrete');
    }
  }

  // Painted floor site marker decal (non-solid).
  siteMarker(letter, color, x, y, z, size) {
    const tex = makeSiteMarkerTexture({ letter, color });
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.02, z);
    mesh.renderOrder = 1;
    this.environment.add(mesh);
    return mesh;
  }

  // =========================================================================
  // Map layout
  // =========================================================================
  _buildMap() {
    if (this.mapDefinition) {
      buildDefinitionGeometry(this, this.mapDefinition);
      return;
    }
    this._buildDustyardMap();
  }

  _buildDustyardMap() {
    const M = this.mats;
    const H = WALL_H;

    // ---- ground + zone tint pads ----------------------------------------
    const ground = this.slab(-52, 52, -1, 0, -42, 42, M.ground, 'sand');
    ground.castShadow = false;
    this.slab(-46, -14, 0, 0.06, -26, -2, M.padCool, 'concrete');   // B room floor
    this.slab(14, 38, 0, 0.06, 2, 26, M.padWarm, 'sand');           // A courtyard
    this.slab(38, 50, 0, 0.06, -8, 26, M.padWarm, 'sand');          // long A lane
    this.slab(-46, 34, 0, 0.06, 26, 40, M.padWarm, 'sand');         // T plaza
    this.slab(-26, 34, 0, 0.06, -40, -26, M.padCool, 'concrete');   // CT plaza

    // ---- perimeter (h9) ---------------------------------------------------
    this.slab(-51.5, 51.5, 0, 9, -41.5, -40, M.wallN);
    this.slab(-51.5, 51.5, 0, 9, 40, 41.5, M.wallN);
    this.slab(-51.5, -50, 0, 9, -40, 40, M.wallN);
    this.slab(50, 51.5, 0, 9, -40, 40, M.wallN);

    // ---- big corner building masses (varied heights for skyline) ---------
    this.slab(-50, -26, 0, 7, -40, -26, M.wallB);    // NW block (behind B)
    this.slab(34, 50, 0, 6, -40, -26, M.wallA);      // NE block (behind A)
    this.slab(-50, -46, 0, 6, 26, 40, M.wallN);      // SW sliver
    this.slab(34, 50, 0, 6.5, 32, 40, M.wallA);      // SE block (leaves long approach open)
    this.slab(-50, -46, 0, 6, -26, 26, M.wallB);     // west band

    // ---- CT plaza south wall (z=-26) with openings ------------------------
    // openings: B door x[-22,-18], mid doors x[-6,6] (framed), CT ramp x[11,22],
    // A stairs x[26,32]; catwalk base occupies x[6,11]; platform covers x[22,42].
    this.slab(-26, -22, 0, H, -26.3, -25.7, M.wallB);
    this.slab(-18, -6, 0, H, -26.3, -25.7, M.wallN);
    this.arch(-20, -26, 4, 'x', 0.6, 3.4, 4.7, M.wallBs);           // B door arch

    // ---- Mid double doors (chokepoint at z=-26, gap x[-1.5,1.5]) ----------
    this.slab(-6, -1.5, 0, H, -26.3, -25.7, M.wallN);
    this.slab(1.5, 6, 0, H, -26.3, -25.7, M.wallN);
    this.arch(0, -26, 3, 'x', 0.6, 3.3, 4.4, M.wallNs);
    // metal door leaves swung fully open, flat against the plaza-side wall
    this.slab(-3.0, -1.6, 0, 2.9, -26.44, -26.3, M.metalDoor, 'metal');
    this.slab(1.6, 3.0, 0, 2.9, -26.44, -26.3, M.metalDoor, 'metal');

    // ---- T plaza north wall (z=26) with openings --------------------------
    // openings: tunnels x[-42,-38], mid x[-6,6], courtyard x[16,24], long x[40,48]
    this.slab(-46, -42, 0, H, 25.7, 26.3, M.wallB);
    this.slab(-38, -6, 0, H, 25.7, 26.3, M.wallN);
    this.slab(6, 16, 0, H, 25.7, 26.3, M.wallN);
    this.slab(24, 40, 0, H, 25.7, 26.3, M.wallA);
    this.slab(48, 50, 0, H, 25.7, 26.3, M.wallA);
    this.arch(0, 26, 12, 'x', 0.6, 3.6, 4.9, M.wallNs);             // mid arch
    this.arch(20, 26, 8, 'x', 0.6, 3.5, 4.8, M.wallAs);             // courtyard arch
    this.arch(44, 26, 8, 'x', 0.6, 3.6, 5, M.wallAs);               // long A arch
    this.arch(-40, 26, 4, 'x', 0.6, 2.5, 4.2, M.wallBs);            // tunnel mouth

    // ---- B lower mass (south of B room) with tunnel cut -------------------
    // tunnels: seg1 x[-42,-38] z[10,26]; chamber x[-42,-30] z[4,10]; seg2 x[-38,-34] z[-2,4]
    this.slab(-46, -42, 0, 6, -2, 26, M.wallB);
    this.slab(-38, -14, 0, 6, 10, 26, M.wallB);
    this.slab(-30, -14, 0, 6, 4, 10, M.wallB);
    this.slab(-42, -38, 0, 6, -2, 4, M.wallB);
    this.slab(-34, -14, 0, 6, -2, 4, M.wallB);
    // tunnel ceilings (dim, tight) + solid above
    this.slab(-42, -38, 2.5, 6, 10, 26, M.wallB);
    this.slab(-42, -30, 2.5, 6, 4, 10, M.wallB);
    this.slab(-38, -34, 2.5, 6, -2, 4, M.wallB);
    this.arch(-36, -2, 4, 'x', 0.5, 2.2, 2.5, M.wallBs);            // B-side tunnel exit

    // ---- mid west mass with B corridor cut (x[-14,-6]) --------------------
    this.slab(-14, -6, 0, 6, -26, -16, M.wallN);
    this.slab(-14, -6, 0, 6, -12, 26, M.wallN);
    this.slab(-14, -6, 2.6, 6, -16, -12, M.wallN);                  // corridor ceiling
    this.arch(-14, -14, 4, 'z', 0.5, 2.6, 3, M.wallBs);             // B-side mouth
    this.arch(-6, -14, 4, 'z', 0.5, 2.6, 3, M.wallNs);              // mid-side mouth

    // ---- B site room interior ---------------------------------------------
    const bPlat = this.slab(-44, -30, 0, 1.0, -22, -8, M.padPlatB, 'concrete');
    bPlat.userData.surface = 'concrete';
    this.slab(-30, -28.7, 0, 0.5, -18, -12, M.padPlatB);            // east step
    this.slab(-40, -34, 0, 0.5, -8, -6.7, M.padPlatB);              // south step
    this.siteMarker('B', '#7fb2d9', -37, 1.0, -15, 6.5);
    // props
    this.crate(-42.6, -20.5, 1.2, 1.0);
    this.crate(-41.3, -19.6, 1.2, 1.0, this.mats.crateDark);
    this.crate(-42.0, -20.0, 1.1, 2.2);                              // stacked
    this.crate(-32, -10.5, 1.2, 1.0);
    this.barrel(-16.2, -22.5);
    this.barrel(-17.3, -21.6, true);
    this.crate(-16.5, -5.2, 1.4, 0);
    this.sandbags(-27.4, -24.2, -4.6, -3.6, 1.0);                    // covers tunnel exit
    // pillars
    this.slab(-26.5, -25.5, 0, 6, -8.5, -7.5, M.wallBs);
    this.slab(-18.5, -17.5, 0, 6, -19.5, -18.5, M.wallBs);

    // ---- catwalk base + deck rails + stairs -------------------------------
    this.slab(6, 11, 0, 2.4, -26, 10, M.wallN);                      // solid base, deck top 2.4
    // west rail (overlooks mid) with drop gaps
    this.slab(6, 6.15, 2.4, 3.0, -26, -20, M.wood, 'wood');
    this.slab(6, 6.15, 2.4, 3.0, -16, -6, M.wood, 'wood');
    this.slab(6, 6.15, 2.4, 3.0, -2, 6, M.wood, 'wood');
    // east rail (over CT ramp area), gap z[-14,-10] = bridge
    this.slab(10.85, 11, 2.4, 3.0, -26, -14, M.wood, 'wood');
    this.slab(10.85, 11, 2.4, 3.0, -10, -8, M.wood, 'wood');
    // north rail (overlooks CT plaza)
    this.slab(6, 11, 2.4, 3.0, -26, -25.85, M.wood, 'wood');
    this.sandbags(6.6, 8.4, -25.2, -24.2, 0.7, 2.4);                 // deck cover (on top)
    // mid -> catwalk stairs (5 treads x 0.48 = 2.4, climbing north)
    this.stairs(6, 11, 10, 16, 5, 0.48, '-z', M.wallNs);
    // building south of stairs
    this.slab(6, 11, 0, 6, 16, 26, M.wallN);
    this.slab(11, 14, 0, 6, -8, 26, M.wallN);                        // courtyard west wall

    // ---- bridge (catwalk -> A platform, over CT ramp area) ----------------
    this.slab(11, 22, 2.1, 2.4, -14, -10, M.wood, 'wood');
    this.slab(11, 22, 2.4, 3.0, -14, -13.88, M.wood, 'wood');        // rails
    this.slab(11, 22, 2.4, 3.0, -10.12, -10, M.wood, 'wood');
    this.slab(13.8, 14.2, 0, 2.1, -13.6, -13.2, M.wood, 'wood');     // posts
    this.slab(13.8, 14.2, 0, 2.1, -10.8, -10.4, M.wood, 'wood');
    this.slab(18.8, 19.2, 0, 2.1, -13.6, -13.2, M.wood, 'wood');
    this.slab(18.8, 19.2, 0, 2.1, -10.8, -10.4, M.wood, 'wood');

    // ---- A platform + parapets + CT stairs --------------------------------
    this.slab(22, 42, 0, 2, -26, -8, M.padPlat, 'concrete');
    // north parapets (stair gap x[26,32])
    this.slab(22, 26, 2, 3.1, -26.2, -25.8, M.wallAs);
    this.slab(32, 42, 2, 3.1, -26.2, -25.8, M.wallAs);
    // partial west parapet (bridge lands z[-14,-10])
    this.slab(21.8, 22.2, 2, 2.9, -20, -14, M.wallAs);
    this.siteMarker('A', '#ffb050', 32, 2.0, -17, 7);
    // CT plaza -> A stairs (4 treads x 0.5, climbing south)
    this.stairs(26, 32, -30, -26, 4, 0.5, '+z', M.wallAs);
    // A site props: classic default boxes
    this.crate(31.6, -18.4, 1.3, 2.0);
    this.crate(32.9, -17.1, 1.3, 2.0, this.mats.crateDark);
    this.crate(32.2, -17.8, 1.2, 3.3);                               // double stack
    this.crate(25.5, -10.3, 1.1, 2.0);
    this.crate(38.6, -23.2, 1.5, 2.0);
    this.barrel(40.8, -10.0);
    this.sandbags(33.5, 36.5, -25.4, -24.4, 1.0, 2.0);               // on plat, facing site

    // ---- A ramp (long A -> platform) + east pocket ------------------------
    this.stairs(34, 42, -8, -2, 4, 0.5, '-z', M.wallAs);
    this.slab(42, 50, 0, 6, -26, -8, M.wallA);                       // east-of-plat mass
    // pocket x[42,50] z[-8,-2]: burnt-out car suggestion + barrels
    this.box(47.3, 0.55, -4.6, 3.4, 1.1, 1.7, M.metal, 'metal');
    this.box(47.3, 1.32, -4.7, 1.9, 0.55, 1.5, M.metalDoor, 'metal');
    this.barrel(42.6, -7.4, true);

    // ---- courtyard masses + short corridor to ramp ------------------------
    this.slab(14, 30, 0, 6, -8, 2, M.wallA);                         // big north mass
    this.slab(34, 38, 0, 6, -2, 2, M.wallA);                         // notch filler
    this.arch(32, 2, 4, 'x', 0.5, 3, 3.5, M.wallAs);                 // short corridor mouth
    // long A west wall with courtyard arch (z[6,12])
    this.slab(37.7, 38.3, 0, H, -2, 6, M.wallA);
    this.slab(37.7, 38.3, 0, H, 12, 26, M.wallA);
    this.arch(38, 9, 6, 'z', 0.6, 3.4, 4.7, M.wallAs);
    // courtyard props
    this.crate(16.3, 9.5, 1.4, 0);
    this.crate(17.7, 10.6, 1.2, 0);
    this.crate(17.0, 10.0, 1.1, 1.4);
    this.crate(29, 17, 1.3, 0);
    this.barrel(35.4, 4.2);

    // ---- long A props ------------------------------------------------------
    this.crate(47.8, 8, 1.5, 0);
    this.crate(47.6, 9.6, 1.3, 0);
    this.barrel(39.6, 16.5);
    this.barrel(40.6, 17.3, true);
    this.sandbags(43, 46, 20.6, 21.6, 1.0);

    // ---- CT ramp area (under bridge) props: climb crates to A -------------
    this.crate(20.6, -20.4, 0.9, 0);
    this.crate(20.7, -19.0, 0.9, 0.9);                               // 0.9 -> 1.8 -> plat 2.0
    this.barrel(12.6, -24.0);

    // ---- CT plaza props ----------------------------------------------------
    this.sandbags(-2.6, 2.6, -30.4, -29.4, 1.0);                     // facing mid doors
    this.crate(-24.5, -37.5, 1.4, 0);
    this.crate(-23.1, -37.2, 1.2, 0);
    this.crate(18, -37.6, 1.3, 0);
    this.crate(19.3, -36.9, 1.1, 0);
    this.box(30, 0.5, -37.8, 2.6, 1.0, 1.4, M.metal, 'metal');       // ammo cache

    // ---- T plaza props -----------------------------------------------------
    this.box(-12, 0.9, 36.8, 3.6, 1.8, 1.7, M.metal, 'metal');       // van-ish block
    this.crate(2, 36.5, 1.4, 0);
    this.crate(3.4, 36.2, 1.2, 0);
    this.crate(2.7, 36.4, 1.0, 1.4);
    this.barrel(-27, 28.5);
    this.barrel(-28, 29.3, true);
    this.crate(30.5, 36.8, 1.3, 0);

    // ---- mid props ---------------------------------------------------------
    this.crate(-4.4, 8, 1.3, 0);
    this.crate(3.8, -2, 1.2, 0);
    this.barrel(4.4, 17.5);
    this.barrel(-4.6, -18.7);

    // ---- tunnels props -----------------------------------------------------
    this.barrel(-40.6, 5.2);
    this.barrel(-31.4, 8.6, true);
    this.crate(-38.9, 18.5, 0.9, 0);

    // ---- cornice trims on a few masses (skyline detail, non-solid) --------
    this.deco(0, 5.08, -26, 12.6, 0.24, 1.0, M.trim);
    this.deco(-10, 6.1, 0, 8.4, 0.28, 52.4, M.trim);
    this.deco(8.5, 6.1, 21, 5.4, 0.28, 10.4, M.trim);
    this.deco(22, 6.1, -3, 16.4, 0.28, 10.4, M.trim);
    this.deco(-30, 6.1, 12, 32.4, 0.28, 28.4, M.trim);
    this.deco(46, 6.1, -17, 8.4, 0.28, 18.4, M.trim);

    // ---- spawns ------------------------------------------------------------
    const CT_YAW = Math.PI;  // facing +Z (south, toward mid)
    const T_YAW = 0;         // facing -Z (north)
    const ct = [
      [-14, -34], [-8, -36], [-2, -34], [4, -36], [10, -34], [15, -36],
    ];
    const t = [
      [-34, 33], [-22, 35], [-14, 31], [-2, 33], [8, 31], [24, 33],
    ];
    for (const [x, z] of ct) this.spawns.ct.push({ pos: new THREE.Vector3(x, 0.06, z), yaw: CT_YAW });
    for (const [x, z] of t) this.spawns.t.push({ pos: new THREE.Vector3(x, 0.06, z), yaw: T_YAW });

    // ---- bomb sites --------------------------------------------------------
    this.bombSites = [
      {
        name: 'A',
        center: new THREE.Vector3(32, 2, -17),
        box: new THREE.Box3(new THREE.Vector3(27, 1.8, -22), new THREE.Vector3(37, 4.6, -12)),
      },
      {
        name: 'B',
        center: new THREE.Vector3(-37, 1, -15),
        box: new THREE.Box3(new THREE.Vector3(-43, 0.8, -21), new THREE.Vector3(-31, 3.6, -9)),
      },
    ];
  }

  // =========================================================================
  // Waypoint graph (hand-authored, ~70 nodes covering every lane)
  // =========================================================================
  _buildWaypoints() {
    if (this.mapDefinition) {
      buildDefinitionNavigation(this, this.mapDefinition);
      return;
    }
    this._buildDustyardWaypoints();
  }

  _buildDustyardWaypoints() {
    const nodes = this.waypoints.nodes;
    const edges = this.waypoints.edges;
    const W = (x, y, z) => {
      const id = nodes.length;
      nodes.push({ id, pos: new THREE.Vector3(x, y, z) });
      return id;
    };
    const E = (a, b) => edges.push([a, b]);

    // T plaza (south)
    const T1 = W(-40, 0, 31), T2 = W(-30, 0, 34), T3 = W(-20, 0, 31);
    const T4 = W(-10, 0, 34), T5 = W(0, 0, 31), T6 = W(10, 0, 34);
    const T7 = W(20, 0, 31), T8 = W(30, 0, 31), T9 = W(44, 0, 29);
    E(T1, T2); E(T2, T3); E(T3, T4); E(T4, T5); E(T5, T6); E(T6, T7); E(T7, T8); E(T8, T9);
    E(T3, T5); E(T5, T7);

    // B tunnels (T -> B): seg1, chamber, seg2
    const U1 = W(-40, 0, 23), U2 = W(-40, 0, 15), U3 = W(-40, 0, 8);
    const U4 = W(-34, 0, 7), U5 = W(-36, 0, 1);
    E(T1, U1); E(U1, U2); E(U2, U3); E(U3, U4); E(U4, U5);

    // B site room (floor y0, platform y1)
    const B1 = W(-36, 0, -4), B2 = W(-24, 0, -6), B3 = W(-18, 0, -14);
    const B4 = W(-20, 0, -23), B5 = W(-42, 0, -24), BS = W(-27, 0, -15);
    const BP1 = W(-37, 1, -15), BP2 = W(-32, 1, -15), BP3 = W(-40, 1, -18), BP4 = W(-37, 1, -10);
    E(U5, B1); E(B1, B2); E(B2, B3); E(B3, B4); E(B4, B5);
    E(B2, BS); E(B3, BS); E(BS, BP2); E(B1, BP4);
    E(BP1, BP2); E(BP1, BP3); E(BP1, BP4); E(BP2, BP4);

    // Mid corridor to B
    const C1 = W(-10, 0, -14);
    E(B3, C1);

    // Mid lane
    const M1 = W(0, 0, 22), M2 = W(0, 0, 14), M3 = W(0, 0, 6);
    const M4 = W(0, 0, -4), M5 = W(0, 0, -14), M6 = W(0, 0, -21);
    const D1 = W(0, 0, -26); // between the double doors
    E(T5, M1); E(M1, M2); E(M2, M3); E(M3, M4); E(M4, M5); E(M5, M6); E(M6, D1);
    E(C1, M5);

    // Catwalk stairs + deck + bridge
    const S1 = W(3, 0, 18), S2 = W(8.5, 1.44, 13);
    const K1 = W(8.5, 2.4, 8), K2 = W(8.5, 2.4, 0), K3 = W(8.5, 2.4, -8);
    const K4 = W(8.5, 2.4, -13), K5 = W(8.5, 2.4, -23);
    const G1 = W(14, 2.4, -12), G2 = W(19, 2.4, -12);
    E(M1, S1); E(M2, S1); E(S1, S2); E(S2, K1);
    E(K1, K2); E(K2, K3); E(K3, K4); E(K4, K5); E(K4, G1); E(G1, G2);

    // A platform (edges route AROUND the central crate stack)
    const A1 = W(29, 2, -23), A2 = W(34.8, 2, -15), A3 = W(38, 2, -21);
    const A4 = W(38, 2, -11), A5 = W(24, 2, -12), A6 = W(25.5, 2, -20);
    E(G2, A5); E(A5, A2); E(A5, A6); E(A6, A1); E(A1, A3); E(A3, A2); E(A2, A4); E(A3, A4);

    // A ramp down to long + pocket (RF sits on the lowest tread)
    const R1 = W(38, 1, -5), RF = W(40, 0.5, -2.5), F1 = W(40, 0, 0), F2 = W(44, 0, -6);
    E(A4, R1); E(R1, F1); E(RF, F1); E(F1, F2);

    // Long A lane
    const L1 = W(44, 0, 2), L2 = W(44, 0, 10), L3 = W(44, 0, 18), L4 = W(44, 0, 24);
    E(F1, L1); E(L1, L2); E(L2, L3); E(L3, L4); E(L4, T9);

    // Courtyard (A short) + corridor to ramp
    const Q0 = W(20, 0, 24), Q1 = W(20, 0, 17), Q2 = W(20, 0, 8);
    const Q3 = W(28, 0, 13), Q4 = W(35, 0, 9), Q5a = W(32, 0, 3), Q5 = W(32, 0, -5);
    E(T7, Q0); E(Q0, Q1); E(Q1, Q2); E(Q1, Q3); E(Q2, Q4); E(Q3, Q4);
    E(Q3, Q5a); E(Q5a, Q5); E(Q5, RF); E(Q4, L2);

    // CT plaza
    const P1 = W(-20, 0, -30), P2 = W(-10, 0, -34), P3 = W(5, 0, -31);
    const P4 = W(8, 0, -34), P5 = W(16, 0, -29), P6 = W(24, 0, -34), P7 = W(29, 0, -31);
    E(P1, P2); E(P2, P3); E(P3, P4); E(P4, P5); E(P5, P6); E(P6, P7);
    E(D1, P3); E(B4, P1); E(P7, A1);

    // CT ramp / under-bridge pocket
    const R2 = W(16, 0, -20), R3 = W(16, 0, -11);
    E(P5, R2); E(R2, R3);

    // adjacency for A*
    const adj = nodes.map(() => []);
    for (const [a, b] of edges) {
      const cost = nodes[a].pos.distanceTo(nodes[b].pos);
      adj[a].push({ id: b, cost });
      adj[b].push({ id: a, cost });
    }
    this._adjacency = adj;

    // Tactical lane metadata reuses the validated nav nodes above. Attackers
    // receive one of these authored approaches before converging on the bomb
    // site; defenders receive a compact patrol area instead of sharing the
    // exact site-center anchor. This preserves objective play while ensuring
    // the whole team does not choose the same shortest A* path every round.
    const route = (name, ids) => ({
      name,
      points: ids.map((id) => nodes[id].pos.clone()),
    });
    const area = (name, sector, anchorId, ids) => ({
      name,
      sector,
      anchor: nodes[anchorId].pos.clone(),
      points: ids.map((id) => nodes[id].pos.clone()),
    });
    this.botTactics = {
      attackRoutes: {
        A: [
          route('long', [T9, L4, L2, F1, R1]),
          route('courtyard', [T7, Q0, Q3, Q5, RF]),
          route('catwalk', [M1, S2, K3, K4, G2]),
        ],
        B: [
          route('tunnels', [T1, U2, U4, U5, B1]),
          route('mid split', [M1, M3, M5, C1, B3]),
        ],
      },
      defenseAreas: [
        area('A platform', 'A', A2, [A1, A2, A3, A4, A5, A6]),
        area('B platform', 'B', BP1, [B1, B2, BS, BP1, BP2, BP3, BP4]),
        area('mid doors', 'mid', M6, [M4, M5, M6, D1, C1]),
        area('A long', 'A', F1, [R1, RF, F1, F2, L1, L2]),
        area('B tunnels', 'B', U5, [U3, U4, U5, B1, BP4]),
        area('catwalk', 'mid', K4, [K2, K3, K4, K5, G1, G2]),
      ],
    };
  }

  // Debug-only: raycast every edge at torso height and warn about blockers,
  // and warn if any node sits inside a collider.
  _validateNav() {
    const from = _v1;
    const to = _v2;
    const dir = _v3;
    let bad = 0;
    for (const [a, b] of this.waypoints.edges) {
      from.copy(this.waypoints.nodes[a].pos); from.y += 1.5;
      to.copy(this.waypoints.nodes[b].pos); to.y += 1.5;
      const dist = from.distanceTo(to);
      dir.subVectors(to, from).normalize();
      const hit = this.raycast(from, dir, dist - 0.3);
      if (hit) {
        bad++;
        console.warn(`[world] nav edge ${a}-${b} blocked at`, hit.point, hit.surface);
      }
    }
    for (const n of this.waypoints.nodes) {
      for (const c of this.colliders) {
        if (
          n.pos.x > c.min.x && n.pos.x < c.max.x &&
          n.pos.z > c.min.z && n.pos.z < c.max.z &&
          n.pos.y + 0.9 > c.min.y && n.pos.y + 0.9 < c.max.y
        ) {
          bad++;
          console.warn(`[world] nav node ${n.id} inside a collider`, n.pos);
        }
      }
    }
    if (!bad) console.warn('[world] nav graph validated: all edges clear');
  }

  // =========================================================================
  // Collision: axis-separated AABB capsule-as-box sweep with step-up.
  // Used by the player AND every bot each frame — allocation-free.
  // Returned object (and its .pos) are REUSED between calls: copy, don't keep.
  // =========================================================================
  resolveMovement(pos, delta, radius, height) {
    const res = this._moveResult;
    const p = res.pos.copy(pos);
    res.onGround = false;
    res.hitCeiling = false;

    const startedOnGround = this._probeGround(p.x, p.y, p.z, radius);
    // Step-up is allowed from the ground and also while rising in a jump —
    // that mantle assist is what makes 0.9 m crates climbable (apex + step).
    const canStep = startedOnGround || delta.y > 0;

    if (delta.x !== 0) this._moveAxis(p, delta.x, 0, radius, height, canStep);
    if (delta.z !== 0) this._moveAxis(p, delta.z, 2, radius, height, canStep);

    // vertical
    if (delta.y !== 0) {
      p.y += delta.y;
      const cols = this.colliders;
      const e = 0.001;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (
          c.min.x < p.x + radius - e && c.max.x > p.x - radius + e &&
          c.min.z < p.z + radius - e && c.max.z > p.z - radius + e &&
          c.min.y < p.y + height - e && c.max.y > p.y + e
        ) {
          if (delta.y <= 0) {
            p.y = c.max.y;
            res.onGround = true;
          } else {
            p.y = c.min.y - height - e;
            res.hitCeiling = true;
          }
        }
      }
      if (p.y < 0) { p.y = 0; res.onGround = true; } // absolute safety floor
    } else {
      res.onGround = this._probeGround(p.x, p.y, p.z, radius);
    }
    return res;
  }

  // Move along one horizontal axis (0 = x, 2 = z), clamping against colliders,
  // stepping up ledges <= STEP_HEIGHT when grounded or rising in a jump.
  _moveAxis(p, amount, axis, radius, height, canStep) {
    const step = this.game.config.PLAYER.STEP_HEIGHT;
    const e = 0.001;
    if (axis === 0) p.x += amount; else p.z += amount;
    const cols = this.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!(
        c.min.x < p.x + radius - e && c.max.x > p.x - radius + e &&
        c.min.z < p.z + radius - e && c.max.z > p.z - radius + e &&
        c.min.y < p.y + height - e && c.max.y > p.y + e
      )) continue;

      // try step-up onto a low ledge
      const rise = c.max.y - p.y;
      if (canStep && rise > e && rise <= step + e && this._clearAt(p.x, c.max.y + e, p.z, radius, height)) {
        p.y = c.max.y + e;
        continue;
      }

      // clamp against the blocking face
      if (axis === 0) {
        p.x = amount > 0 ? c.min.x - radius - e : c.max.x + radius + e;
      } else {
        p.z = amount > 0 ? c.min.z - radius - e : c.max.z + radius + e;
      }
    }
  }

  // Is a capsule-box at (x,y,z) free of all colliders?
  _clearAt(x, y, z, radius, height) {
    const e = 0.001;
    const cols = this.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (
        c.min.x < x + radius - e && c.max.x > x - radius + e &&
        c.min.z < z + radius - e && c.max.z > z - radius + e &&
        c.min.y < y + height - e && c.max.y > y + e
      ) return false;
    }
    return true;
  }

  // Is there support directly under the feet?
  _probeGround(x, y, z, radius) {
    if (y <= 0.002) return true; // base ground plane
    const e = 0.001;
    const cols = this.colliders;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (
        c.min.x < x + radius - e && c.max.x > x - radius + e &&
        c.min.z < z + radius - e && c.max.z > z - radius + e &&
        c.max.y <= y + 0.02 && c.max.y >= y - 0.08
      ) return true;
    }
    return false;
  }

  // =========================================================================
  // Raycast against world solids (one shared THREE.Raycaster).
  // =========================================================================
  raycast(origin, dir, maxDist) {
    const rc = this._raycaster;
    rc.ray.origin.copy(origin);
    rc.ray.direction.copy(dir).normalize();
    rc.near = 0;
    rc.far = maxDist;
    this._rayHits.length = 0;
    rc.intersectObjects(this.solids.children, false, this._rayHits);
    if (this._rayHits.length === 0) return null;
    const hit = this._rayHits[0];
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    return {
      point: hit.point,
      normal,
      distance: hit.distance,
      mesh: hit.object,
      surface: hit.object.userData.surface || 'concrete',
    };
  }

  // =========================================================================
  // Navigation queries
  // =========================================================================
  nearestWaypoint(pos) {
    const nodes = this.waypoints.nodes;
    let best = nodes[0];
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dx = n.pos.x - pos.x;
      const dy = (n.pos.y - pos.y) * 2; // prefer same floor level
      const dz = n.pos.z - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // A* over the waypoint graph. Returns node positions (clones) ending with `to`.
  findPath(from, to) {
    const a = this.nearestWaypoint(from).id;
    const b = this.nearestWaypoint(to).id;
    const nodes = this.waypoints.nodes;
    const key = a + ':' + b;
    let ids = this._pathCache.get(key);
    if (!ids) {
      ids = this._astar(a, b);
      this._pathCache.set(key, ids);
    }
    const out = [];
    for (let i = 0; i < ids.length; i++) out.push(nodes[ids[i]].pos.clone());
    out.push(to.clone());
    return out;
  }

  _astar(start, goal) {
    if (start === goal) return [start];
    const nodes = this.waypoints.nodes;
    const adj = this._adjacency;
    const n = nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goalPos = nodes[goal].pos;
    g[start] = 0;
    f[start] = nodes[start].pos.distanceTo(goalPos);
    const open = [start];
    while (open.length) {
      // extract min-f (graph is ~70 nodes: linear scan is fine)
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) {
        const path = [];
        for (let c = goal; c !== -1; c = came[c]) path.push(c);
        path.reverse();
        return path;
      }
      closed[cur] = 1;
      const nb = adj[cur];
      for (let i = 0; i < nb.length; i++) {
        const { id, cost } = nb[i];
        if (closed[id]) continue;
        const tent = g[cur] + cost;
        if (tent < g[id]) {
          g[id] = tent;
          f[id] = tent + nodes[id].pos.distanceTo(goalPos);
          came[id] = cur;
          if (open.indexOf(id) === -1) open.push(id);
        }
      }
    }
    return [start]; // disconnected (should not happen) — stay put
  }

  // Random reachable point near `pos` within radius r (for bot wander).
  randomPointNear(pos, r) {
    const nodes = this.waypoints.nodes;
    const cand = this._nearCache;
    cand.length = 0;
    const r2 = r * r;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const dx = n.pos.x - pos.x;
      const dy = n.pos.y - pos.y;
      const dz = n.pos.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) cand.push(n);
    }
    if (cand.length === 0) return this.nearestWaypoint(pos).pos.clone();
    return cand[(Math.random() * cand.length) | 0].pos.clone();
  }
}
