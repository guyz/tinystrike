// Per-material AABB for every weapon, in mm, WITH the rest transform of each
// moving part applied.
//
// This is not a nicety. `measure-weapons.mjs` and the review that came out of
// it read the magazine, slide and bolt buckets in their own local space, which
// is where a magazine's AABB starts at the feed lips (y = +8) and runs down to
// the floorplate (y = -122) — so it "hangs 30 mm below" a grip it is in fact
// seated 30 mm INSIDE. Every moving part has to be pushed through
// `model.nodes.<part>Rest` / `magSeat` before its numbers mean anything.
import * as THREE from 'three';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';
import { triCount } from '../src/gfx/weapons/geometry.js';

const SEAT = { magazine: 'magSeat', charging: 'chargeRest', bolt: 'boltRest', slide: 'slideRest', trigger: 'triggerPivot', selector: 'selectorPivot' };

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const id of PROCEDURAL_WEAPON_IDS) {
  if (only.length && !only.includes(id)) continue;
  const model = buildWeaponModel(id);
  console.log(`\n=== ${id} ===`);
  const asms = [['body', model.body], ...Object.entries(model.moving ?? {})];
  let total = 0;
  const whole = new THREE.Box3();
  for (const [part, asm] of asms) {
    const node = model.nodes[SEAT[part]];
    const m = new THREE.Matrix4();
    if (node) {
      m.compose(
        new THREE.Vector3().fromArray(node.pos),
        new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(node.rot ?? [0, 0, 0])),
        new THREE.Vector3(1, 1, 1)
      );
    }
    const map = asm.build();
    for (const [mat, geo] of map) {
      geo.applyMatrix4(m);
      geo.computeBoundingBox();
      const b = geo.boundingBox;
      whole.union(b);
      const f = (v) => (v * 1000).toFixed(0).padStart(5);
      const t = triCount(geo);
      total += t;
      console.log(
        `  ${part.padEnd(9)}${mat.padEnd(13)}x[${f(b.min.x)},${f(b.max.x)}] ` +
          `y[${f(b.min.y)},${f(b.max.y)}] z[${f(b.min.z)},${f(b.max.z)}]  ${String(t).padStart(6)} tris`
      );
      geo.dispose();
    }
  }
  const s = whole.getSize(new THREE.Vector3());
  console.log(
    `  SEATED  ${(s.x * 1000).toFixed(0)} x ${(s.y * 1000).toFixed(0)} x ${(s.z * 1000).toFixed(0)} mm   ${(total / 1000).toFixed(1)}k tris`
  );
}
