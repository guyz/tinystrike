import { Assembly, box, blob, extrude, latheZ, rodZ, tubeZ, serrations } from '../geometry.js';
import {
  addPistolGrip,
  addPin,
  addScrew,
  buildMagazine,
  triggerPart,
  cartridge,
} from '../parts.js';

/**
 * The .50 AE hand cannon — a Desert Eagle Mark XIX.
 *
 * This is a gas-operated, rotating-bolt pistol and it looks like nothing else:
 *
 *   - a TRIANGULAR slide — wide at the frame rails, narrowing to a flat top
 *     deck with a row of cooling cuts down each flank;
 *   - the BARREL RIB, a squared rail machined along the top of the barrel and
 *     grooved for a scope, running the barrel's 152 mm and stopping short of
 *     the slide's rear. It does not move with the slide, because the barrel
 *     does not;
 *   - the GAS CYLINDER slung under the barrel, running from a port near the
 *     muzzle back into the frame, and EXPOSED for the front 60 mm. On every
 *     other pistol that space is empty, and on this one it is the strongest
 *     line in the silhouette;
 *   - a squared barrel block with the ramped front sight on top of it and the
 *     muzzle crown standing proud of the slide;
 *   - a big square trigger guard, an exposed hammer, a slide stop on the left
 *     and a slide-mounted ambidextrous safety;
 *   - a straight, steep grip 57 mm across the straps, because a single-stack
 *     .50 AE magazine is 46 mm deep and has to fit inside it.
 *
 * REAL DIMENSIONS this is built to (Mark XIX, 6 inch):
 *   overall length      273 mm      modelled 277
 *   barrel              152 mm      modelled 152
 *   slide height         38 mm      modelled 40
 *   width                32 mm      modelled 34
 *   sight radius        216 mm      modelled 244
 *   magazine, 7 rd      112 x 24.5 x 46 mm
 *   .50 AE              case 32.6 mm, OAL 40.9 mm, case head 12.7 mm
 *
 * Layout (weapon-local metres, origin at the shooting hand's thumb web, bore
 * down -Z). The bore sits 44 mm up because the frame under it is enormous:
 *   bore axis        y = +0.044
 *   slide            z = +0.058 .. -0.198
 *   barrel + rib     z = -0.054 .. -0.206
 *   muzzle crown     z = -0.206
 *   magazine         z = +0.014, straight, 7 rounds
 */
