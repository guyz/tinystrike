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
import { makeSiteMarkerTexture } from './textures.js';
import { DEFAULT_MAP_ID, mapById, normalizeMapId } from '../maps/catalog.js';
import { worldMapDefinition } from './maps/registry.js';
import { buildDefinitionGeometry, buildDefinitionNavigation } from './maps/runtime-builder.js';
import { createThemeMaterials } from './surfaces.js';
import { wrapUniforms } from '../gfx/materials/shader.js';
import { skyPresetFor } from './skies.js';
import { dressMap } from './dressing.js';
import { SkySystem } from '../gfx/sky/index.js';
import { Rng } from '../gfx/kit/rng.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * What stands on the horizon behind each arena. `height`/`width` are metres,
 * `count` is how many masses ring the map, and `mat` is the map material key
 * they are built from — the aerial-perspective fog does the rest of the work,
 * so these only ever read as a silhouette.
 */
const BACKDROPS = {
  desert: { count: 26, height: [6, 22], width: [10, 30], mat: 'wallN' },
  coastal: { count: 20, height: [8, 30], width: [12, 34], mat: 'wallB' },
  arctic: { count: 14, height: [10, 34], width: [16, 46], mat: 'wallB' },
  neon: { count: 24, height: [10, 38], width: [10, 28], mat: 'wallB' },
  citadel: { count: 16, height: [14, 46], width: [22, 60], mat: 'stoneDark' },
};

const WALL_H = 5; // default interior wall height

/**
 * Form factor of the warm bounce wrap: what fraction of a shaded surface's
 * hemisphere is filled by the sunlit surfaces around it. See `update()` for the
 * derivation and `src/gfx/materials/shader.js` for what consumes it. The ground
 * albedo is applied separately, so this is the geometry term alone.
 */
const WRAP_FORM = 0.5;

