import { Assembly, alignZ, box, blob, extrude, latheZ, rodZ, tubeZ, dome, ring } from '../geometry.js';
import {
  addBarrel,
  addMuzzleDevice,
  addPistolGrip,
  addPin,
  addScrew,
  addRail,
  addSlingLoop,
  buildMagazine,
  buildOptic,
  triggerPart,
  cartridge,
} from '../parts.js';

/**
 * The bolt-action sniper rifle — an Accuracy International AW pattern.
 *
 * A bolt gun is not a carbine with a scope on it. What makes it read:
 *
 *   - a CYLINDRICAL receiver with a big open ejection port and a barrel that
 *     is heavy all the way to the crown, not stepped down behind a gas block;
 *   - no gas system at all — the space above the barrel is empty, which is
 *     exactly what makes the profile so clean;
 *   - the bolt: a body running in the receiver, a handle bent down and back on
 *     the right with a spherical knob, and a shrouded rear;
 *   - a full chassis stock with a thumbhole, an adjustable cheek riser SITTING
 *     ON the comb and a rubber butt pad — one continuous line from the pistol
 *     grip to the toe;
 *   - a 34 mm scope in two RINGS with exposed capped turrets and a sunshade,
 *     standing 70 mm over the bore, which is what the cheek riser exists for;
 *   - six flutes cut into the barrel, and a 10-round straight box magazine.
 *
 * REAL DIMENSIONS this is built to (AI AW / AWM):
 *   overall length     1180 mm      modelled 1146
 *   barrel              610 mm      modelled 602
 *   scope over bore   60-75 mm      modelled 70   (was 112 — ultra-high rings
 *                                                  with the cheek 46 mm short
 *                                                  of the comb underneath)
 *   scope tube           34 mm, 50 mm objective
 *   .338 Lapua Magnum   case 69.2 mm, OAL 93.5 mm, rim 14.9 mm
 *   magazine, 10 rd     108 x 27 x 96.5 mm
 *
 * Layout (weapon-local metres, origin at the shooting hand's thumb web, bore
 * down -Z):
 *   bore axis        y = +0.078
 *   receiver         z = +0.075 .. -0.185
 *   scope centre     y = +0.148
 *   muzzle crown     z = -0.794
 *   butt pad         z = +0.349
 */
