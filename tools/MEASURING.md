# How to measure this game's image, correctly

Every luminance number quoted in the graphics work came from this procedure. Read
it before you quote a number, because the obvious way to measure is wrong and it
is wrong in a direction that looks exactly like a real bug.

## The trap: a hidden tab has no lighting

`World.update(dt)` is what builds the indirect rig every frame:

| what it sets | value on Dustyard | value if it never runs |
|---|---|---|
| `world._bounce.intensity` (ground bounce fill) | 0.702 | **0** |
| `world._interior.intensity` (interior floor) | 0.603 | **0** |
| `scene.environmentIntensity` (the IBL diffuse budget) | 0.42 | **1.0** (three's default) |

`_buildLights()` only *creates* those lights, at intensity 0. They are given their
values in `update()`, retinted from the atmosphere, every frame.

`update()` is driven by `renderer.setAnimationLoop`, which is `requestAnimationFrame`.
**rAF does not tick in a tab that is not compositing** — a hidden browser pane, a
backgrounded window, a headless run. So a map loaded in a hidden pane sits there
with no bounce fill, no interior floor, and its image-based light at 2.4x its
intended budget. It renders fine when you ask it to render, so nothing errors and
nothing looks obviously broken — the frame is just unlit and flat.

Measured on Dustyard, mid lane, camera `(-2,1.7,20)` looking at `(-2,1.6,-10)`:

| | frame median / p90 | ground median / p90 |
|---|---|---|
| loop never ticked (the trap) | 36.3 / 141.8 | **19.4 / 30.4** |
| loop pumped to steady state | 50.3 / 142.9 | **39.6 / 49.0** |

That is a 2x error on the ground, and it reads as "the exposure is crushed". It
cost this project one wrong bug report and nearly cost it a second exposure
"fix" stacked on top of a correct one.

## The procedure

```js
const g = window.__game;
g.events.emit('ui:start', { mapId: '<map>' });   // then wait ~7 s for the builds

// 1. PUMP THE WORLD. Not optional. 120 steps is enough for the sky LUTs, the
//    bounce fill, the interior floor, the IBL budget and auto-exposure to settle.
for (let i = 0; i < 120; i++) g.world.update(1 / 60);

// 2. ASSERT THE RIG IS LIVE before you believe any number that comes next.
console.assert(g.world._bounce.intensity > 0, 'bounce fill is dead — pump the world');
console.assert(g.scene.environmentIntensity < 0.999, 'IBL is at three default — pump the world');

// 3. Freeze the sim so the frame is reproducible.
g.rounds.update = () => {}; g.bots.update = () => {}; g.player.update = () => {};
g.viewmodel.update = () => {}; g.viewmodel.rig.visible = false;
for (const b of g.bots.all) { b.alive = false; if (b.mesh) b.mesh.visible = false; }

// 4. Place the camera.
const cam = (x, y, z, tx, ty, tz) => {
  const c = g.camera; c.position.set(x, y, z); c.lookAt(tx, ty, tz); c.updateMatrixWorld();
};

// 5. Render THROUGH THE POST CHAIN and read back in the same synchronous turn.
//    `preserveDrawingBuffer` is false, so a canvas drawImage/toDataURL path
//    returns zeros; readPixels immediately after the render is the only way.
const r = g.renderer, gl = r.getContext();
const w = r.domElement.width, h = r.domElement.height;
function shot() {
  g.post.render(g.scene, g.camera);          // NOTE: (scene, camera) — no renderer arg
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;                                  // rows are BOTTOM-UP
}
const luma = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
```

## Other things that have produced false readings here

- **Toggling `ssaoUniforms.owSsaoP.value.z` to A/B the AO term does nothing.**
  `Ssao.render()` rewrites that uniform from `this.amount` on every frame, so the
  toggle is gone before the draw. Set `game.post.ssao.amount` instead, or set the
  uniform and render with `renderer.render()` directly, bypassing the chain.
- **Probing a projected world point does not check occlusion.** `Vector3.project`
  happily returns screen coordinates for a point behind a wall, so a "sunlit
  crate at luma 3.5" may be a foreground object. Raycast to confirm what the
  pixel actually shows before drawing a conclusion from it.
- **A 2 m grid of shadow-ray raycasts over a whole map will hang the tab.** The
  merged decor meshes carry a lot of triangles: ~1900 grid points x 2 rays x 770
  meshes wedged the renderer hard enough to need a reload. Measure sunlit
  coverage on the GPU instead — render top-down twice, once with the key light's
  intensity at 0, and difference the two.
- **Row-band statistics are not surface statistics.** "The bottom 30% of rows" is
  not "the ground"; it is whatever happens to be low in frame, which on most of
  these cameras includes props and shadowed verges. Quote it as a frame band, or
  raycast the surface you actually mean.