// scratch objects for hot paths (never allocate per frame)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _wrapTmp = new THREE.Vector3();

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
    this.solids = new THREE.Group();     // one mesh per authored box: the
    this.solids.name = `world-solids:${mapId}`;   // raycast + read-back layer
    this.solidBatch = null;              // and their merged render layer
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
    this._dress();
    this._buildBackdrop();
    // Last, so it sees the final material and shadow flags on every box —
    // `_buildDustyardMap` clears castShadow on the ground slab after box()
    // returns, and the dressing reads the per-box meshes back before this.
    this._batchSolids();

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

    // Library materials (and their baked texture sets) are shared across maps
    // and with the weapon models — the MaterialSystem owns their lifetime. Only
    // free what this map built for itself.
    if (this._ownedMaterials) for (const mat of this._ownedMaterials) materials.add(mat);
    const textures = new Set();
    for (const mat of materials) {
      if (mat.userData && mat.userData.owShared) continue;
      for (const value of Object.values(mat)) if (value && value.isTexture) textures.add(value);
      mat.dispose();
    }
    for (const texture of textures) texture.dispose();
    this._ownedMaterials = null;
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

    // Surfaces come from the procedural PBR library (src/gfx/materials): each
    // one is albedo + tangent normal + ORM baked on the GPU, projected in world
    // space and layered with detail, macro variation and weathering. The map
    // material KEYS are unchanged, so every layout table still resolves.
    const built = createThemeMaterials(this.game.materials, theme);
    this.mats = built.mats;
    this._decorMats = built.decor;
    this._ownedMaterials = built.owned;

    // The ground-splash weathering band (grime and dust climbing the first
    // half metre of every wall) keys off world Y.
    this.game.materials?.setGroundLevel?.(0);
  }

  // =========================================================================
  // Sky, fog, lights
  // =========================================================================
  // The sky is a physical atmosphere (src/gfx/sky) rather than a painted dome:
  // it owns the sun and moon, produces the IBL every surface is lit by, and
  // colours the fog. One instance is built on the first map load and retuned
  // per map — the LUT bakes and the PMREM are the expensive part, and they only
  // depend on the sun position, not on which arena is loaded.
  _buildSky() {
    const scene = this.game.scene;
    const preset = skyPresetFor(this.theme);
    // Headless (the Node map tests build a World with no renderer): the layout,
    // collision and navigation are all that exist to check there.
    if (!this.game.renderer) return;

    if (!this.sky) {
      this.sky = new SkySystem({
        renderer: this.game.renderer,
        scene,
        camera: this.game.camera,
        events: this.game.events,
        quality: this.game.gfxQuality || 'high',
        exposure: this.game.renderer.toneMappingExposure,
        debug: this.game.debug,
        site: preset.site,
        hour: preset.hour,
        weather: preset.weather,
        groundAlbedo: preset.groundAlbedo,
      });
    } else {
      this.sky.celestial.site = { ...this.sky.celestial.site, ...preset.site };
      this.sky.shared.uGroundAlbedo.value.fromArray(preset.groundAlbedo);
      this.sky.setWeather(preset.weather);
      this.sky.setTimeOfDay(preset.hour);
    }

    // Aerial perspective. The colour comes from the atmosphere that just baked,
    // so a distant wall dissolves into the sky it is standing against instead
    // of into a hand-picked hex that only matched at one time of day.
    const f = preset.fog;
    this.sky.applyFogTo(scene, f.near, f.far, f.gain, f.tint, f.tintAmount);
  }

  /**
   * The world beyond the arena.
   *
   * The playable space ends at the map bounds, and past that the sky's own
   * below-horizon ground term takes over — which from any elevated position
   * reads as a flat grey sea lapping at the perimeter wall. A map has to sit in
   * a PLACE, and the cheapest honest way to say so is the two things you would
   * actually see over a 9 m wall: the ground continuing to the horizon, and a
   * silhouette of whatever the district is made of standing behind it.
   *
   * All of it is non-colliding, casts no shadow, and is one merged mesh per
   * material — about 3 draw calls and 2k triangles for the whole horizon.
   */
  _buildBackdrop() {
    if (!this.game.renderer) return;
    const bounds = this.mapDefinition
      ? this.mapDefinition.bounds
      : { x0: -52, x1: 52, z0: -42, z1: 42 };
    const inner = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) * 0.62;
    const preset = BACKDROPS[this.theme.key] ?? BACKDROPS.desert;
    const rng = new Rng(`backdrop:${this.mapId}`);

    // ---- the ground, continuing out to the horizon -------------------------
    // A ring rather than a disc: the arena's own floor already covers the
    // middle, and overlapping two coplanar surfaces is how you get z-fighting.
    //
    // The ring's INNER radius is not `inner`. `inner` is the silhouette's
    // stand-off, derived from the LONGER side, so on Citadel it is 62 m — a
    // circle of radius 62 drawn around a 100 x 84 m floor, which leaves an
    // annular void 10 m wide on the X axis and 18 m wide on the Z axis. Seven
    // straight-down raycasts at (54,0), (57,0), (60,0), (0,46), (0,50), (0,55)
    // and (0,60) returned no hit at all, and from any raised camera the gap
    // showed the fog and sky dome through the floor as a pale ring around the
    // fort. The ring has to start where the floor still IS, which is the
    // INSCRIBED radius — the shortest distance from the origin to a floor edge
    // — less 3 m so it starts under the floor rather than at its lip. The two
    // surfaces are 6 cm apart in Y, so overlapping them cannot z-fight.
    const reach = Math.min(-bounds.x0, bounds.x1, -bounds.z0, bounds.z1);
    const skirt = new THREE.RingGeometry(Math.max(4, reach - 3), 900, 64, 1);
    skirt.rotateX(-Math.PI / 2);
    const skirtMesh = new THREE.Mesh(skirt, this.mats.ground);
    skirtMesh.position.y = -0.06;
    skirtMesh.receiveShadow = false;
    skirtMesh.castShadow = false;
    skirtMesh.name = 'backdrop-ground';
    this.environment.add(skirtMesh);

    // ---- the silhouette ----------------------------------------------------
    const parts = [];
    const box = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();
    for (let i = 0; i < preset.count; i++) {
      const a = (i / preset.count) * Math.PI * 2 + rng.range(-0.05, 0.05);
      const r = inner * rng.range(1.35, 2.6);
      const h = rng.range(preset.height[0], preset.height[1]);
      const w = rng.range(preset.width[0], preset.width[1]);
      const dpt = rng.range(preset.width[0], preset.width[1]);
      // Sunk half a metre so no gap shows between block and ground at distance.
      m.compose(
        new THREE.Vector3(Math.sin(a) * r, h / 2 - 0.5, Math.cos(a) * r),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI)),
        new THREE.Vector3(w, h, dpt)
      );
      const g = box.clone();
      g.applyMatrix4(m);
      parts.push(g);
      // A stepped-back upper mass on some of them, so the skyline is not a
      // row of identical slabs.
      if (rng.bool(0.45)) {
        const h2 = h * rng.range(0.25, 0.6);
        m.compose(
          new THREE.Vector3(Math.sin(a) * r, h + h2 / 2 - 0.5, Math.cos(a) * r),
          new THREE.Quaternion(),
          new THREE.Vector3(w * rng.range(0.4, 0.7), h2, dpt * rng.range(0.4, 0.7))
        );
        const g2 = box.clone();
        g2.applyMatrix4(m);
        parts.push(g2);
      }
    }
    box.dispose();
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, this.mats[preset.mat] || this.mats.wallB);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = 'backdrop-silhouette';
      this.environment.add(mesh);
    }
  }

  _buildLights() {
    if (!this.game.renderer) return;

    // Bounce fill.
    //
    // The IBL carries the sky, but nothing carries the light the GROUND throws
    // back up — and on a sand map at 20 degrees of elevation that is most of
    // what fills a shaded wall. Without it the sun/shadow ratio is about six
    // stops and everything out of the key reads as a black hole. This is that
    // missing bounce as one hemisphere light: sky colour above, ground albedo
    // times the beam below, retinted every frame from the atmosphere.
    if (!this._bounce) {
      this._bounce = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
      this._bounce.name = 'bounce-fill';
      this.game.scene.add(this._bounce);

      /**
       * Interior floor.
       *
       * The IBL and the hemisphere bounce are both SKY terms, and the maps have
       * roofed tunnels, a covered customs hall and the B-site room where a
       * player can stand with no line to the sky at all. Physically those
       * should be near black, and with the old flat ambient gone they were:
       * measured under 3% of the sunlit value, which is not a lighting mood, it
       * is an unplayable room.
       *
       * This is the small constant term that keeps them readable — about 5% of
       * the key light, tinted with the sky so it never reads as a grey wash.
       * It is the one deliberately non-physical light in the scene.
       */
      this._interior = new THREE.AmbientLight(0xffffff, 0);
      this._interior.name = 'interior-floor';
      this.game.scene.add(this._interior);
    }
    this._bounceAlbedo = new THREE.Color().fromArray(skyPresetFor(this.theme).groundAlbedo);

    // Sun, moon and the whole-sky fill now come from the atmosphere. What is
    // left here are the map's own practicals: the point lights that make an
    // interior readable when the key light cannot reach it.
    if (this.mapDefinition) return;
    const tun = new THREE.PointLight(0xffb066, 16, 14, 1.8);
    tun.position.set(-36, 2.1, 7);
    this.environment.add(tun);
    const bRoom = new THREE.PointLight(0xffc788, 14, 16, 1.8);
    bRoom.position.set(-30, 3.2, -14);
    this.environment.add(bRoom);
    const corr = new THREE.PointLight(0xffb066, 11, 10, 1.8);
    corr.position.set(-10, 2.2, -14);
    this.environment.add(corr);
  }

  /** The key light, for anything that wants to know where the sun is. */
  get sun() {
    return this.sky ? this.sky.keyLight : null;
  }

  update(dt) {
    if (!this.sky) return;
    this.sky.update(dt);

    // Retint the bounce fill from the light the sky is actually making. The
    // upper half is the sky's own colour; the lower half is that colour
    // reflected off this map's ground albedo, warmed by the beam. `indirectScale`
    // is the atmosphere's own view of how much indirect light this elevation
    // should get — it comes down at golden hour, when a hemispherical average
    // over-reports what a vertical surface can actually see, and goes up after
    // dark, when it is the only fill there is.
    const sky = this.sky;
    const fill = this._bounce;
    const amb = sky.ambientColor;

    /**
     * Key:fill, and it is the single number the whole image hangs on.
     *
     * MEASURED on the previous constants: dustyard came out at 2.4:1 on the
     * ground and 2.9:1 on a vertical wall — 1.3 to 1.5 stops — and Frostline
     * was WORSE THAN UNITY (0.41:1), meaning the sun contributed 29% of the
     * light falling on the snow and a geometrically perfect shadow could only
     * take a quarter of it away. That is why the arctic map had no ground
     * shadows at all and every facade read as one flat mid-grey.
     *
     * Three compounding errors, all here:
     *   1. the hue was normalised by the MEAN of rgb, not the max, so a blue
     *      sky ambient came back with its blue channel at 1.56 — 56% more
     *      energy than a hue-only normalisation, and bluer with it;
     *   2. the 4.2 multiplier was about 2.5x the reference engine's entire
     *      indirect budget;
     *   3. the PMREM was underneath it at FULL strength, so the sky was paid
     *      for twice — once as image-based light, once as this hemisphere.
     *
     * Max-normalising fixes the hue, 1.7 brings the level onto the reference's
     * budget, and `scene.environmentIntensity` below is the other half.
     */
    const peak = Math.max(amb.r, amb.g, amb.b);
    const level = (amb.r + amb.g + amb.b) / 3;
    fill.color.copy(amb).multiplyScalar(1 / Math.max(peak, 1e-4));
    fill.groundColor.copy(this._bounceAlbedo).multiply(sky.keyLight.color).multiplyScalar(3);
    fill.intensity = Math.min(1.2, level * 1.7 * sky.indirectScale);

    /**
     * The IBL's diffuse budget.
     *
     * three has no global scalar for image-based diffuse — `envMapIntensity` on
     * a material is overwritten by `scene.environmentIntensity` for anything lit
     * by `scene.environment` alone (WebGLRenderer.setProgram, the
     * MeshStandardMaterial branch), so THIS is the knob. The reference engine
     * runs its IBL diffuse at ~0.03-0.05 of the beam; at 1.0 the sky was
     * lighting the shade about as hard as the sun was lighting the light.
     */
    this.game.scene.environmentIntensity = 0.42;

    /**
     * The warm bounce wrap — the producer half of `wrapUniforms`.
     *
     * The consumer, and the whole argument for why this cannot be another light,
     * is in `src/gfx/materials/shader.js`. In one line: a HemisphereLight is two
     * colours lerped by `normal.y`, so its warm half only reaches down-facing
     * surfaces, and a patch of dirt standing in a shadow is up-facing. It sees
     * blue sky and blue IBL, and warm dirt under blue light measures neutral.
     *
     * DIRECTION: horizontal, pointing away from the sun. The surfaces doing the
     * bouncing sit around the horizon on the far side from the beam.
     *
     * MAGNITUDE, from the physics rather than from taste. A sunlit surface of
     * albedo `a` under irradiance `E` leaves radiance `aE/pi`; a surface across a
     * street subtends a form factor of roughly 0.2-0.35 of that hemisphere, so
     * the wrap starts at about `0.25 * a * E`. `a` is this map's own ground
     * albedo, which is already the grey card the exposure is metered against, so
     * it is carried by `_bounceAlbedo` and WRAP_FORM is the form factor alone.
     * `indirectScale` rides along for the same reason the bounce fill does: at
     * golden hour there is less indirect light to go round.
     *
     * MEASURED, top-down probes on one frame at a pinned exposure of 0.8508,
     * shaded dirt at (0,0), R-B / luma, against sunlit dirt at +49.2 / 122.8:
     *
     *   form  0.00   -4.7 / 58.3    lane p90 139.6   closed tunnel p50 36.2
     *   form  0.25   +1.0 / 62.5    lane p90 139.6   closed tunnel p50 38.5
     *   form  0.50   +6.6 / 66.6    lane p90 139.6   closed tunnel p50 40.7
     *   form  0.75  +11.5 / 70.4    lane p90 139.7   closed tunnel p50 43.0
     *   form  1.00  +16.4 / 74.1    lane p90 140.9   closed tunnel p50 45.2
     *
     * 0.50 is where the shaded ground stops measuring COLDER than neutral and
     * starts reading as sun-baked dirt, while the shadow is still 1.84 stops
     * under the sunlit ground it neighbours (it was 2.07 before), the frame p90
     * has not moved at all, and the closed tunnel is up 12%, inside what the
     * interior floor light exists to provide. Above 0.75 the frame p90 starts to
     * move, which is the point at which a fill has stopped being a fill. The
     * derivation puts a single facade across a street at 0.2-0.35; a patch of
     * shaded ground in an open desert map is ringed by sunlit sand on nearly
     * every azimuth rather than facing one wall, so the top of that band and a
     * little beyond is the honest place for it.
     */
    const wrapDir = this._wrapDir || (this._wrapDir = new THREE.Vector3());
    const key = sky.keyLight;
    key.target.getWorldPosition(wrapDir);
    wrapDir.sub(key.getWorldPosition(_wrapTmp));   // target - light = away from the sun
    wrapDir.y = 0;
    if (wrapDir.lengthSq() < 1e-8) wrapDir.set(0, 0, 1);
    wrapDir.normalize();
    wrapUniforms.owWrapDir.value.copy(wrapDir);
    wrapUniforms.owWrapCol.value
      .copy(key.color)
      .multiply(this._bounceAlbedo)
      .multiplyScalar(key.intensity * WRAP_FORM * sky.indirectScale);

    const interior = this._interior;
    interior.color.copy(amb).multiplyScalar(1 / Math.max(level, 1e-4));
    // Keyed off the beam, not off the sky: at night the practicals and the neon
    // are meant to be the only light, so this all but disappears.
    // Measured: at 0.055 of the key a roofed room sat 4 stops under the street,
    // which is realistic and unplayable — a crouching defender was invisible.
    // 0.14 puts it about 2.7 stops under, which reads as "indoors" and still
    // lets you find a body in the corner of the B room.
    interior.intensity = Math.min(1.1, 0.14 * Math.max(sky.sunLight.intensity, 0.6));
  }

  /**
   * The vertex-mask variant of a map material, for set dressing. Detail
   * geometry paints wear/grime/AO into vertex colours; the map's own boxes
   * share one unit geometry and cannot.
   */
  decorMaterial(key) {
    return this._decorMats[key] || this._decorMats.wallN;
  }

  // Detail geometry, derived from the collision boxes and added as non-solid
  // meshes. Gameplay is identical with it off — see src/world/dressing.js.
  _dress() {
    if (!this.game.renderer) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const result = dressMap(this, { quality: this.game.gfxQuality || 'high' });
    if (this.game.debug && t0) {
      console.info(
        `[world] ${this.mapId} dressing: ${(result.tris / 1000).toFixed(1)}k tris, ` +
          `${result.props} props in ${(performance.now() - t0).toFixed(0)}ms`
      );
    }
  }

  // =========================================================================
  // Render batching
  // =========================================================================

  /**
   * Draw the map's boxes as one merged mesh per material instead of one each.
   *
   * MEASURED, dustyard, aerial camera with the whole arena in frame
   * (`r.info.autoReset = false; r.info.reset(); r.render(scene, camera)`):
   * `world-solids` was 165 drawn meshes for 2 484 triangles — one draw call per
   * box for an average of 15 triangles. The game is draw-call bound, not fill
   * bound (frame time was flat from 0.33 MP to 3.69 MP, 7.14 ms -> 8.05 ms for
   * 11x the pixels, while the whole CPU update path costs 0.27 ms), so 165
   * calls carrying 2 484 triangles is the single most wasteful thing in the
   * frame. Every one of these boxes is static and they share about ten
   * materials, so they can be one mesh per material and nothing about the image
   * changes.
   *
   * ---------------------------------------------------------------------------
   * WHY THE PER-BOX MESHES STAY, HIDDEN, RATHER THAN BEING REPLACED
   *
   * `this.solids.children` is not just a render list. It is:
   *
   *   1. the raycast target set. `World.raycast` is what combat, bot line of
   *      sight, grenade bounces, footstep surfaces, impact decals and audio
   *      occlusion all ask, and it needs the surface KIND at the hit, which
   *      lives in each box's own `userData.surface`.
   *   2. a read-back table indexed in lockstep with `colliders`.
   *      `src/world/dressing.js` walks `solids.children[i]`, reads its
   *      `geometry`, `position`, `scale` and `userData.surface`, and uses `i`
   *      to find that box's own collider. Every prop, coping, kerb, stain and
   *      snow cap in all five maps is placed off that walk.
   *
   * So the boxes are kept, at the same indices, and only made invisible. That
   * is exactly free: `WebGLRenderer.projectObject` and
   * `WebGLShadowMap.renderObject` both `return` on `object.visible === false`,
   * so a hidden box costs no draw call in the main pass or the shadow pass,
   * while `Raycaster`'s `intersect()` never looks at `visible` at all — so
   * every ray in the game answers from the same objects, in the same order,
   * through the same code path it used before. Equivalence is structural, not
   * argued.
   *
   * The only thing this costs is the merged copy of the geometry, MEASURED at
   * 158.6 KB on Dustyard (4 616 vertices, 2 448 triangles) and 35-58 KB on the
   * other four. The per-box meshes were already there.
   *
   * The alternative — delete the meshes and answer `raycast` with box maths
   * over `colliders` — cannot work here, and not only because of (2):
   * `barrel()` and `column()` give a CYLINDER mesh a square box collider on
   * purpose. Ray-testing the collider list would make every barrel and pylon
   * in the game behave like a crate, so bullets, sightlines and decals would
   * land on air at its corners.
   *
   * ---------------------------------------------------------------------------
   * WHAT SPLITS A BATCH
   *
   * Material, then `castShadow`, then `receiveShadow`. The shadow split is what
   * preserves `box()`'s caster exclusion: the ground slab is 104 x 84 m and the
   * floor pads up to 80 m across, and they are receive-only because as casters
   * they shadow nothing and fill the cascade with a huge coplanar surface that
   * self-shadows into acne. Merge them into a casting batch and that acne comes
   * straight back, so the flag is part of the bucket key rather than something
   * recomputed here.
   */
  _batchSolids() {
    // Snapshot: the batch group is appended to `solids` at the end.
    const sources = this.solids.children.slice();
    // The parts are baked from `matrixWorld`, and loadMap only updates the
    // group after this runs.
    this.solids.updateMatrixWorld(true);

    const buckets = new Map();
    for (const mesh of sources) {
      // Already-hidden boxes stay hidden; a multi-material box would need
      // geometry groups to merge and no map builds one.
      if (!mesh.isMesh || !mesh.visible) continue;
      const mat = mesh.material;
      if (!mat || Array.isArray(mat)) continue;
      const key = `${mat.id}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          mat,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          meshes: [],
        };
        buckets.set(key, bucket);
      }
      bucket.meshes.push(mesh);
    }

    const group = new THREE.Group();
    group.name = `world-solids-batch:${this.mapId}`;
    for (const bucket of buckets.values()) {
      // A bucket of one is already one draw call: merging it would spend a
      // geometry copy to save nothing.
      if (bucket.meshes.length < 2) continue;
      const parts = bucket.meshes.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld));
      const merged = mergeGeometries(parts, false);
      for (const part of parts) part.dispose();
      // mergeGeometries returns null when the parts disagree on attributes.
      // Leave that bucket drawing per box rather than dropping it from the
      // image.
      if (!merged) continue;
      const batch = new THREE.Mesh(merged, bucket.mat);
      batch.castShadow = bucket.castShadow;
      batch.receiveShadow = bucket.receiveShadow;
      batch.name = `solids-batch:${bucket.mat.id}${bucket.castShadow ? '' : ':nocast'}`;
      batch.userData.owBatched = bucket.meshes.length;
      group.add(batch);
      for (const mesh of bucket.meshes) mesh.visible = false;
    }

    if (!group.children.length) return;
    // Appended LAST so `solids.children[i]` still lines up with `colliders[i]`
    // for every authored box. It is a Group, so the dressing's read-back passes
    // skip it on `isMesh`, and `raycast` walks `solids.children` with
    // `recursive = false`, so it never descends into it either.
    this.solids.add(group);
    this.solidBatch = group;

    // The batch adds no new volume — it is the same boxes — so the sky's
    // `_measureArena` (which traverses the scene ignoring `visible`, and still
    // sees every per-box mesh with its shadow flags untouched) fits the same
    // ortho box it did before.
    if (this.game.debug) {
      const boxes = group.children.reduce((n, m) => n + m.userData.owBatched, 0);
      console.info(
        `[world] ${this.mapId} solids: ${boxes} boxes -> ${group.children.length} draw calls ` +
          `(${sources.length - boxes} left unbatched)`
      );
    }
  }

  // =========================================================================
  // Geometry helpers
  // =========================================================================

  // Solid box by center + size. Adds mesh (into solids) + collider.
  box(x, y, z, w, h, d, material, surface = 'concrete') {
    const mesh = new THREE.Mesh(this._unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    /**
     * A floor casts nothing.
     *
     * The ground slab is 104 x 84 m and the floor pads are up to 80 m across:
     * as shadow casters they contribute nothing (there is nothing under them)
     * while filling the cascade with a huge coplanar surface that self-shadows
     * into acne. Anything broad and flat is receive-only; a 2 m bomb-site
     * platform is still tall enough to count as geometry and keeps casting.
     */
    mesh.castShadow = !(h <= 1.5 && w >= 8 && d >= 8);
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

  /**
   * Extra wear and a feathered edge on a site-marker canvas, applied here rather
   * than in the bake so the shared texture helper keeps its crisp stencil.
   *
   * Two passes, both `destination-out` so they only ever remove paint:
   *   - a feather ring, so the decal fades into the floor instead of ending on a
   *     hard 256-pixel-wide rectangle edge that reads as a sticker;
   *   - scuff arcs along the walking lines, the way a real painted marker wears
   *     where boots cross it.
   */
  _weatherSiteMarker(tex, seed) {
    const c = tex.image;
    if (!c || !c.getContext) return tex;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const rnd = new Rng(seed);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';

    // Feathered edge: it only bites in the last ~15% of the radius, so the plate
    // and its border ring keep their body and the corners dissolve into the
    // floor instead of ending on a hard 256-pixel rectangle edge. Pushed out from
    // a first pass at 0.36-0.52, which read softer but ate most of the border
    // ring — this is gameplay signage before it is set dressing.
    const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.47, W / 2, H / 2, W * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Scuffs: long shallow arcs, brightest across the middle where feet land.
    ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const a = rnd.range(0, Math.PI * 2);
      const r = W * rnd.range(0.16, 0.44);
      const cx = W / 2 + Math.cos(a) * r * 0.5;
      const cy = H / 2 + Math.sin(a) * r * 0.5;
      ctx.globalAlpha = rnd.range(0.12, 0.45);
      ctx.lineWidth = rnd.range(2, 9);
      ctx.beginPath();
      ctx.arc(cx, cy, rnd.range(10, 46), a, a + rnd.range(0.7, 2.2));
      ctx.stroke();
    }
    ctx.restore();
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Painted floor site marker decal (non-solid).
   *
   * This is PAINT, so it is a lit material. It used to be `MeshBasicMaterial`,
   * which does not respond to light at all: measured top-down at B centre it read
   * luma 172.5 with the sun on and 171.2 with it off — a sun contribution of 1.3
   * where the concrete it is painted on 4 m away contributed 70.8 — and at 172.5
   * it was the brightest surface on the map, above even sunlit sand at 153.0. It
   * read as a UI overlay lying on the world rather than paint on the ground.
   *
   * A `MeshStandardMaterial` puts it back under the same sun, the same sky and
   * the same cast shadow as its own substrate. It stays legible from across the
   * map because paint is genuinely brighter than sand — the plate keeps its dark
   * worn backing and a near-white pigment, so it holds roughly a 2:1 albedo step
   * over the floor in EVERY lighting condition instead of being pinned bright in
   * one and wrong in all the others. This is gameplay-critical signage; the
   * contrast is carried by albedo, which shadow cannot take away.
   */
  siteMarker(letter, color, x, y, z, size) {
    const tex = this._weatherSiteMarker(makeSiteMarkerTexture({ letter, color }), 'site|' + letter);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({
        map: tex, transparent: true, depthWrite: false,
        roughness: 0.86, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.02, z);
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
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
    // Building south of stairs. A 0.4 m visual seam leaves enough capsule
    // clearance for separation steering at the lowest tread without opening a
    // new walkable route between the stair and building.
    this.slab(6, 11, 0, 6, 16.4, 26, M.wallN);
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
    const W = (x, y, z, key = null) => {
      const id = nodes.length;
      nodes.push({ id, key, pos: new THREE.Vector3(x, y, z) });
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
    const S1 = W(3, 0, 18, 'S1'), S2 = W(8.5, 1.44, 13, 'S2');
    // Approach the catwalk stairs beside their lowest tread, step onto it
    // laterally, then climb north. The former diagonal S1 -> S2 met the west
    // face at the 1.44 m tread, where separation steering could pin a bot.
    const S1StairWest = W(5.2, 0, 15.4, 'S1_STAIR_WEST');
    const S1StairEntry = W(8.5, 0.48, 15.4, 'S1_STAIR_ENTRY');
    const K1 = W(8.5, 2.4, 8), K2 = W(8.5, 2.4, 0), K3 = W(8.5, 2.4, -8);
    const K4 = W(8.5, 2.4, -13), K5 = W(8.5, 2.4, -23);
    const G1 = W(14, 2.4, -12), G2 = W(19, 2.4, -12);
    E(M1, S1); E(M2, S1); E(S1, S1StairWest); E(S1StairWest, S1StairEntry); E(S1StairEntry, S2); E(S2, K1);
    E(K1, K2); E(K2, K3); E(K3, K4); E(K4, K5); E(K4, G1); E(G1, G2);

    // A platform (edges route AROUND the central crate stack)
    const A1 = W(29, 2, -23), A2 = W(34.8, 2, -15), A3 = W(38, 2, -21);
    const A4 = W(38, 2, -11), A5 = W(24, 2, -12), A6 = W(25.5, 2, -20);
    E(G2, A5); E(A5, A2); E(A5, A6); E(A6, A1); E(A1, A3); E(A3, A2); E(A2, A4); E(A3, A4);

    // A ramp down to long + pocket (RF sits on the lowest tread)
    // R1 sits on the second ramp tread. Keep its center far enough from the
    // taller tread that a full-size bot resolves to the authored 1 m floor.
    const R1 = W(38, 1, -4.3), RF = W(40, 0.5, -2.75, 'RF'), F1 = W(40, 0, 0), F2 = W(44, 0, -6);
    E(A4, R1); E(R1, F1); E(RF, F1); E(F1, F2);

    // Long A lane
    const L1 = W(44, 0, 2), L2 = W(44, 0, 10), L3 = W(44, 0, 18), L4 = W(44, 0, 24);
    // The long-lane sandbags span x[43,46], z[20.6,21.6]. Route around their
    // west end instead of sending the nav edge through the cover collider.
    const LX1 = W(42, 0, 19.5), LX2 = W(42, 0, 22.7);
    E(F1, L1); E(L1, L2); E(L2, L3); E(L3, LX1); E(LX1, LX2); E(LX2, L4); E(L4, T9);

    // Courtyard (A short) + corridor to ramp
    const Q0 = W(20, 0, 24), Q1 = W(20, 0, 17), Q2 = W(20, 0, 8);
    const Q3 = W(28, 0, 13), Q4 = W(35, 0, 9), Q5a = W(32, 0, 3), Q5 = W(32, 0, -5, 'Q5');
    // Enter the A ramp beside its lowest tread. The old diagonal Q5 -> RF
    // relied on collision sliding along the west stair face; teammate
    // separation could push the capsule into the taller tread and strand it.
    const Q5RampSouth = W(32, 0, -2.75, 'Q5_RAMP_SOUTH');
    const Q5RampEntry = W(33.2, 0, -2.75, 'Q5_RAMP_ENTRY');
    E(T7, Q0); E(Q0, Q1); E(Q1, Q2); E(Q1, Q3); E(Q2, Q4); E(Q3, Q4);
    E(Q3, Q5a); E(Q5a, Q5); E(Q5, Q5RampSouth); E(Q5RampSouth, Q5RampEntry); E(Q5RampEntry, RF); E(Q4, L2);

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
  //
  // The targets are the per-box meshes, and they answer whether or not they are
  // drawn: `_batchSolids` hides them behind a merged copy, and three's
  // `Raycaster` never looks at `visible`. The batch group is `solids.children`'s
  // last entry, and `recursive = false` below plus `Object3D.raycast` being a
  // no-op is why the merged copy is not a second, surface-less hit.
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
