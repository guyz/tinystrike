import { Assembly, box, blob, extrude, roundRect, latheZ, rodZ, tubeZ, dome } from '../geometry.js';
import {
  addBarrel,
  addMuzzleDevice,
  addPistolGrip,
  addPin,
  addScrew,
  addSlingLoop,
  buildMagazine,
  triggerPart,
  cartridge,
} from '../parts.js';

/**
 * The AK-47 — and it is an AK, not an AR with different furniture.
 *
 * Everything that makes the silhouette read from 40 m away is geometry here:
 *
 *   - a STAMPED sheet receiver, 1 mm walls with the rolled rails and the two
 *     dimples over the magwell, not a machined billet;
 *   - the ribbed top cover, which is a separate loose part sitting on the
 *     receiver, with the recoil-spring guide poking through its rear notch;
 *   - the gas tube ABOVE the barrel with its own wooden handguard, the single
 *     most recognisable line on the weapon;
 *   - the 45-degree gas block and the hooded front sight on their own blocks,
 *     with the cleaning rod slung underneath;
 *   - the 30-round 7.62x39 magazine, which is not "a curved box": it is a
 *     strong arc — 34 degrees of it — with the toe standing 72 mm forward of
 *     the feed lips, ribbed, with the front lug that hooks the magwell;
 *   - a slant-cut compensator, a stamped selector lever the length of a hand on
 *     the RIGHT side, and the charging handle on the right of the carrier;
 *   - the angled fixed stock with its comb sloping to the butt plate.
 *
 * REAL DIMENSIONS this is built to (AKM, 6P1 pattern):
 *   overall length      870 mm      modelled 913
 *   barrel              415 mm      modelled 408
 *   sight radius        378 mm      modelled 356
 *   receiver            278 mm      modelled 278
 *   receiver width       35 mm      modelled 35.6
 *   length of pull      335 mm      modelled 350
 *   magazine, 30 rd     250 mm on the spine, 34 deg of arc, 24.5 x 70 mm body
 *   7.62x39             case 38.7 mm, OAL 56 mm, rim 11.35 mm
 *
 * Layout (weapon-local metres, origin at the shooting hand's thumb web, bore
 * down -Z). The bore sits 66 mm above the web — lower than an AR, because
 * there is no buffer tube in line with the bore:
 *   bore axis        y = +0.066
 *   receiver         z = +0.108 .. -0.170
 *   magwell centre   z = -0.100
 *   rear sight notch z = -0.176
 *   gas block        z = -0.378
 *   front sight      z = -0.532
 *   muzzle crown     z = -0.593
 *   butt plate       z = +0.320
 */