export function buildDeagle() {
  const bore = 0.044;
  const slideRear = 0.058;
  /**
   * SLIDE FRONT, and it decides how much barrel the gun shows.
   *
   * A Mark XIX's barrel stands 30-35 mm proud of the slide — the squared block,
   * the front sight on the rib and the crown all live in that gap, and it is the
   * front third of the weapon's silhouette. At -0.198 only 8 mm of it was out,
   * so the block, the sight and the crown were all crowded into a slot and the
   * pistol read as slab-sided. -0.172 leaves 34 mm and puts the front sight
   * 20 mm CLEAR of the slide instead of 6 mm behind its face.
   */
  const slideFront = -0.172;
  const slideLen = slideRear - slideFront;
  /**
   * 26 mm across the rails, 19.6 mm across the deck.
   *
   * MEASURED at the old 0.0172/0.0108: 34.4 mm at the rails, which is wider than
   * a Mark XIX is anywhere — the catalogue's 1.25 in / 32 mm is the width over
   * the slide-mounted safety levers, and the slide itself is about 25. A slide
   * that wide is the reason the whole pistol read as a brick: it was 34 mm of
   * flat flank on a 40 mm section.
   */
  const wBot = 0.0130;    // half-width at the rails
  const wTop = 0.0098;    // half-width at the deck
  const hSlide = 0.040;
  const gripAngle = 0.28;
  const zBarrelRear = -0.054;   // 152 mm of barrel back from the crown
  const zMuzzle = -0.206;
  const zDustFront = -0.140;    // frame stops here; gas cylinder is bare ahead

  const body = new Assembly('deagle-frame');

  /* ---- frame ------------------------------------------------------------ */
  const frame = blob(0.030, 0.052, 0.106, 0.0035, 3);
  body.add(frame, 'alu', { y: bore - 0.036, z: 0.006 });
  frame.dispose();
  /**
   * Dust cover under the slide, carrying the rails forward — and STOPPING
   * 66 mm short of the muzzle. It used to run to within 33 mm of it and it is
   * 30 mm deep, so it swallowed the gas cylinder whole: the one feature that
   * makes this a gas-operated pistol was inside the frame for its entire
   * length and only its front cap was ever visible.
   */
  const dustLen = zDustFront * -1 - 0.047;
  const dust = extrude(
    [
      [-0.0126, 0.004],
      [0.0126, 0.004],
      [0.0126, -0.014],
      [0.0086, -0.019],
      [-0.0086, -0.019],
      [-0.0126, -0.014],
    ],
    dustLen,
    { bevel: 0.0012 }
  );
  body.add(dust, 'alu', { y: bore - 0.020, z: (zDustFront - 0.047) / 2 });
  dust.dispose();

  /* ---- gas cylinder ----------------------------------------------------- */
  /**
   * The tube under the barrel, 13 mm across, with its front cap and the port
   * block that ties it to the barrel. Its top is tangent to the barrel block's
   * underside so the two read as one machined assembly rather than a pipe
   * hanging in space, and 60 mm of it stands clear of the frame.
   */
  const rGas = 0.0066;
  const yGas = bore - 0.0115 - rGas;   // barrel block half-height 11.5 mm
  const gasTube = tubeZ(rGas, rGas - 0.0016, 0.120, 16, 0.0004);
  body.add(gasTube, 'steel_black', { y: yGas, z: -0.130 });
  gasTube.dispose();
  const gasCap = latheZ([[0, 0], [0, rGas + 0.0016], [0.010, rGas + 0.0016], [0.010, 0]], 16);
  body.add(gasCap, 'steel_black', { y: yGas, z: -0.190 });
  gasCap.dispose();
  // The port block: the bridge from cylinder up into the barrel's gas port.
  const portBlock = box(0.016, 0.014, 0.020, 0.0012, 1);
  body.add(portBlock, 'steel_black', { y: yGas + 0.006, z: -0.176 });
  portBlock.dispose();
  // Two operating-rod flats either side, so the underside is not one tube.
  for (const sx of [-1, 1]) {
    const flat = box(0.004, 0.009, 0.056, 0.0006, 1);
    body.add(flat, 'steel_black', { x: sx * (rGas + 0.0012), y: yGas + 0.002, z: -0.158 });
    flat.dispose();
  }

  /* ---- barrel + rib ------------------------------------------------------ */
  /**
   * A squared barrel with a polygonal bore, standing proud of the slide at the
   * muzzle. It is 152 mm long and its top rib carries the scope grooves.
   */
  const barrelBlock = box(0.021, 0.023, 0.056, 0.0016, 1);
  body.add(barrelBlock, 'steel_black', { y: bore + 0.001, z: -0.178 });
  barrelBlock.dispose();
  const crown = latheZ(
    [
      [0, 0.0056],
      [0, 0.0102],
      [0.008, 0.0102],
      [0.010, 0.0092],
      [0.010, 0.0056],
    ],
    18
  );
  // The lathe runs 10 mm along +Z and ry=PI turns it muzzle-forward, so it has
  // to be seated 10 mm BEHIND the crown plane or the barrel measures 162 mm.
  body.add(crown, 'steel_bright', { y: bore, z: zMuzzle + 0.010, ry: Math.PI });
  crown.dispose();
  /**
   * The bore, ending EXACTLY on the crown plane. A 40 mm tube centred at -0.188
   * ran to -0.208, i.e. 2 mm past the crown at -0.206: a black rod sticking out
   * of the muzzle, and the frontmost geometry on the whole weapon. Centred at
   * -0.186 it runs -0.206..-0.166 and stops flush inside the crown's annulus.
   */
  const boreHole = tubeZ(0.0064, 0.0048, 0.040, 14, 0.0003);
  body.add(boreHole, 'cavity', { y: bore, z: zMuzzle + 0.020 });
  boreHole.dispose();

  /**
   * THE BARREL RIB — on the BODY, not the slide, and 152 mm long rather than
   * the slide's 256.
   *
   * A Mark XIX carries its scope base on the barrel, so the rib is a fixed
   * part: when the slide cycles, the rib stays put and the deck runs under it.
   * Modelling it as a full-length feature of the slide got both facts wrong and
   * left the top of the gun as one unbroken 240 mm plate, which is the flattest
   * thing on the weapon and the one the eye lands on first.
   */
  /**
   * The slide's deck top is at y = bore + 0.022 (a 40 mm section centred 6 mm
   * over the bore), so the rib SITS AT bore + 0.024 and not bore + 0.0148 —
   * 8 mm lower and it is entirely inside the slide, which is where it was.
   */
  const yDeck = bore + 0.022;
  const ribLen = zBarrelRear - zMuzzle;
  // 1.4 mm of chamfer on a 4 mm section: a third of the rib's width stops
  // pointing straight up. A dead-flat up-facing land 13 mm wide and 150 mm long
  // catches the whole key lobe at once and reads as a white comb — the same
  // trap documented on picatinny() in geometry.js.
  // 11.8 mm wide, not 13.5: the deck it sits on is 19.6 mm now, and a rib that
  // leaves less than 3 mm of deck either side stops reading as a separate part.
  const rib = box(0.0118, 0.004, ribLen, 0.0014, 2);
  body.add(rib, 'steel_black', { y: yDeck + 0.002, z: (zBarrelRear + zMuzzle) / 2 });
  rib.dispose();
  // Weaver cross-grooves down the rib: 9 slots on a 15 mm pitch. This is the
  // only fine repeating pitch on the weapon and it is what gives the top deck
  // a scale reference.
  for (let i = 0; i < 9; i++) {
    const groove = box(0.0126, 0.0020, 0.0035, 0.0004, 1);
    body.add(groove, 'cavity', {
      y: yDeck + 0.0034,
      z: zMuzzle + 0.020 + i * 0.015,
    });
    groove.dispose();
  }
  /**
   * Front sight: a ramped blade on the rib, 20 mm ahead of the slide.
   *
   * Its REAR edge is the sighting edge and it is 7.2 mm tall, so the placement —
   * not the outline — sets the tip. At yDeck + 0.004 the tip landed at
   * bore + 0.0332 against a rear notch floor of bore + 0.0305: 2.7 mm HIGH over
   * a 244 mm sight radius, 11 mrad, which puts every shot 2.7 m low at 250 m and
   * a hand's width low at 25.
   *
   * bore + 0.0301 stops it 0.4 mm under the notch floor, which is the 25 m zero:
   * 30 mm of sight height plus ~5 mm of .50 AE drop, over 25 m, is 1.4 mrad of
   * bore elevation, and 1.4 mrad across 244 mm is 0.34 mm.
   */
  const fs = extrude(
    [
      [-0.0024, 0],
      [0.0024, 0],
      [0.0024, 0.0060],
      [-0.0024, 0.0072],
    ],
    0.008,
    { bevel: 0.0004 }
  );
  body.add(fs, 'steel_black', { y: bore + 0.0301 - 0.0072, z: -0.192 });
  fs.dispose();

  /* ---- trigger guard, controls ------------------------------------------ */
  /**
   * The squared guard, and it is a heavy one — 9 mm of section, not 6. A Desert
   * Eagle's trigger guard is a structural part of an aluminium frame carrying
   * a 1.6 kJ cartridge; at 6 mm it read as bent wire.
   */
  const guardFront = box(0.026, 0.030, 0.009, 0.0014, 1);
  body.add(guardFront, 'alu', { y: bore - 0.051, z: -0.0585 });
  guardFront.dispose();
  const guardBar = box(0.026, 0.009, 0.060, 0.0014, 1);
  body.add(guardBar, 'alu', { y: bore - 0.0625, z: -0.031 });
  guardBar.dispose();

  // Magazine release, LEFT side, immediately behind the trigger where a thumb
  // reaches it. ry=-PI/2 sends the lathe's +Z outboard, away from the frame.
  const magRelease = latheZ([[0, 0], [0, 0.0062], [0.004, 0.0068], [0.006, 0.0062], [0.006, 0]], 14);
  body.add(magRelease, 'steel_black', { x: -0.0158, y: bore - 0.032, z: -0.020, ry: -Math.PI / 2 });
  magRelease.dispose();
  /**
   * SLIDE STOP on the left, above the trigger — a 40 mm lever with a thumb pad
   * at its rear. It was missing, and its absence is conspicuous: it is the
   * longest single line on the left side of the frame.
   */
  const stopLever = extrude(
    [
      [-0.020, -0.0032],
      [0.014, -0.0040],
      [0.017, 0.0034],
      [-0.020, 0.0042],
    ],
    0.0034,
    { bevel: 0.0006 }
  );
  body.add(stopLever, 'steel_black', { x: -0.0155, y: bore - 0.014, z: -0.030, ry: -Math.PI / 2 });
  stopLever.dispose();
  const stopPad = box(0.0042, 0.011, 0.010, 0.0008, 1);
  body.add(stopPad, 'steel_black', { x: -0.0172, y: bore - 0.012, z: -0.012 });
  stopPad.dispose();
  addPin(body, 'steel', 0, bore - 0.030, -0.052, 0.0026, 0.030);

  /**
   * Exposed hammer at the rear of the frame. Authored in the (z, y) plane and
   * turned a quarter turn about Y, so its 6 mm THICKNESS lies across the gun
   * and its 16 mm depth runs fore and aft. Extruded straight it was a 12 mm
   * wide, 6 mm deep tab — a hammer laid on its side.
   */
  const hammer = extrude(
    [
      [-0.009, 0],
      [0.007, 0],
      [0.009, 0.014],
      [0.003, 0.021],
      [-0.008, 0.019],
      [-0.010, 0.008],
    ],
    0.0062,
    { bevel: 0.0008 }
  );
  hammer.rotateY(Math.PI / 2);
  body.add(hammer, 'steel', { y: bore + 0.004, z: 0.062, rx: 0.34 });
  hammer.dispose();
  // Hammer strut pin, so the spur has something to turn on.
  addPin(body, 'steel', 0, bore + 0.004, 0.058, 0.0022, 0.026);

  /**
   * The grip, 57 mm across the straps rather than 31. A .50 AE magazine is
   * 46 mm front to back; in a carbine-sized grip housing it stood 11 mm proud
   * of its own front strap. `depth` scales the strap spacing in addPistolGrip.
   */
  addPistolGrip(body, 'polymer', 'rubber', {
    y: bore - 0.030,
    z: 0.020,
    angle: gripAngle,
    len: 0.108,
    w: 0.032,
    depth: 1.82,
  });

  /* ---- slide (moving) ---------------------------------------------------- */
  const slideAsm = new Assembly('deagle-slide');
  /**
   * The triangular section: rails at the bottom, deck at the top. Authored once
   * as a section and extruded the length of the slide.
   *
   * MATERIAL: `steel_black`, not `steel_bright`. A Mark XIX ships in black
   * oxide, and the whole slide — body, serrations, rib — rendered in the bright
   * phosphate class made the largest part of the weapon read as chrome plate,
   * which is the single most-cited toy tell there is. The crown keeps
   * `steel_bright` because a muzzle really does wear back to white steel.
   */
  const slideBody = extrude(
    [
      [-wBot, -hSlide * 0.5],
      [wBot, -hSlide * 0.5],
      [wBot, -hSlide * 0.5 + 0.010],
      [wTop, hSlide * 0.5 - 0.004],
      [-wTop, hSlide * 0.5 - 0.004],
      [-wBot, -hSlide * 0.5 + 0.010],
    ],
    slideLen,
    { bevel: 0.0016 }
  );
  slideAsm.add(slideBody, 'steel_black', { y: bore + 0.006, z: (slideRear + slideFront) / 2 });
  slideBody.dispose();
  // The channel the fixed barrel rib runs in, down the middle of the deck.
  const ribSlot = box(0.0132, 0.004, slideLen * 0.96, 0.0005, 1);
  slideAsm.add(ribSlot, 'cavity', { y: bore + 0.0225, z: (slideRear + slideFront) / 2 });
  ribSlot.dispose();
  // Cooling cuts down each flank — six per side, the Deagle's other signature.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const cut = box(0.005, 0.014, 0.020, 0.0006, 1);
      slideAsm.add(cut, 'cavity', {
        x: sx * (wBot - 0.002),
        y: bore + 0.004,
        z: -0.150 + i * 0.030,
      });
      cut.dispose();
    }
  }
  // Rear cocking serrations.
  const ser = serrations(0.0268, 0.026, 0.044, 9, 0.0008, 'x');
  slideAsm.add(ser, 'steel_black', { y: bore + 0.008, z: slideRear - 0.026 });
  ser.dispose();
  /**
   * EJECTION PORT on the right of the slide, at the chamber — 45 x 22 mm with
   * a chamfered lip and the case head showing in it. The slide had no opening
   * at all, so the chambered round was buried inside a solid extrusion and the
   * flank was 256 mm of unbroken plate.
   */
  const portZ = -0.042;
  // The section is a trapezoid, so the flank's stand-off depends on HEIGHT: at
  // the port's y = bore + 0.009 the half-width interpolates half way from wBot to
  // wTop, i.e. 11.4 mm. The cavity's outer face sits 1.0 mm proud of that and it
  // cuts 8 mm in, which is what makes it read as an opening rather than as a
  // black plate bolted to the outside.
  const portX = (wBot + wTop) * 0.5;
  const portCav = box(0.008, 0.022, 0.045, 0.0009, 1);
  slideAsm.add(portCav, 'cavity', { x: portX - 0.003, y: bore + 0.009, z: portZ });
  portCav.dispose();
  const portLip = box(0.0028, 0.0030, 0.047, 0.0006, 1);
  slideAsm.add(portLip, 'steel_black', { x: portX + 0.0006, y: bore - 0.003, z: portZ });
  portLip.dispose();
  // Extractor claw at the port's rear edge.
  const extractor = box(0.0034, 0.007, 0.016, 0.0006, 1);
  slideAsm.add(extractor, 'steel_bright', { x: portX - 0.001, y: bore + 0.008, z: portZ + 0.028 });
  extractor.dispose();
  /**
   * Rear sight in its dovetail block. The blade used to start 4 mm above the
   * deck with nothing under it; the block is what a dovetailed sight actually
   * stands on, and it puts the notch floor at bore + 0.0305 — the same height
   * as the front blade's tip.
   */
  const rsBase = box(0.0196, 0.0045, 0.012, 0.0008, 1);
  slideAsm.add(rsBase, 'steel_black', { y: bore + 0.0243, z: slideRear - 0.006 });
  rsBase.dispose();
  const rearSight = extrude(
    [
      [-0.011, 0],
      [0.011, 0],
      [0.011, 0.009],
      [0.0022, 0.009],
      [0.0022, 0.0040],
      [-0.0022, 0.0040],
      [-0.0022, 0.009],
      [-0.011, 0.009],
    ],
    0.0055,
    { bevel: 0.0005 }
  );
  slideAsm.add(rearSight, 'steel_black', { y: bore + 0.0265, z: slideRear - 0.006 });
  rearSight.dispose();
  // Slide-mounted safety, both sides.
  const safety = extrude(
    [
      [-0.004, 0.004],
      [0.016, 0.002],
      [0.016, -0.005],
      [-0.004, -0.006],
    ],
    0.0045,
    { bevel: 0.0006 }
  );
  /**
   * BOTH SAFETY LEVERS SWEEP THE SAME WAY.
   *
   * `ry: sx * PI/2` mirrors an asymmetric outline's thickness but also its
   * SWEEP, so the two levers pointed in opposite directions along the slide —
   * measured 10 mm out of register fore-aft, on a control the player sees from
   * both sides as the weapon rolls in the inspect animation. A Mark XIX's
   * slide-mounted safety thumbpiece sweeps REARWARD from its pivot on both
   * flanks, which is -PI/2 (outline +X -> weapon +Z) for each of them; the rz
   * tilt is composed first and lives in the outline's own plane, so it survives
   * the turn identically on both sides.
   */
  for (const sx of [-1, 1]) {
    slideAsm.add(safety, 'steel_black', {
      x: sx * (wTop + 0.004),
      y: bore + 0.014,
      z: slideRear - 0.028,
      ry: -Math.PI / 2,
      rz: -0.3,
    });
  }
  safety.dispose();

  /* ---- magazine + trigger ------------------------------------------------ */
  const magazine = new Assembly('deagle-mag');
  const mag = buildMagazine(magazine, null, {
    w: 0.0245,
    /**
     * 46.2 mm front to back — a 40.9 mm cartridge plus its walls. At 36.8 the
     * top round's tip stood 15 mm outside the magazine's front wall, which is
     * a bullet growing out of the side of the magwell.
     */
    d: 0.0462,
    /**
     * 98 mm of BODY. buildMagazine hangs a floor plate, a finger ledge and a
     * base pad below `len`, which adds another 15 mm — so a 112 mm magazine
     * measures 127 and its toe stood 15 mm below the grip cap it seats against.
     * 98 + 15 is the 112 mm a 7-round .50 AE box actually is.
     */
    len: 0.098,
    // Single stack .50: it does not curve.
    curve: 0.002,
    segs: 4,
    witness: 0,
    caseLen: 0.0329,
    rimR: 0.00635,
    // 8.3 mm of bullet out of a 32.6 mm case is .50 AE's 40.9 mm overall.
    bulletLen: 0.0083,
    poly: 'steel_black',
  });

  const trigger = new Assembly('deagle-trigger');
  const trg = triggerPart('steel_bright');
  trigger.add(trg.geo, 'steel_bright', {});
  trg.geo.dispose();

  /**
   * The chambered round sits at the chamber — the rear of the 152 mm barrel —
   * so its head shows through the ejection port. It rides on the slide because
   * the extractor holds it there.
   */
  const chambered = cartridge(0.0329, 0.00635, 0.0083);
  slideAsm.add(chambered.brass, 'brass', { y: bore, z: zBarrelRear, ry: Math.PI });
  chambered.brass.dispose();
  chambered.bullet.dispose();

  return {
    id: 'deagle',
    label: 'Desert Eagle',
    fxClass: 'pistol',
    body,
    moving: { magazine, trigger, slide: slideAsm },
    nodes: {
      muzzle: [0, bore, zMuzzle],
      chamber: [0, bore, zBarrelRear],
      eject: [wBot + 0.004, bore + 0.009, portZ],
      ejectDir: [0.84, 0.5, 0.22],
      // The notch floor, which is what the eye actually lines up on.
      sight: [0, bore + 0.0305, slideRear - 0.006],
      sightAxis: [0, 0, -1],
      ironSight: [0, bore + 0.0305, slideRear - 0.006],
      gripR: {
        pos: [0.028, 0.006, 0.072],
        finger: [0, -0.315, -0.949],
        back: [0.98, 0, -0.2],
      },
      gripL: {
        pos: [-0.032, -0.010, 0.078],
        finger: [0.34, -0.28, -0.9],
        back: [0.15, 0.93, -0.33],
      },
      /**
       * The floorplate has to end level with the grip cap. At y = bore-0.044
       * the magazine hung 18 mm below the butt of the grip it lives in; the
       * grip cap sits 104 mm down the 0.28 rad rake from y = bore-0.030, and a
       * 112 mm magazine seated at bore-0.026 lands on it.
       */
      magSeat: { pos: [0, bore - 0.026, 0.014], rot: [-gripAngle, 0, 0] },
      magDrop: [0, -0.44, 0.06],
      slideRest: { pos: [0, 0, 0], rot: [0, 0, 0] },
      slideTravel: [0, 0, 0.030],
      triggerPivot: { pos: [0, bore - 0.036, -0.024], rot: [0, 0, 0] },
      triggerPull: -0.28,
    },
    shell: { caseLen: 0.0329, rimR: 0.00635 },
    magSize: { len: mag.len, w: mag.w, d: mag.d },
  };
}
