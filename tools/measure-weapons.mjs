// Headless dimension check for the procedural weapons.
//
//   node tools/measure-weapons.mjs
//
// Builds every weapon with the real builders (no GPU, no materials — geometry
// only) and prints the bounding box of the whole gun and of each moving part,
// in millimetres, against the real-world figure it is meant to hit.
//
// This exists because weapon defects are dimensional, and eyeballing a
// turntable does not catch them: the magazine feed lips were rotated onto the
// wrong axis for months and every magazine in the game was 60-100 mm too wide,
// which is obvious in this table and nearly invisible in a screenshot.
import * as THREE from 'three';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';

/** Real-world reference: [overall length, magazine width] in mm. */
const REAL = {
  m4a1: { length: 756, magW: 25.5, note: 'M4A1 carbine, stock collapsed' },
  ak47: { length: 870, magW: 25.0, note: 'AK-47 fixed stock' },
  mp5: { length: 680, magW: 24.5, note: 'MP5A2 fixed stock' },
  awp: { length: 1180, magW: 26.8, note: 'AI AW .338' },
  deagle: { length: 273, magW: 24.5, note: 'Mark XIX 6 inch' },
  usp: { length: 340, magW: 21.2, note: 'USP45 Tactical + suppressor' },
  glock: { length: 202, magW: 21.2, note: 'Glock 18C' },
};

function sizeOf(assembly) {
  const map = assembly.build();
  const box = new THREE.Box3();
  for (const geo of map.values()) {
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
    geo.dispose();
  }
  if (box.isEmpty()) return null;
  const s = box.getSize(new THREE.Vector3());
  return { x: s.x * 1000, y: s.y * 1000, z: s.z * 1000, box };
}

let bad = 0;
for (const id of PROCEDURAL_WEAPON_IDS) {
  const model = buildWeaponModel(id);
  if (!model) continue;
  const real = REAL[id] ?? {};
  const whole = new THREE.Box3();
  const parts = [];

  const body = sizeOf(model.body);
  if (body) whole.union(body.box);
  parts.push(['body', body]);
  for (const [name, asm] of Object.entries(model.moving ?? {})) {
    const s = sizeOf(asm);
    if (s) whole.union(s.box);
    parts.push([name, s]);
  }

  const total = whole.getSize(new THREE.Vector3());
  const lengthMm = total.z * 1000;
  const mag = parts.find(([n]) => n === 'magazine')?.[1];

  console.log(`\n${id.toUpperCase()}  ${real.note ?? ''}`);
  console.log(
    `  overall  ${lengthMm.toFixed(0)} mm` +
      (real.length ? `   real ${real.length} mm   (${(((lengthMm - real.length) / real.length) * 100).toFixed(1)}%)` : '')
  );
  if (mag) {
    const err = real.magW ? mag.x - real.magW : 0;
    const flag = real.magW && mag.x > real.magW * 1.35 ? '  <-- TOO WIDE' : '';
    console.log(
      `  magazine ${mag.x.toFixed(1)} x ${mag.y.toFixed(0)} x ${mag.z.toFixed(1)} mm` +
        (real.magW ? `   real width ${real.magW} mm   (${err > 0 ? '+' : ''}${err.toFixed(1)})` : '') +
        flag
    );
    if (flag) bad++;
  }
  for (const [name, s] of parts) {
    if (!s || name === 'magazine') continue;
    console.log(`  ${name.padEnd(9)}${s.x.toFixed(0)} x ${s.y.toFixed(0)} x ${s.z.toFixed(0)} mm`);
  }
}

console.log(bad ? `\n${bad} magazine(s) still oversized.` : '\nAll magazines within tolerance.');