export function buildAK() {
  const bore = 0.066;
  /**
   * 35.6 mm across the flanks. An AKM receiver is folded from 1 mm sheet and
   * measures 35 mm outside; the previous 38.4 mm read as a machined billet,
   * which is exactly the wrong impression for the cheapest rifle ever built.
   */
  const recW = 0.0178;
  /**
   * 49 mm of receiver wall. Measured off the sheet blank: the AK's flank is
   * short — 19 mm of it above the bore, 30 mm below — and the gun's whole
   * lean-forward read comes from a shallow receiver under a proud top cover.
   */
  const recTop = bore + 0.019;
  const recBot = bore - 0.030;
  /**
   * RECEIVER POSITION, and it is the fix the whole weapon hung on.
   *
   * On an AKM the bolt face sits ~30 mm behind the receiver's front edge (the
   * front trunnion is that long) and the trigger is 140 mm behind it. The old
   * layout had the receiver 35 mm too far forward of the breech and 63 mm too
   * far forward of the trigger, which pushed the rear sight out onto the barrel:
   * the sight radius measured 283 mm against a real 378, and 245 mm of stock
   * hung off the back of a receiver that should only carry 195.
   */
  const zRecFront = -0.170;
  const zRecRear = zRecFront + 0.278;   // 278 mm, the stamped AKM receiver
  const magZ = -0.100;
  const magTilt = 0.28;     // the AK magazine rocks forward, hard
  const zBreech = -0.140;
  const zBarrelEnd = -0.548;
  const gasZ = -0.378;      // gas port 238 mm ahead of the breech, per 6P1
  const gasY = bore + 0.030;  // gas tube axis, above the bore
  const hgZ0 = -0.214;
  const hgZ1 = -0.348;
  const fsZ = -0.532;       // front sight post, 16 mm behind the muzzle shoulder
  const rsZ = -0.176;       // rear sight notch, right at the receiver's mouth
  const rBarrel = 0.0079;

  const body = new Assembly('ak-body');

  // ---- stamped receiver ----------------------------------------------------
  /**
   * The receiver is a folded sheet: flat flanks, a flat floor, open at the top.
   * Building it as five thin panels rather than one solid box is what gives the
   * rolled top edge and the visible wall thickness at the ejection port.
   */
  const wallH = recTop - recBot;
  for (const sx of [-1, 1]) {
    const flank = box(0.0016, wallH, zRecRear - zRecFront, 0.0008, 1);
    body.add(flank, 'steel_black', {
      x: sx * recW,
      y: (recTop + recBot) / 2,
      z: (zRecRear + zRecFront) / 2,
    });
    flank.dispose();
    // Rolled rail down the outside of each flank — the stiffening bead.
    const bead = box(0.0026, 0.0055, (zRecRear - zRecFront) * 0.92, 0.0009, 1);
    body.add(bead, 'steel_black', {
      x: sx * (recW + 0.001),
      y: recBot + 0.011,
      z: (zRecRear + zRecFront) / 2 + 0.004,
    });
    bead.dispose();
    // The two magwell dimples, the classic stamped-AK tell.
    for (const dz of [-0.028, 0.028]) {
      const dimple = dome(0.0072, 12, 0.55);
      body.add(dimple, 'steel_black', {
        x: sx * (recW + 0.0012),
        y: bore - 0.019,
        z: magZ + dz,
        rz: sx * -Math.PI / 2,
      });
      dimple.dispose();
    }
  }
  /**
   * THE RECEIVER FLOOR, WITH A HOLE IN IT.
   *
   * It was a solid box, so on a reload the magazine dropped away and left a
   * sealed steel plate where the magwell should be — the one moment in the whole
   * animation when the player is looking straight at it. (`addLowerReceiver`
   * builds the AR's well as a genuine tube for exactly this reason.)
   *
   * Authored as a plate in XY with the well as a real hole, then rolled a
   * quarter turn about X so the outline's Y becomes the weapon's Z and the
   * extrusion becomes the 1.8 mm sheet thickness. The opening is 26 x 72 mm
   * against a 24.5 x 70.5 mm magazine — 0.75 mm of clearance all round — which
   * leaves a 4.8 mm ledge inside each 35.6 mm flank, the width of the folded lip
   * a stamped AK's magazine actually rocks into.
   */
  const floorLen = zRecRear - zRecFront - 0.02;
  const floorCz = (zRecRear + zRecFront) / 2;
  const floor = extrude(roundRect(recW * 2, floorLen, 0.004, 3), 0.0018, {
    bevel: 0.0005,
    holes: [roundRect(0.026, 0.072, 0.004, 3).map(([hx, hy]) => [hx, hy + (magZ - floorCz)])],
  });
  floor.rotateX(Math.PI / 2); // outline Y -> weapon Z, extrusion -> sheet thickness
  body.add(floor, 'steel_black', { y: recBot, z: floorCz });
  floor.dispose();

  /**
   * THE RIGHT-SIDE OPENING. An AK has one long cut along the top of its right
   * flank: the ejection port at the front, the charging-handle slot behind it,
   * ~135 mm end to end. It is the only hole in the weapon's side and the top
   * cover overhangs it, so it is a hard shadow line running most of the
   * receiver's length — the receiver read as a sealed box without it.
   */
  const slot = box(0.010, 0.0125, 0.132, 0.0009, 1);
  body.add(slot, 'cavity', { x: recW - 0.0016, y: recTop - 0.0085, z: -0.060 });
  slot.dispose();
  // The port is deeper than the handle slot and its lower lip is polished by
  // three decades of brass.
  const port = box(0.011, 0.019, 0.056, 0.0009, 1);
  body.add(port, 'cavity', { x: recW - 0.0022, y: recTop - 0.012, z: -0.098 });
  port.dispose();
  const portLip = box(0.0034, 0.0026, 0.056, 0.0006, 1);
  body.add(portLip, 'steel_bright', { x: recW - 0.0002, y: recTop - 0.0215, z: -0.098 });
  portLip.dispose();

  // Front and rear trunnions: the milled blocks the sheet is riveted to.
  const frontTrunnion = blob(recW * 2 + 0.001, wallH - 0.004, 0.052, 0.003, 3);
  body.add(frontTrunnion, 'steel', { y: bore - 0.004, z: zRecFront + 0.024 });
  frontTrunnion.dispose();
  const rearTrunnion = blob(recW * 2 + 0.001, wallH - 0.008, 0.042, 0.003, 3);
  body.add(rearTrunnion, 'steel', { y: bore - 0.008, z: zRecRear - 0.018 });
  rearTrunnion.dispose();
  /**
   * RIVETS, in the AKM's own pattern rather than as generic cross pins.
   *
   * A stamped AK is held together by 11 semi-tubular rivets per side and they
   * are the loudest small detail on the flank: 5.5 mm domed heads standing 1.3
   * mm proud of a flat sheet, in three groups — four through the front
   * trunnion, two through the rear, three along the trigger-guard block. A
   * flush cross pin has none of that read, because a rivet head is a hemisphere
   * catching the key light and a pin is a disc.
   */
  const rivet = dome(0.0028, 10, 0.5);
  const rivetsAt = [
    [zRecFront + 0.010, bore + 0.008], [zRecFront + 0.010, bore - 0.016],
    [zRecFront + 0.038, bore + 0.008], [zRecFront + 0.038, bore - 0.018],
    [zRecRear - 0.030, bore + 0.004], [zRecRear - 0.010, bore - 0.014],
    [-0.040, recBot + 0.006], [-0.006, recBot + 0.006], [0.028, recBot + 0.006],
  ];
  for (const sx of [-1, 1]) {
    for (const [rz, ry] of rivetsAt) {
      body.add(rivet, 'steel', { x: sx * (recW + 0.0009), y: ry, z: rz, rz: sx * -Math.PI / 2 });
    }
  }
  rivet.dispose();

  // ---- top cover -----------------------------------------------------------
  /**
   * A pressed steel lid with lateral ribs. It is deliberately a separate,
   * slightly proud part: on a real AK it rattles, and the shadow line where it
   * overhangs the receiver is a large part of the gun's read.
   */
  const coverLen = zRecRear - zRecFront - 0.036;
  const coverZ = (zRecRear + zRecFront) / 2 + 0.012;
  /**
   * The crown is a shallow ARCH, not a plate. A dead-flat 26 mm x 240 mm plane
   * pointing at the sky is the largest single up-facing surface on the weapon
   * and it caught the whole key lobe: measured against the flanks beside it the
   * cover was reading as a white bar laid along the receiver. Two 45-degree
   * facets take the flat down to 12 mm and give the highlight an edge to break
   * on, which is also the section a pressed sheet lid actually has.
   */
  const cover = extrude(
    [
      [-recW - 0.0018, 0],
      [-recW - 0.0018, 0.011],
      [-recW * 0.80, 0.0198],
      [-recW * 0.34, 0.0232],
      [recW * 0.34, 0.0232],
      [recW * 0.80, 0.0198],
      [recW + 0.0018, 0.011],
      [recW + 0.0018, 0],
    ],
    coverLen,
    { bevel: 0.0009 }
  );
  body.add(cover, 'steel_black', { y: recTop - 0.001, z: coverZ, ry: Math.PI });
  cover.dispose();
  /**
   * Nine transverse stiffening ribs on a 17 mm pitch — the AKM cover's own
   * corrugation.
   *
   * THEY HAVE TO FOLLOW THE ARCH. The previous ribs were flat 25.4 x 2.2 mm
   * boxes at a single height, and against a crowned lid that means each one is
   * BURIED at the centre line and only breaks the surface out near the facet
   * break. Worked through: the crown is at y = 23.2 mm from x = 0 to 6.4 and
   * falls to 19.8 at x = 15.0, while the rib's own top sat at 22.9 — so 0.3 mm
   * underground in the middle and 2.2 mm proud at x = 12.7. Nine of those on a
   * dark lid read as nine drilled HOLES in the receiver roof, which is exactly
   * how the review saw them ("perforated with ~14 drilled holes ... pure
   * fiction"). Real AKM covers have no holes at all.
   *
   * So the rib is the cover's own cross-section offset 1.2 mm outward and
   * closed off at y = 10 mm: a raised band that hugs the crown all the way
   * across and down both facets, standing a uniform 1.2 mm proud. That is a
   * pressed corrugation, and it cannot read as a hole from any angle.
   */
  const ribProfile = [
    [-recW - 0.0028, 0.010],
    [-recW - 0.0030, 0.0122],
    [-recW * 0.80 - 0.0012, 0.0210],
    [-recW * 0.34, 0.0244],
    [recW * 0.34, 0.0244],
    [recW * 0.80 + 0.0012, 0.0210],
    [recW + 0.0030, 0.0122],
    [recW + 0.0028, 0.010],
  ];
  const rib = extrude(ribProfile, 0.0058, { bevel: 0.0007 });
  for (let i = 0; i < 9; i++) {
    body.add(rib, 'steel_black', { y: recTop - 0.001, z: coverZ - 0.068 + i * 0.017 });
  }
  rib.dispose();
  // Recoil-spring guide sticking out of the rear notch. Blued, not bright: it
  // is the same phosphate as everything else in the receiver.
  const guide = rodZ(0.0035, 0.0035, 0.014, 10);
  body.add(guide, 'steel', { y: recTop + 0.006, z: zRecRear - 0.002 });
  guide.dispose();

  // ---- rear sight block + leaf ---------------------------------------------
  /**
   * Pinned to the BARREL, immediately in front of the receiver's mouth. That
   * position is the AK's whole sighting character: a 378 mm radius on an 870 mm
   * rifle, i.e. the rear notch sits 500 mm from the eye and the front post is
   * a long way past the support hand.
   */
  /**
   * 28 mm tall, not 24, and centred 2 mm higher.
   *
   * MEASURED (tools/measure-weapon-defects.mjs): at 24 mm centred on bore+0.006
   * this block topped out at bore+0.018 while the leaf above it starts at
   * bore+0.020 — the rear sight leaf floated 1.4 mm clear of the only thing
   * holding it. The leaf itself cannot come down: its notch floor sits at
   * bore+0.0275 and the front post's tip height is DERIVED from that notch (see
   * the front sight below), so moving it would silently change the rifle's zero.
   * So the block grows upward to meet it: bottom stays at bore-0.006 where it
   * wraps the barrel, top goes to bore+0.022, which is 2 mm into the leaf.
   */
  const sightBlock = blob(recW * 2 + 0.002, 0.028, 0.040, 0.0022, 2);
  body.add(sightBlock, 'steel', { y: bore + 0.008, z: zRecFront - 0.020 });
  sightBlock.dispose();
  const leaf = extrude(
    [
      [-0.014, 0],
      [0.014, 0],
      [0.014, 0.0125],
      [0.004, 0.0125],
      [0.0022, 0.0075],
      [-0.0022, 0.0075],
      [-0.004, 0.0125],
      [-0.014, 0.0125],
    ],
    0.0028,
    { bevel: 0.0005 }
  );
  body.add(leaf, 'steel_black', { y: bore + 0.020, z: rsZ, rx: -0.06 });
  leaf.dispose();
  // Graduated tangent slider on the ramp ahead of the notch.
  const slider = box(0.021, 0.006, 0.016, 0.0008, 1);
  body.add(slider, 'steel_black', { y: bore + 0.0185, z: rsZ - 0.026 });
  slider.dispose();

  // ---- barrel, gas system, muzzle -----------------------------------------
  addBarrel(body, 'steel_black', 'cavity', {
    y: bore,
    zBreech,
    zMuzzle: zBarrelEnd,
    rChamber: 0.0118,
    rBarrel,
    rGas: 0.0098,
    gasAt: gasZ,
    knurl: false,
  });

  /**
   * The gas block sits at 45 degrees and vents up and forward into the tube.
   * This block and the front sight block are the two "collars" on the barrel
   * that break up its length; without them the barrel reads as a dowel.
   */
  const gasBlock = extrude(
    [
      [-0.0125, -0.012],
      [0.0125, -0.012],
      [0.0125, 0.006],
      [0.008, 0.020],
      [-0.008, 0.020],
      [-0.0125, 0.006],
    ],
    0.030,
    { bevel: 0.0012 }
  );
  body.add(gasBlock, 'steel_soot', { y: bore + 0.004, z: gasZ, ry: Math.PI });
  gasBlock.dispose();
  // The gas port stub, canted forward the way an AK's is.
  const gasStub = rodZ(0.0092, 0.0084, 0.034, 14);
  body.add(gasStub, 'steel_soot', { y: bore + 0.020, z: gasZ - 0.008, rx: 0.62 });
  gasStub.dispose();
  addScrew(body, 'steel', 0.0128, bore + 0.002, gasZ - 0.008, 0.0022, 'x', 0.005);

  // Gas tube: from the block back into the rear sight block, with its ferrule.
  const tubeZ0 = gasZ - 0.006;
  const tubeZ1 = rsZ - 0.016;
  const gasTube = tubeZ(0.0106, 0.0088, tubeZ1 - tubeZ0, 16, 0.0004);
  body.add(gasTube, 'steel_black', { y: gasY, z: (tubeZ0 + tubeZ1) / 2 });
  gasTube.dispose();
  const tubeCollar = latheZ([[0, 0], [0, 0.0128], [0.014, 0.0128], [0.014, 0]], 16);
  body.add(tubeCollar, 'steel_black', { y: gasY, z: tubeZ1 - 0.014 });
  tubeCollar.dispose();

  // ---- front sight block + slant compensator -------------------------------
  const fsBlock = extrude(
    [
      [-0.0115, -0.010],
      [0.0115, -0.010],
      [0.0115, 0.008],
      [0.006, 0.014],
      [-0.006, 0.014],
      [-0.0115, 0.008],
    ],
    0.026,
    { bevel: 0.001 }
  );
  body.add(fsBlock, 'steel_black', { y: bore + 0.002, z: fsZ, ry: Math.PI });
  fsBlock.dispose();
  /**
   * Protective ears with the post between them — an AK's hooded post, open top.
   *
   * The ears are 8 mm THICK fore-aft on a 26 mm base, not 20: at 20 mm the near
   * ear was as deep as the base it stands on and the whole assembly merged into
   * one 26 x 62 mm slab with no daylight in it. What identifies an AK front
   * sight from the side is a narrow tower standing well proud of a wide base,
   * with a slot of sky between the ears.
   *
   * Post tip 26 mm over the bore against a rear notch 27.5 mm over it: the
   * sight line runs 0.24 degrees nose-down over the 356 mm radius, which is the
   * elevation an AK is zeroed with the leaf laid flat.
   */
  /**
   * 30 mm tall seated at bore+0.014, not 24 mm seated at bore+0.020.
   *
   * MEASURED (tools/measure-weapon-defects.mjs): the ears stood 2.4 mm clear of
   * every other part in the weapon — two steel fins hanging in mid-air over the
   * sight base, which is exactly the defect class that is invisible in a
   * screenshot because the gap is smaller than the highlight along the edge.
   * The base and the post boss both top out at bore+0.016, so the ears now start
   * 2 mm INSIDE that at bore+0.014 and are 6 mm taller to compensate, which
   * leaves the hood crown exactly where it was at bore+0.044. An ear is
   * machined out of the base on a real AK; it does not sit on top of it.
   */
  for (const sx of [-1, 1]) {
    const ear = extrude(
      [
        [-0.0026, 0],
        [0.0026, 0],
        [0.0026, 0.030],
        [-0.0026, 0.030],
      ],
      0.008,
      { bevel: 0.0006 }
    );
    body.add(ear, 'steel_black', { x: sx * 0.0086, y: bore + 0.014, z: fsZ, ry: Math.PI });
    ear.dispose();
  }
  /**
   * The post's TIP is the sight line's front end, so it is derived from the rear
   * notch and not eyeballed. The leaf's notch floor sits at bore + 0.0275; the
   * tip stops 0.5 mm under it, which over the 356 mm radius is 1.4 mrad of bore
   * elevation — the 100 m zero for 7.62x39 (35 mm of sight height plus ~110 mm
   * of drop at 100 m, over 100 m). MEASURED before: the tip was at bore + 0.026,
   * 1.5 mm low, i.e. 4.2 mrad — a 400 m hold with the leaf laid flat.
   */
  const post = rodZ(0.0016, 0.0013, 0.017, 8);
  body.add(post, 'steel_bright', { y: bore + 0.0185, z: fsZ, rx: Math.PI / 2 });
  post.dispose();
  // The threaded post carrier the ears sit on, so the tower is a tower and not
  // two fins growing out of the block.
  const fsBoss = rodZ(0.0048, 0.0048, 0.009, 12);
  body.add(fsBoss, 'steel_black', { y: bore + 0.0115, z: fsZ, rx: Math.PI / 2 });
  fsBoss.dispose();

  const muzzle = addMuzzleDevice(body, 'steel_soot', 'cavity', 'slant', zBarrelEnd, rBarrel, bore);
  // Muzzle-nut detent plunger under the front sight base — the small stud that
  // stops the brake unscrewing, and one of the few bright wear points forward.
  const detent = rodZ(0.0022, 0.0022, 0.006, 8);
  body.add(detent, 'steel_bright', { y: bore - 0.0125, z: fsZ - 0.009, rx: Math.PI / 2 });
  detent.dispose();

  /**
   * CLEANING ROD, and the channel that carries it.
   *
   * The rod lives in a groove under the barrel, captured by a notch in the
   * front sight base and threaded through a lug hanging off the bottom of the
   * gas block, then it disappears under the handguard. It used to hang 4.7 mm
   * clear of the barrel with nothing holding it, which is the definition of a
   * part that floats. Nested against the shank (rod radius 2.2 mm, barrel
   * radius 7.9 mm, so the axis sits 10.2 mm under the bore) it becomes a second
   * line under the barrel instead of a stray wire.
   */
  const rodY = bore - rBarrel - 0.0023;
  const rodFront = fsZ + 0.004;
  const rodRear = hgZ1 - 0.004;
  const rodLen = rodRear - rodFront;   // -Z is forward, so REAR minus FRONT
  const rod = rodZ(0.0022, 0.0022, rodLen, 8);
  body.add(rod, 'steel', { y: rodY, z: (rodFront + rodRear) / 2 });
  rod.dispose();
  // The channel: a dark relief between rod and barrel, so the pair reads as a
  // rod sitting IN something rather than glued on.
  const rodChannel = box(0.0052, 0.0030, rodLen - 0.02, 0.0004, 1);
  body.add(rodChannel, 'cavity', { y: rodY + 0.0026, z: (rodFront + rodRear) / 2 });
  rodChannel.dispose();
  // Gas-block lower lug, the eye the rod passes through.
  const rodLug = box(0.010, 0.014, 0.012, 0.0008, 1);
  body.add(rodLug, 'steel_soot', { y: bore - 0.016, z: gasZ + 0.004 });
  rodLug.dispose();

  // ---- wooden furniture ----------------------------------------------------
  /**
   * Lower handguard: a hollowed half-shell with a palm swell and a steel
   * ferrule at each end. The swell is what stops it reading as a plank.
   */
  const hgLen = hgZ1 - hgZ0;
  const lower = extrude(
    [
      [-0.0205, 0.004],
      [-0.0225, -0.010],
      [-0.0170, -0.026],
      [0, -0.031],
      [0.0170, -0.026],
      [0.0225, -0.010],
      [0.0205, 0.004],
    ],
    Math.abs(hgLen),
    { bevel: 0.0016 }
  );
  body.add(lower, 'wood', { y: bore - 0.004, z: (hgZ0 + hgZ1) / 2, ry: Math.PI });
  lower.dispose();
  /**
   * The two steel ferrules, one CAPPING each end of the wood.
   *
   * `latheZ` runs its profile 0 -> +12 mm, i.e. entirely REARWARD of wherever it
   * is placed. At `hgZ1 + 0.004` the front ferrule therefore landed at
   * z = -344..-332 with the handguard's front face at -348: 16 mm back from the
   * end it is supposed to cap, completely inside the timber and invisible. The
   * rear one at `hgZ0 - 0.004` happened to be right by the same accident.
   *
   * Both are now placed so 8 mm stands proud of the wood and 4 mm grips it,
   * which is what a ferrule is: -0.008 at the front (the lathe grows back onto
   * the wood) and -0.004 at the rear (it grows away from it).
   */
  for (const z of [hgZ0 - 0.004, hgZ1 - 0.008]) {
    const ferrule = latheZ([[0, 0], [0, 0.0245], [0.012, 0.0245], [0.012, 0]], 16);
    body.add(ferrule, 'steel', { y: bore - 0.010, z, sx: 1, sy: 0.9 });
    ferrule.dispose();
  }
  // Handguard retainer at the front ferrule: the sprung latch that locks the
  // whole assembly onto the barrel, and the rod's rear bearing.
  const retainer = box(0.026, 0.010, 0.014, 0.0009, 1);
  body.add(retainer, 'steel', { y: bore - 0.020, z: hgZ1 + 0.002 });
  retainer.dispose();
  // Upper handguard, wrapping the gas tube from the block back to the sight.
  const upLen = Math.abs((gasZ - 0.015) - (rsZ - 0.034));
  const upper = extrude(
    [
      [-0.0175, -0.004],
      [-0.0165, 0.010],
      [-0.010, 0.019],
      [0.010, 0.019],
      [0.0165, 0.010],
      [0.0175, -0.004],
    ],
    upLen,
    { bevel: 0.0014 }
  );
  body.add(upper, 'wood', { y: gasY - 0.004, z: (gasZ - 0.015 + rsZ - 0.034) / 2, ry: Math.PI });
  upper.dispose();

  // Pistol grip: bakelite/wood, raked less than an AR's.
  addPistolGrip(body, 'wood', 'rubber', { y: 0.030, z: 0.004, angle: 0.30, len: 0.100, w: 0.030 });

  /**
   * Fixed stock. The comb drops toward the butt and the toe kicks up — that
   * profile, plus the sling slot cut through the belly, is the AK's rear
   * silhouette. Authored as a side outline and extruded across its width.
   */
  /**
   * BUTT AT z = +0.295, not +0.315.
   *
   * MEASURED: with the butt plate at 0.317 its rear face landed at z = 323.1 and
   * the weapon measured 919 mm muzzle to butt against an AK-47's 870, +5.7%.
   * The barrel is right (408 mm breech to shoulder against a real 415, plus the
   * 45 mm slant brake), so the excess was all behind the trigger: 353 mm of pull
   * against the AKM's 332. Pulling the comb line back 20 mm puts the length of
   * pull on 333 mm exactly and the weapon on 899.
   */
  const stock = extrude(
    [
      [0.040, bore - 0.008],
      [0.115, bore - 0.004],
      [0.222, bore - 0.012],
      [0.295, bore - 0.024],
      [0.295, bore - 0.086],
      [0.228, bore - 0.082],
      [0.128, bore - 0.062],
      [0.044, bore - 0.044],
    ],
    0.034,
    { bevel: 0.0022, curveSegments: 1 }
  );
  // Authored in (z, y) and extruded across X, so it turns a quarter-turn about
  // Y to land: geometry +X becomes weapon +Z (rearward), and the extrusion —
  // which ExtrudeGeometry already centres — becomes the stock's width.
  stock.rotateY(-Math.PI / 2);
  body.add(stock, 'wood', {});
  stock.dispose();
  // Butt plate with its trap door.
  const plate = box(0.036, 0.064, 0.006, 0.0012, 1);
  body.add(plate, 'steel_black', { y: bore - 0.055, z: 0.297, rx: 0.10 });
  plate.dispose();
  // The rear sling loop is on the LEFT flank of the butt, not underneath it —
  // an AK is slung off its side so the rifle hangs flat against the chest.
  addSlingLoop(body, 'steel', -0.019, bore - 0.048, 0.150, 0.008, { ry: Math.PI / 2 });

  // ---- controls ------------------------------------------------------------
  /**
   * The selector lever: a stamped steel paddle as long as a finger, on the
   * RIGHT of the receiver, riding in the two safety notches. On an AK this is
   * a huge, instantly recognisable part — it doubles as the dust cover for the
   * charging slot when it is up.
   */
  const selector = new Assembly('ak-selector');
  const lever = extrude(
    [
      [-0.006, 0.030],
      [0.010, 0.028],
      [0.013, 0.008],
      [0.010, -0.048],
      [0.001, -0.052],
      [-0.006, -0.046],
      [-0.008, 0.006],
    ],
    0.0028,
    { bevel: 0.0006 }
  );
  selector.add(lever, 'steel_black', { x: recW + 0.003, y: bore - 0.006, z: -0.02, ry: Math.PI / 2 });
  lever.dispose();
  const leverBoss = rodZ(0.0055, 0.0055, 0.006, 12);
  selector.add(leverBoss, 'steel', { x: recW + 0.002, y: bore - 0.006, z: -0.02, ry: Math.PI / 2 });
  leverBoss.dispose();
  // The thumb tab: the lever's lower end is bent OUT, away from the receiver,
  // so it can be worked without barking a knuckle. That kink is what makes the
  // lever read as sheet metal rather than as a painted stripe.
  const leverTab = box(0.0075, 0.014, 0.010, 0.0008, 1);
  selector.add(leverTab, 'steel_black', { x: recW + 0.007, y: bore - 0.050, z: -0.021, rz: -0.35 });
  leverTab.dispose();

  /**
   * THE SELECTOR SHELF — the stamped ledge the lever rests on.
   *
   * A pressed rib along the top right of the receiver that stops the lever at
   * SAFE and closes the charging slot behind it. It is 45 mm of horizontal
   * shadow line half way up the flank, immediately under the cut, and without
   * it the right side of an AK is a blank plate with a lever floating on it.
   */
  const shelf = extrude(
    [
      [-0.024, 0],
      [0.024, 0],
      [0.021, 0.0055],
      [-0.021, 0.0055],
    ],
    0.0032,
    { bevel: 0.0006 }
  );
  body.add(shelf, 'steel_black', { x: recW + 0.0013, y: recTop - 0.019, z: -0.028, ry: Math.PI / 2 });
  shelf.dispose();
  /**
   * THE TWO DETENT NOTCHES the lever's tab drops into — SAFE at the top of its
   * travel and AUTO below it. They are pressed into the top edge of the right
   * flank, above the shelf and forward of the pivot, and they are the reason an
   * AK's selector clicks instead of sliding. Without them the busiest 45 mm of
   * the right side was a blank plate with a lever lying on it.
   *
   * Each straddles the 1.6 mm sheet — 1.2 mm proud, 2.8 mm into it — because a
   * cavity that sits entirely inside its host is invisible and one that stands
   * off it is a black tile. The band between the shelf's crown at y = 72.1 and
   * the receiver's top edge at 85 is 12.9 mm, which fits two 5.5 mm notches.
   */
  for (const [nz, ny] of [
    [-0.042, recTop - 0.0035],
    [-0.038, recTop - 0.0100],
  ]) {
    const notch = box(0.004, 0.0055, 0.0075, 0.0006, 1);
    body.add(notch, 'cavity', { x: recW - 0.0004, y: ny, z: nz });
    notch.dispose();
  }

  // Charging handle: part of the bolt carrier, sticking out to the right.
  const bolt = new Assembly('ak-bolt');
  const carrier = box(0.026, 0.020, 0.128, 0.0015, 1);
  bolt.add(carrier, 'steel', { y: bore + 0.004, z: -0.070 });
  carrier.dispose();
  const handle = extrude(
    [
      [-0.005, -0.004],
      [0.030, -0.006],
      [0.032, 0.004],
      [-0.005, 0.006],
    ],
    0.010,
    { bevel: 0.0009 }
  );
  /**
   * In battery the handle sits at the FRONT of its slot, above the magwell —
   * not at the back. At z = -0.016 it was in the same 20 mm of receiver as the
   * selector paddle and the two intersected; a real AK puts 80 mm between them,
   * which is what lets the selector close over the slot behind it.
   */
  /**
   * MATERIAL: `steel`, not `steel_bright`.
   *
   * This is the one part of the AK's mechanism that lives permanently outside
   * the receiver, 23 mm proud of the right flank at eye height, and in the
   * viewmodel it points straight at the camera. As `steel_bright` it measured as
   * the brightest object on the gun — the "bright chrome tube sticking sideways
   * out of the gas block" in the review. It is also the wrong finish: an AK
   * charging handle is the milled front end of the bolt carrier and it is
   * phosphated with everything else. Bare bright steel belongs on the bolt FACE
   * and the muzzle crown, which is where it still is.
   */
  bolt.add(handle, 'steel', { x: recW - 0.004, y: bore + 0.002, z: -0.098, rz: -0.12 });
  handle.dispose();
  /**
   * A round in the chamber, which starts at the bolt face. The cartridge is
   * authored base-at-0 running +Z, so ry=PI turns it muzzle-forward from the
   * breech; only the case head shows through the port.
   */
  const chamberRound = cartridge(0.0389, 0.0056, 0.0173);
  bolt.add(chamberRound.brass, 'brass', { z: zBreech, ry: Math.PI, y: bore });
  chamberRound.brass.dispose();
  chamberRound.bullet.dispose();

  // Trigger, in its stamped guard.
  const guardBar = box(0.030, 0.0035, 0.062, 0.0008, 1);
  body.add(guardBar, 'steel_black', { y: bore - 0.058, z: -0.028 });
  guardBar.dispose();
  for (const dz of [-0.056, 0.000]) {
    const post2 = box(0.030, 0.016, 0.004, 0.0008, 1);
    body.add(post2, 'steel_black', { y: bore - 0.048, z: dz });
    post2.dispose();
  }
  /**
   * THE MAGAZINE CATCH. A stamped paddle hinged across the receiver floor at
   * the back of the magwell, hanging down and rearward into the space in front
   * of the trigger guard. On an AK you rock the magazine out with it, so it is
   * a lever you can hook a finger behind — 20 mm of it standing clear of the
   * floor — not the button an AR has.
   */
  const catchPaddle = extrude(
    [
      [-0.008, 0.006],
      [0.010, 0.004],
      [0.011, -0.010],
      [-0.006, -0.013],
    ],
    0.011,
    { bevel: 0.0008 }
  );
  body.add(catchPaddle, 'steel_black', { y: recBot - 0.010, z: -0.056, ry: Math.PI / 2, rz: -0.5 });
  catchPaddle.dispose();
  addPin(body, 'steel', 0, recBot - 0.004, -0.062, 0.0018, 0.026);

  const trigger = new Assembly('ak-trigger');
  const trg = triggerPart('steel_bright');
  trigger.add(trg.geo, 'steel_bright', {});
  trg.geo.dispose();

  // ---- magazine ------------------------------------------------------------
  const magazine = new Assembly('ak-mag');
  const mag = buildMagazine(magazine, null, {
    // 24.5 x 70 mm steel body. The depth is set by the cartridge, not by taste:
    // 7.62x39 is 56 mm long and the top round has to lie inside the walls.
    w: 0.0245,
    // 63 mm front to back. 7.62x39 is 56 mm long, so this is the cartridge plus
    // 3.5 mm of wall each side; 70.5 was a rifle-magazine depth on a magazine
    // that is already the most-looked-at part of the weapon.
    d: 0.063,
    /**
     * 198 mm of DROP and 58 mm of forward offset at the toe.
     *
     * Derived from the stack, which is the only place the number exists: 30
     * rounds of 7.62x39 staggered at a 6.0 mm pitch is 180 mm of column, and the
     * follower and floorplate take it to about 198. `at()` maps `len` straight
     * onto the vertical drop, so this IS the drop, not an arc length.
     *
     * MEASURED at the old 232/72: the magazine's own AABB was 269 mm tall, and
     * seated 20 mm under the bore it put the weapon 328 mm from the top of the
     * handguard to the floorplate against a real AK's ~250 — a 31% error on the
     * one dimension a side-on silhouette is read by. 198/58 gives 30.4 degrees
     * of arc, which is the AKM's own bend, and 233 mm of magazine.
     */
    len: 0.198,
    curve: 0.058,
    segs: 10,
    witness: 0,
    caseLen: 0.0389,
    rimR: 0.0056,
    bulletLen: 0.0173,
    poly: 'steel_black',
  });
  /**
   * The front lug that hooks the magwell before the magazine rocks back, and the
   * rear catch shoulder the paddle holds. Both are derived from `mag.d` rather
   * than written as literals: at a fixed z they came adrift the moment the body
   * depth changed — with d dropped from 70.5 to 63 mm the lug would have hung
   * 4.5 mm off the front wall in clear air. Each now straddles its wall by
   * 1.5 mm, which is the weld a stamped lug actually has.
   */
  const lug = box(0.020, 0.010, 0.008, 0.0008, 1);
  magazine.add(lug, 'steel_black', { y: -0.012, z: -(mag.d * 0.5) - 0.0025 });
  lug.dispose();
  const magTooth = box(0.016, 0.012, 0.007, 0.0008, 1);
  magazine.add(magTooth, 'steel_black', { y: -0.030, z: mag.d * 0.5 + 0.0015 });
  magTooth.dispose();

  return {
    id: 'ak47',
    label: 'AK-47',
    fxClass: 'rifle',
    body,
    moving: { magazine, bolt, trigger, selector },
    nodes: {
      muzzle: [0, bore, muzzle.crownZ],
      chamber: [0, bore, zBreech],
      eject: [recW + 0.006, recTop - 0.012, -0.098],
      ejectDir: [0.9, 0.38, 0.22],
      sight: [0, bore + 0.024, rsZ],
      sightAxis: [0, 0, -1],
      ironSight: [0, bore + 0.024, rsZ],
      // Wrist targets. Same derivation as the carbine: the target is the WRIST,
      // 98 mm back along the finger direction from the knuckle contact.
      gripR: {
        pos: [0.0251, 0.055, 0.1185],
        finger: [0.05, -0.58, -0.813],
        back: [1, 0.03, 0.04],
      },
      // Support hand under the wooden handguard, thumb over the top.
      gripL: {
        pos: [-0.098, 0.0616, -0.262],
        finger: [0.8977, -0.3267, -0.2955],
        back: [-0.2784, -0.7648, 0.581],
      },
      handguard: { axis: [0, bore - 0.012, 0], dir: [0, 0, 1], r: 0.024, z0: hgZ0, z1: hgZ1 },
      // The feed lips sit 20 mm under the bore, which is where a 7.62x39 round
      // has to start if the bolt is going to strip it into the chamber.
      magSeat: { pos: [0, bore - 0.020, magZ], rot: [magTilt, 0, 0] },
      magDrop: [0, -0.34, -0.16],
      boltRest: { pos: [0, 0, 0], rot: [0, 0, 0] },
      boltTravel: [0, 0, 0.070],
      /**
       * MEASURED at bore-0.044: the blade's seated AABB was y[1.0, 27.0] while
       * the guard bar's top face is at y = 9.3 — 8 mm of trigger hanging out
       * through the BOTTOM of its own guard, which is worse than no trigger at
       * all. The loop's opening runs y 9.3 to 25.5 (bar top to post top), so
       * bore-0.0325 puts the finger pad at y = 12.5, ~3 mm clear of the bar.
       */
      triggerPivot: { pos: [0, bore - 0.0325, -0.030], rot: [0, 0, 0] },
      triggerPull: -0.32,
      selectorPivot: { pos: [0, 0, 0], rot: [0, 0, 0] },
    },
    shell: { caseLen: 0.0389, rimR: 0.0056 },
    magSize: { len: mag.len, w: mag.w, d: mag.d },
  };
}