export function buildSniper() {
  const bore = 0.078;
  const rRec = 0.0208;
  const zRecRear = 0.075;
  const zRecFront = -0.185;
  const zBreech = -0.13;
  const zBarrelEnd = -0.732;   // 602 mm, i.e. the AW's 24 inch tube
  /**
   * The magazine sits directly in FRONT of the trigger guard, its rear wall on
   * the guard's front bow — which is where a box-fed bolt gun has to put it,
   * and 29 mm forward of where a 96.5 mm deep .338 box used to sit straight
   * through the guard. At -0.098 the last 2.7 mm of it still passed through the
   * front post; a 96.5 mm body seated here ends at z = -55.8 with the post's
   * front face at -52.5, so there is 3.3 mm of daylight between them.
   */
  const magZ = -0.104;
  const opticY = bore + 0.070;
  const opticZ = -0.055;
  const railTop = bore + rRec + 0.006;
  /**
   * Barrel radii. The shank is 26.4 mm across; the FLUTE ROOT is 2 mm under
   * that, and the barrel is built at the root diameter so the six lands can be
   * added back on top as solid sectors. Cutting grooves into a full-diameter
   * cylinder is not possible without CSG, and the previous attempt — six dark
   * rods laid ON the surface — stood 2.2 mm PROUD of it, so the "flutes" read
   * as six raised black ribs, the exact inverse of the feature.
   */
  const rBarrel = 0.0132;
  const rFluteRoot = rBarrel - 0.0021;
  const zFlute0 = -0.300;      // run-in, clear of the chamber swell
  const zFlute1 = -0.600;      // run-out, 130 mm short of the crown

  const body = new Assembly('sniper-body');

  // ---- receiver ------------------------------------------------------------
  /**
   * A round-bottomed tube with a flat-topped rail boss, machined from bar. The
   * ejection port is cut out of the right flank as a real opening.
   */
  const recTube = latheZ(
    [
      [0, 0],
      [0, rRec],
      [zRecRear - zRecFront, rRec],
      [zRecRear - zRecFront, 0],
    ],
    22
  );
  body.add(recTube, 'steel_black', { y: bore, z: zRecRear, ry: Math.PI });
  recTube.dispose();

  /**
   * Flat-top boss carrying the scope rail — TOP FACE ON THE TUBE'S CREST.
   *
   * MEASURED with the boss at bore + rRec + 0.002: it spanned y 94.8-106.8 while
   * the rail's teeth ran 97.4-105.0, so the boss's own top face stood 1.8 mm
   * ABOVE the rail crown and buried the thing it exists to carry — a machined
   * receiver with a Picatinny rail sunk into it, presenting a flat slab where the
   * teeth should be. addRail seats the rail's underside 7.4 mm below the crown
   * (4.2 base + 3.2 teeth), i.e. at 97.4 mm, which is 1.4 mm BELOW the tube's own
   * crest at bore + rRec = 98.8. So the boss tops out at the crest and the rail's
   * base plate is let into it by that 1.4 mm, which is exactly how an integral
   * flat-top is machined.
   */
  const boss = box(rRec * 1.7, 0.012, zRecRear - zRecFront - 0.012, 0.0016, 1);
  body.add(boss, 'steel_black', { y: bore + rRec - 0.006, z: (zRecRear + zRecFront) / 2 });
  boss.dispose();
  addRail(body, 'steel_black', zRecFront + 0.01, zRecRear - 0.008, railTop);

  // Ejection port: a rectangular relief cut on the right flank. Its lower lip
  // is flush with the receiver wall — a 5 mm proud bar of bright steel reads as
  // a weld bead running down the side of the action, which is what it was.
  const port = box(0.014, 0.030, 0.072, 0.0012, 1);
  body.add(port, 'cavity', { x: rRec - 0.004, y: bore + 0.004, z: -0.042 });
  port.dispose();
  const portLip = box(0.0036, 0.0035, 0.070, 0.0006, 1);
  body.add(portLip, 'steel_bright', { x: rRec - 0.0026, y: bore - 0.011, z: -0.042 });
  portLip.dispose();

  // Recoil lug and action screws, into the chassis.
  const lug = box(0.030, 0.020, 0.012, 0.0012, 1);
  body.add(lug, 'steel', { y: bore - rRec - 0.006, z: zRecFront + 0.03 });
  lug.dispose();
  for (const z of [zRecFront + 0.03, zRecRear - 0.045]) {
    addScrew(body, 'steel', 0, bore - rRec - 0.016, z, 0.0042, 'y', 0.012);
  }

  // ---- barrel --------------------------------------------------------------
  /**
   * Heavy varmint contour: it barely tapers over 602 mm. Built at the flute
   * root so the lands below can stand at the true 26.4 mm shank diameter.
   */
  addBarrel(body, 'steel_black', 'cavity', {
    y: bore,
    zBreech,
    zMuzzle: zBarrelEnd,
    rChamber: 0.0165,
    rBarrel: rFluteRoot,
    rGas: rFluteRoot,
    // Same radius as the shank, so the station exists in the profile but
    // cannot be seen: a bolt action has no gas block to model.
    gasAt: (zBreech + zBarrelEnd) * 0.5,
    knurl: false,
    seg: 24,
  });
  /**
   * SIX FLUTES, as six LANDS.
   *
   * Each land is an annular sector — a fan cross-section extruded along the
   * bore — standing from the root to the full shank diameter over a 30-degree
   * arc, with 30 degrees of open groove between neighbours. Built as an extrude
   * rather than a partial lathe because a partial lathe has no caps: the sector
   * walls would be open shells and the groove would show daylight through the
   * barrel at grazing angles.
   */
  const landArc = Math.PI / 6;          // 30 deg of land, 30 deg of flute
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 - landArc * 0.5;
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * landArc;
      // The outline is inset by the bevel, because ExtrudeGeometry grows the
      // shape OUTWARD by bevelSize: at the full 13.2 mm shank radius the lands
      // measured 13.7 and stood 0.5 mm proud of the plain sleeves either side of
      // the fluted run, so the flutes read as ribs again — the exact inversion
      // this construction exists to avoid, just five times smaller.
      pts.push([Math.cos(a) * (rBarrel - 0.0005), Math.sin(a) * (rBarrel - 0.0005)]);
    }
    for (let k = 4; k >= 0; k--) {
      const a = a0 + (k / 4) * landArc;
      pts.push([Math.cos(a) * (rFluteRoot - 0.0006), Math.sin(a) * (rFluteRoot - 0.0006)]);
    }
    const land = extrude(pts, Math.abs(zFlute1 - zFlute0), { bevel: 0.0005, curveSegments: 1 });
    body.add(land, 'steel_black', { y: bore, z: (zFlute0 + zFlute1) / 2 });
    land.dispose();
  }
  // Plain shank fore and aft of the fluted run: the barrel is only relieved in
  // the middle, and the run-out shoulders are where the flutes read as cuts.
  for (const [z0, z1] of [[zRecFront - 0.055, zFlute0], [zFlute1, zBarrelEnd - 0.002]]) {
    const sleeve = latheZ(
      [
        [0, rFluteRoot],
        [0.0022, rBarrel],
        [Math.abs(z1 - z0) - 0.0022, rBarrel],
        [Math.abs(z1 - z0), rFluteRoot],
      ],
      24
    );
    body.add(sleeve, 'steel_black', { y: bore, z: z0 });
    sleeve.dispose();
  }
  const muzzle = addMuzzleDevice(body, 'steel_soot', 'cavity', 'brake', zBarrelEnd, rBarrel, bore);

  // ---- chassis stock -------------------------------------------------------
  /**
   * One continuous aluminium chassis: forend under the barrel, thumbhole
   * through the wrist, comb and toe out to the butt. Authored as a side
   * outline in (z, y) and extruded across the weapon's width, with the
   * thumbhole as a real hole in the shape.
   *
   * The COMB was raised 36 mm behind the thumbhole. With the scope dropped to
   * 70 mm over the bore the shooter's eye is at y = 0.148, so the cheek has to
   * be within ~38 mm of that; the old top line sat at bore-0.030 and left the
   * riser and its two posts hanging in mid-air 46 mm above the wood.
   */
  const chassis = extrude(
    [
      [-0.40, bore - 0.030],
      [-0.40, bore - 0.062],
      [-0.16, bore - 0.070],
      [0.02, bore - 0.074],
      [0.075, bore - 0.070],
      [0.145, bore - 0.040],
      [0.185, bore - 0.014],
      [0.230, bore - 0.002],
      [0.335, bore + 0.002],
      [0.335, bore - 0.086],
      [0.245, bore - 0.092],
      [0.165, bore - 0.106],
      [0.105, bore - 0.112],
      [0.045, bore - 0.104],
      [0.012, bore - 0.086],
      [-0.02, bore - 0.052],
      [-0.16, bore - 0.046],
    ],
    0.036,
    {
      bevel: 0.0022,
      // The thumbhole: a real opening through the wrist of the stock.
      holes: [
        [
          [0.055, bore - 0.030],
          [0.135, bore - 0.036],
          [0.150, bore - 0.062],
          [0.115, bore - 0.080],
          [0.062, bore - 0.072],
          [0.040, bore - 0.050],
        ],
      ],
    }
  );
  chassis.rotateY(-Math.PI / 2);
  body.add(chassis, 'alu', {});
  chassis.dispose();

  /**
   * The forend, and it is the part that was missing.
   *
   * A chassis outline that stops 30 mm under the bore leaves the barrel
   * floating over a thin bracket with daylight between them, which is exactly
   * what reads as an unfinished model. A real AW forend is a deep box section
   * that comes up either side of the barrel almost to its centreline and runs
   * two thirds of the way to the muzzle.
   */
  const forend = extrude(
    [
      [-0.026, 0.010],
      [-0.030, -0.014],
      [-0.026, -0.040],
      [0.026, -0.040],
      [0.030, -0.014],
      [0.026, 0.010],
    ],
    0.300,
    { bevel: 0.0025 }
  );
  body.add(forend, 'alu', { y: bore - 0.012, z: -0.300 });
  forend.dispose();
  /**
   * THE BARREL CHANNEL — a trough cut down into the forend's deck, not a box
   * around the barrel.
   *
   * MEASURED before: the cavity ran y 70.0-98.0 while the barrel runs 59.3-96.7
   * and the forend's deck tops out at 76.0. So it ENCLOSED the barrel over
   * 296 mm and stood 22 mm proud of the stock — a matte-black slab laid along the
   * top of the forend hiding the flutes, which is the single largest wrong-value
   * surface on the weapon.
   *
   * A cavity only reads as a recess when it straddles the host's skin (see
   * addFlankRecess in parts.js for the same rule stated once). So: top face
   * 0.5 mm proud of the deck at 78.5, floor at 60.0 — 4.8 mm under the barrel's
   * belly at 64.8 — and 31 mm wide against the 26.4 mm shank, which leaves
   * 2.3 mm of dark either side. The barrel then sits IN something.
   *
   * 78.5 and not 76.0: `extrude`'s 2.5 mm bevel grows the forend outline
   * OUTWARD, so the deck is 2.5 mm above where the outline says it is. Measured
   * off the built geometry, which is the only place that number exists.
   */
  const channel = box(0.031, 0.019, 0.296, 0.0012, 1);
  body.add(channel, 'cavity', { y: bore - 0.0085, z: -0.300 });
  channel.dispose();

  // M-LOK slots down the forend flanks, so it is not a solid slab.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const slot = box(0.005, 0.0095, 0.032, 0.0008, 1);
      body.add(slot, 'cavity', { x: sx * 0.0288, y: bore - 0.020, z: -0.20 - i * 0.058 });
      slot.dispose();
    }
  }
  // Accessory rail along the bottom of the forend — teeth DOWN. Built up it put
  // its recoil slots inside the forend and pointed its 21.2 mm base plate at the
  // sky: measured y 18.6-26.2 against a forend belly at 23.5, so the only part
  // visible was the one face a rail must never present. See addRail's `down`.
  addRail(body, 'alu', -0.44, -0.20, bore - 0.0555, 0, { down: true });

  // Rubber butt pad on its spacer, matched to the raised comb line above.
  const pad = box(0.040, 0.088, 0.014, 0.0025, 1);
  body.add(pad, 'rubber', { y: bore - 0.042, z: 0.342 });
  pad.dispose();

  /**
   * Adjustable cheek riser on two PILLARS, each sized to the gap it actually has
   * to bridge.
   *
   * The riser is at the right height — 70 mm of scope over bore means the cheek
   * sits at y = 84..108 and the eye 40 mm above it — and it is genuinely carried:
   * `tools/measure-weapon-defects.mjs` reports nothing floating. What was still
   * wrong is that the riser is LEVEL and the comb under it is not, so the daylight
   * beneath it ran from 3.0 mm at the rear to 23.6 mm at the front, and two 11 mm
   * rods were lost in the wide end of that wedge.
   *
   * THE COMB CANNOT BE RAISED TO MEET IT, which is the constraint that decides
   * the whole design here. `boltTravel` is +98 mm, so on a cycle the bolt shroud
   * (local y 63.5..92.5) sweeps back to z = 160..184 — and MEASURED, the comb top
   * at z = 184 is already 65.5 mm against the shroud's 63.5 mm underside, i.e. the
   * two overlap by 2.0 mm as it is. Raising the comb makes the rifle eat its own
   * bolt. A real AI AW is cut down there for exactly this reason, and its cheek
   * piece bridges the relief on pillars — the gap is the hardware, not a defect.
   *
   * So: each pillar's height is DERIVED from the comb line at its own z, the same
   * way the trigger guard's two walls are below (`guardFloor`), and for the same
   * reason — a single guessed height cannot be right at both ends of a slope. The
   * front pillar comes out at 19.8 mm and the rear at 9.3 mm.
   */
  /**
   * The comb's top line, lifted verbatim from the chassis outline above plus the
   * 2.2 mm that `extrude`'s bevel grows the outline outward by. Kept as data so
   * the pillars cannot drift from the stock they stand on.
   */
  const combLine = [
    [0.145, bore - 0.040],
    [0.185, bore - 0.014],
    [0.230, bore - 0.002],
    [0.335, bore + 0.002],
  ];
  const combTopAt = (z) => {
    for (let i = 0; i < combLine.length - 1; i++) {
      const a = combLine[i];
      const b = combLine[i + 1];
      if (z >= a[0] && z <= b[0]) {
        return a[1] + ((z - a[0]) / (b[0] - a[0])) * (b[1] - a[1]) + 0.0022;
      }
    }
    return bore;
  };
  const riserH = 0.024;
  const riserUnder = bore + 0.006; // 8 mm over the comb's high point at z = 230
  const riserY = riserUnder + riserH * 0.5;
  /**
   * 116 mm of cheek piece from z = 194, not 128 mm from z = 176. The front tip
   * used to stand 16 mm forward of the front post over the deepest part of the
   * relief, which is the bit that read as a slab hanging in the air. It now
   * starts 6 mm ahead of its pillar. 116 mm is still a full cheek weld.
   */
  const riser = blob(0.036, riserH, 0.116, 0.005, 3);
  body.add(riser, 'polymer', { y: riserY, z: 0.252 });
  riser.dispose();
  /**
   * z = 200 for the front pillar, not 192, and that 8 mm is the bolt again: the
   * cocking indicator retracts to z = 183..193, so an 11 mm pillar centred at 192
   * (spanning 186.5..197.5) had the indicator passing straight through it. Centred
   * at 200 it spans 194.5..205.5 and clears by 1.5 mm.
   */
  for (const z of [0.200, 0.296]) {
    const foot = combTopAt(z) - 0.003; // 3 mm into the chassis
    const head = riserUnder + 0.003; // 3 mm into the riser
    const pillar = box(0.011, head - foot, 0.011, 0.0012, 1);
    body.add(pillar, 'steel_black', { y: (foot + head) * 0.5, z });
    pillar.dispose();
    addScrew(body, 'steel', 0.019, riserY, z, 0.004, 'x', 0.008);
  }

  addPistolGrip(body, 'polymer', 'rubber', { y: 0.030, z: 0.012, angle: 0.30, len: 0.104, w: 0.032 });

  /**
   * Trigger guard, cut from the chassis — and the two posts are NOT the same
   * height, because the chassis belly they hang off is not level.
   *
   * The stock's lower edge drops 33 mm between them: y = +27 mm at the front bow
   * (z = -50) and y = -6 mm at the rear (z = +10), where the thumbhole's underside
   * sweeps down to the grip. MEASURED with both posts at a single 28 mm height:
   * the rear one buried itself 10 mm into the chassis while the FRONT one topped
   * out at y = +4 with 23 mm of daylight above it — a post hanging in mid-air
   * under the one part of the weapon the support hand is looking at.
   */
  const guardBar = box(0.026, 0.004, 0.064, 0.0008, 1);
  body.add(guardBar, 'alu', { y: bore - 0.100, z: -0.020 });
  guardBar.dispose();
  const guardFloor = bore - 0.102; // the bar's own underside
  for (const [dz, yTop] of [
    [-0.050, bore - 0.048], // into the chassis belly at y = +27
    [0.010, bore - 0.080], // into the thumbhole's underside at y = -6
  ]) {
    const h = yTop - guardFloor;
    const wall = box(0.026, h, 0.005, 0.0008, 1);
    body.add(wall, 'alu', { y: yTop - h * 0.5, z: dz });
    wall.dispose();
  }

  // No bipod. Two 5 mm rods hanging under a forend read as scaffolding at
  // viewmodel distance, and the sling stud is the honest fitting for a rifle
  // that is shot standing.
  const stud = latheZ([[0, 0], [0, 0.007], [0.010, 0.007], [0.010, 0]], 12);
  body.add(stud, 'steel_black', { y: bore - 0.056, z: -0.415, rx: Math.PI / 2 });
  stud.dispose();

  /**
   * Rear sling loop, on the chassis belly.
   *
   * `ring()` is a torus in the XY plane, i.e. its axis is already +Z. `rx: PI/2`
   * alone therefore lays the eye FLAT — it swings the axis onto -Y and the loop
   * becomes a horizontal halo. It also sat at y = +2 with the chassis belly at
   * y = -22, so it was a flat halo 24 mm up inside the stock: invisible, and
   * wrong if it had not been. `ry: PI/2` puts the axis across the weapon, which
   * is the plane a sling actually threads, and bore - 0.106 hangs it 3.5 mm into
   * the belly at z = 0.20 with 16 mm proud below.
   */
  addSlingLoop(body, 'steel', 0, bore - 0.106, 0.20, 0.008, { ry: Math.PI / 2 });

  // ---- optic ---------------------------------------------------------------
  /**
   * A magnified scope: a 48 mm housing with a belled objective, exposed capped
   * turrets on a saddle, a magnification ring and a sunshade, carried in two
   * rings.
   *
   * The housing is deliberately fatter than a real 34 mm tube. That number is
   * set by the ADS optical train, not by the catalogue: the visible sight
   * picture is the smaller of (ocular bore / eye relief) and (objective bore /
   * (relief + length)), and dropping the housing to 34 mm shrinks the ADS frame
   * by 29% and re-introduces the second vignette buildOptic exists to remove.
   * Everything that says "magnified scope" rather than "pipe" — rings, saddle,
   * turret caps, mag ring, diopter — is therefore added as geometry below.
   */
  const rTube = 0.024;
  /**
   * 196 mm of TUBE, and the length is the whole reason this reads as a sniper
   * optic rather than a red dot.
   *
   * MEASURED at 118: `optic_tube z[-126, +3]` — 129 mm of housing on a 1143 mm
   * rifle, i.e. a stubby can sitting between two rings, on the one weapon in the
   * game that is defined by its scope. A 5-25x56 PM II is 427 mm; even allowing
   * for the fact that a viewmodel scope that long would cover the muzzle, 196 mm
   * puts the objective 27 mm past the receiver's front face, which is what a
   * scoped bolt gun looks like in profile.
   *
   * The OCULAR END IS PINNED. Everything that has to stay next to the shooter's
   * eye — the magnification ring, the throw lever, the diopter, and (through
   * `optic.lensZ`) the `sight` node the ADS path lines up on — is placed off
   * `opticZ`, so the tube grows FORWARD only: `opticCz` is derived by holding the
   * rear end where 118 mm put it. Nothing about the ADS optical train changes,
   * because that is governed by the tube RADIUS and the eye relief.
   */
  const opticLen = 0.196;
  const opticCz = opticZ + 0.059 - opticLen / 2;
  const optic = buildOptic(body, {
    rTube,
    len: opticLen,
    hood: 0.014,
    y: opticY,
    z: opticCz,
    railTop,
    matBody: 'alu_fine',
    matSteel: 'steel',
    /**
     * NO RED-DOT HARDWARE AND NO CANTILEVER MOUNT. This scope carries capped
     * target turrets on a saddle, a parallax wheel and two split rings, all
     * fitted below. Taking buildOptic's defaults as well fitted every one of
     * them TWICE: measured, a second elevation turret topping out at y = 182.4
     * with the saddle's own starting at 180.4, a battery dial at x = -34.4..-21.6
     * entirely inside the 33 mm parallax wheel, and a cantilever riser whose
     * 55 mm clamp rings stood proud of the 37 mm saddle they sat inside.
     */
    hardware: false,
    mount: false,
  });

  /**
   * TWO RINGS, which is the single strongest cue that this is a bolt gun with
   * a scope bolted to it rather than an integrated sight. Each is a split ring:
   * a clamp band round the tube, a base block down to the rail, and two cap
   * screws across the split. Positioned front and rear of the saddle.
   */
  // Fore and aft of the saddle, on the tube's own centre — not on the ocular
  // datum, or a 196 mm tube would carry both its rings in the last 90 mm.
  for (const rz of [opticCz + 0.052, opticCz - 0.046]) {
    const band = tubeZ(rTube + 0.0062, rTube - 0.0006, 0.016, 24, 0.0005);
    body.add(band, 'alu_fine', { y: opticY, z: rz });
    band.dispose();
    // Base block from the underside of the band down onto the rail.
    const base = box(0.020, opticY - rTube - railTop + 0.006, 0.016, 0.0012, 1);
    body.add(base, 'alu_fine', {
      y: (opticY - rTube + railTop) * 0.5,
      z: rz,
    });
    base.dispose();
    // The split line and its two cap screws, on the ring's flank.
    const split = box(0.0026, 0.013, 0.017, 0.0004, 1);
    body.add(split, 'cavity', { x: rTube + 0.0056, y: opticY + 0.002, z: rz });
    body.add(split, 'cavity', { x: -rTube - 0.0056, y: opticY + 0.002, z: rz });
    split.dispose();
    for (const sx of [-1, 1]) {
      addScrew(body, 'steel', sx * (rTube + 0.0055), opticY + 0.008, rz, 0.0026, 'x', 0.007);
    }
  }

  /**
   * THE TURRET SADDLE and the capped turrets on it. The saddle is the squared
   * bulge in the middle of a rifle scope's tube; without it the turrets grew
   * straight out of a round pipe with 6 mm of their bodies buried inside it.
   */
  const saddleZ = opticCz + 0.004;
  const saddle = blob(rTube * 1.55, rTube * 1.45, 0.052, 0.004, 3);
  body.add(saddle, 'alu_fine', { y: opticY, z: saddleZ });
  saddle.dispose();

  /**
   * Elevation on top, windage on the RIGHT — which is the correct hand for a
   * right-handed shooter and matches the bolt. Each is a knurled drum with a
   * hash-marked skirt and a screw-on cap standing 24 mm off the saddle, so it
   * breaks the scope's outline the way a target turret has to.
   */
  const turretDrum = latheZ(
    [
      [0, 0],
      [0, 0.0106],
      [0.004, 0.0112],
      [0.016, 0.0112],
      [0.018, 0.0098],
      [0.018, 0],
    ],
    18
  );
  const turretCap = latheZ(
    [
      [0, 0],
      [0, 0.0092],
      [0.0016, 0.0098],
      [0.009, 0.0098],
      [0.010, 0.0086],
      [0.010, 0],
    ],
    16
  );
  // Top: elevation.
  body.add(turretDrum, 'alu_fine', { y: opticY + rTube * 1.35, z: saddleZ, rx: -Math.PI / 2 });
  body.add(turretCap, 'alu_fine', { y: opticY + rTube * 1.35 + 0.018, z: saddleZ, rx: -Math.PI / 2 });
  // Right: windage.
  body.add(turretDrum, 'alu_fine', { x: rTube * 1.45, y: opticY, z: saddleZ, ry: Math.PI / 2 });
  body.add(turretCap, 'alu_fine', { x: rTube * 1.45 + 0.018, y: opticY, z: saddleZ, ry: Math.PI / 2 });
  turretDrum.dispose();
  turretCap.dispose();
  // Click hashes round the elevation skirt — the detail that says the turret
  // turns, and the only thing on the optic with a repeating fine pitch.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const hash = box(0.0011, 0.006, 0.0011, 0.0002, 1);
    body.add(hash, 'cavity', {
      x: Math.sin(a) * 0.0113,
      y: opticY + rTube * 1.35 + 0.008,
      z: saddleZ + Math.cos(a) * 0.0113,
    });
    hash.dispose();
  }

  /**
   * Magnification ring at the ocular end with a throw lever, and the diopter
   * ring behind it. Together they turn the rear third of the tube from a
   * cylinder into three stacked collars, which is what a variable scope is.
   */
  const magRing = tubeZ(rTube + 0.0028, rTube - 0.001, 0.024, 24, 0.0005);
  body.add(magRing, 'alu_fine', { y: opticY, z: opticZ + 0.040 });
  magRing.dispose();
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const knurl = box(0.0012, 0.0012, 0.020, 0.0002, 1);
    body.add(knurl, 'cavity', {
      x: Math.sin(a) * (rTube + 0.0028),
      y: opticY + Math.cos(a) * (rTube + 0.0028),
      z: opticZ + 0.040,
    });
    knurl.dispose();
  }
  const throwLever = box(0.008, 0.026, 0.010, 0.0012, 1);
  body.add(throwLever, 'alu_fine', { x: -0.004, y: opticY + rTube + 0.014, z: opticZ + 0.040, rz: 0.5 });
  throwLever.dispose();
  const diopter = tubeZ(rTube + 0.0016, rTube - 0.001, 0.010, 24, 0.0004);
  body.add(diopter, 'alu_fine', { y: opticY, z: opticZ + 0.056 });
  diopter.dispose();

  /**
   * Sunshade, screwed onto the OBJECTIVE and therefore the objective's own
   * diameter. It used to be 4.6 mm narrower than the bell and floating 13 mm
   * ahead of it, which read as a second, smaller pipe hanging off the front.
   */
  /**
   * The bell is rTube * 1.226 and buildOptic's rubber objective bumper stands on
   * it at 1.08 of that, i.e. rTube * 1.324 = 31.8 mm. A shade screwed onto the
   * objective cannot be NARROWER than the thing it screws onto: at the bell's own
   * 29.4 mm it left a 2.4 mm step all the way round, which reads as a second,
   * smaller pipe stuck on the front. 1.325 puts it flush with the bumper.
   */
  const rBell = rTube * 1.325;
  const shade = tubeZ(rBell, rBell - 0.0018, 0.054, 22, 0.0005);
  // Screwed onto the objective, so it hangs off the tube's FRONT end (the hood
  // is 14 mm, and 54 mm of shade half-overlaps it), not off the ocular datum.
  body.add(shade, 'alu_fine', { y: opticY, z: opticCz - opticLen / 2 - 0.025 });
  shade.dispose();

  // Parallax wheel on the LEFT. ry=-PI/2 maps the lathe's +Z onto -X so it
  // grows outboard; at +PI/2 the whole wheel was inside the tube and invisible.
  const wheel = latheZ([[0, 0], [0, 0.0165], [0.010, 0.0165], [0.010, 0]], 18);
  body.add(wheel, 'alu_fine', { x: -rTube - 0.0005, y: opticY, z: opticZ + 0.010, ry: -Math.PI / 2 });
  wheel.dispose();

  // ---- moving parts --------------------------------------------------------
  const bolt = new Assembly('sniper-bolt');
  const boltBody = rodZ(0.0105, 0.0105, 0.145, 14);
  bolt.add(boltBody, 'steel_bright', { y: bore, z: -0.012 });
  boltBody.dispose();
  /**
   * The bolt shroud and its cocking-indicator pin. The pin standing out of the
   * back of the shroud is how an AI tells you it is cocked, and it is the last
   * 6 mm of the weapon's silhouette at the eye end.
   */
  const shroud = latheZ([[0, 0], [0, 0.0145], [0.018, 0.0145], [0.024, 0.0112], [0.024, 0]], 16);
  bolt.add(shroud, 'steel_black', { y: bore, z: 0.062 });
  shroud.dispose();
  const indicator = rodZ(0.0026, 0.0022, 0.010, 10);
  bolt.add(indicator, 'steel_black', { y: bore, z: 0.090 });
  indicator.dispose();
  /**
   * Handle: a stalk canted down and outboard, with a knurled ball on its end.
   *
   * THE CANT HAS TO COME FROM `alignZ`, not from `{ ry, rz }`. `rodZ` puts its
   * axis on +Z and `Assembly.add` composes Euler 'XYZ', so rz is applied FIRST —
   * and +Z is invariant under rz. The old `{ ry: PI/2, rz: 0.42 }` therefore
   * produced a stalk lying dead flat along +X with no cant at all, while the knob
   * was hand-placed 22 mm down at the end of the 0.42 rad the stalk never took:
   * measured, stalk y 63.2-72.8 against knob y 33.2-58.8, a 4.4 mm gap with the
   * ball hanging in space beside the receiver.
   *
   * The direction is one number now. 24 degrees below horizontal, outboard and
   * 8 degrees rearward — an AI's handle is swept back so the hand comes off the
   * grip straight onto it — and the knob is placed by walking `len` down that
   * same vector from the stalk's root, so the two cannot drift apart again.
   */
  const rootX = 0.008;
  const rootY = bore - 0.004;
  const rootZ = 0.030;
  const dir = [Math.cos(0.42), -Math.sin(0.42), 0.14]; // out, down, a little back
  const stalkLen = 0.042;
  const stalk = rodZ(0.0048, 0.0048, stalkLen, 12);
  const nrm = Math.hypot(dir[0], dir[1], dir[2]);
  const u = dir.map((c) => c / nrm);
  /**
   * MATERIAL: `steel_black` on the stalk AND the knob.
   *
   * The handle is the closest weapon geometry to the eye on this rifle — 42 mm
   * of stalk canted out of the receiver at eye height, with a 26 mm ball on the
   * end pointed at the camera. As `steel_bright` the pair measured as the
   * brightest objects in the frame ("a bright polished torus ... the loudest
   * object on screen"). An Accuracy International bolt handle and knob are both
   * coated black; the polished steel on this weapon is the bolt BODY, which lives
   * inside the action and is only seen through the ejection port.
   */
  bolt.add(stalk, 'steel_black', {
    x: rootX + u[0] * stalkLen * 0.5,
    y: rootY + u[1] * stalkLen * 0.5,
    z: rootZ + u[2] * stalkLen * 0.5,
    ...alignZ(u[0], u[1], u[2]),
  });
  stalk.dispose();
  // The ball sits on the far end of the stalk: root + len along the same vector.
  const knob = latheZ([[-0.012, 0], [-0.012, 0.0115], [0, 0.0128], [0.012, 0.0115], [0.012, 0]], 14);
  bolt.add(knob, 'steel_black', {
    x: rootX + u[0] * stalkLen,
    y: rootY + u[1] * stalkLen,
    z: rootZ + u[2] * stalkLen,
    ...alignZ(u[0], u[1], u[2]),
  });
  knob.dispose();
  /**
   * A .338 Lapua in the chamber. 93.5 mm over all: the bullet used to stand
   * 32.4 mm out of the case for a 102 mm round, which is 8 mm longer than the
   * cartridge exists in and long enough to spear out through the magazine's
   * front wall when the same numbers were used there.
   */
  const chamberRound = cartridge(0.0698, 0.0072, 0.0243);
  bolt.add(chamberRound.brass, 'brass', { z: zBreech, ry: Math.PI, y: bore });
  chamberRound.brass.dispose();
  chamberRound.bullet.dispose();

  const magazine = new Assembly('sniper-mag');
  const mag = buildMagazine(magazine, null, {
    w: 0.0268,
    // 96.5 mm front to back: a 93.5 mm cartridge plus its walls. At 88.5 the
    // top round's tip stood 10 mm outside the magazine body.
    d: 0.0965,
    len: 0.108,
    curve: 0.006,
    segs: 4,
    witness: 0,
    caseLen: 0.0698,
    rimR: 0.0072,
    bulletLen: 0.0243,
    poly: 'steel_black',
  });

  const trigger = new Assembly('sniper-trigger');
  const trg = triggerPart('steel_bright');
  trigger.add(trg.geo, 'steel_bright', {});
  trg.geo.dispose();

  return {
    id: 'awp',
    label: 'AWP',
    fxClass: 'sniper',
    body,
    moving: { magazine, bolt, trigger },
    nodes: {
      muzzle: [0, bore, muzzle.crownZ],
      chamber: [0, bore, zBreech],
      eject: [rRec + 0.008, bore + 0.006, -0.042],
      ejectDir: [0.92, 0.34, 0.2],
      sight: [0, opticY, optic.lensZ],
      sightAxis: [0, 0, -1],
      ironSight: [0, opticY, optic.lensZ],
      gripR: {
        pos: [0.0251, 0.052, 0.1165],
        finger: [0.05, -0.6, -0.798],
        back: [1, 0.03, 0.04],
      },
      // Support hand under the chassis forend, ahead of the magazine.
      gripL: {
        pos: [-0.088, 0.052, -0.235],
        finger: [0.8977, -0.3267, -0.2955],
        back: [-0.2784, -0.7648, 0.581],
      },
      handguard: { axis: [0, bore - 0.052, 0], dir: [0, 0, 1], r: 0.021, z0: -0.15, z1: -0.39 },
      magSeat: { pos: [0, bore - 0.052, magZ], rot: [0, 0, 0] },
      magDrop: [0, -0.38, 0.02],
      boltRest: { pos: [0, 0, 0], rot: [0, 0, 0] },
      boltTravel: [0, 0, 0.098],
      triggerPivot: { pos: [0, bore - 0.076, -0.028], rot: [0, 0, 0] },
      triggerPull: -0.28,
      opticGlass: optic,
    },
    shell: { caseLen: 0.0698, rimR: 0.0072 },
    magSize: { len: mag.len, w: mag.w, d: mag.d },
  };
}
