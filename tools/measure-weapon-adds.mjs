// Per-ADD bounding boxes, in mm, so a single misplaced part can be found by
// name instead of by eye. `node tools/measure-weapon-adds.mjs ak47 steel_bright`
import * as THREE from 'three';
import { Assembly } from '../src/gfx/weapons/geometry.js';
import { buildWeaponModel } from '../src/gfx/weapons/catalogue.js';

const [id, matFilter] = process.argv.slice(2);
const origAdd = Assembly.prototype.add;
const log = [];
Assembly.prototype.add = function (geo, mat, t) {
  const before = this.buckets.get(mat)?.length ?? 0;
  const r = origAdd.call(this, geo, mat, t);
  if (!matFilter || mat === matFilter) {
    const list = this.buckets.get(mat);
    const g = list[before];
    g.computeBoundingBox();
    const b = g.boundingBox;
    const f = (v) => (v * 1000).toFixed(1).padStart(7);
    log.push(
      `${this.name.padEnd(10)}${mat.padEnd(13)}x[${f(b.min.x)},${f(b.max.x)}] y[${f(b.min.y)},${f(b.max.y)}] z[${f(b.min.z)},${f(b.max.z)}]`
    );
  }
  return r;
};
buildWeaponModel(id);
console.log(log.join('\n'));
void THREE;
