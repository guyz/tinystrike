import { Assembly, box, blob, extrude, roundRect, latheZ, rodZ, tubeZ, dome, ring, mergeAll } from '../geometry.js';
import {
  addRail,
  addPistolGrip,
  addScrew,
  addPin,
  buildMagazine,
  buildMiniReflex,
  buildSlide,
  triggerPart,
  cartridge,
} from '../parts.js';

/**
 * The sidearm — a striker-fired polymer-framed 9 mm, slide-mounted mini reflex.
 *
 * A pistol is where proportion errors are most obvious, so the numbers are the
 * real ones: 183 mm slide, 26 mm across, bore 36 mm over the web of the hand,
 * 18-degree grip rake, 22 mm of slide travel.
 */
/**
 * @param {object} o variant controls — Tiny Strike derives three sidearms from
 *   this one frame (a striker-fired 9 mm, a hammer-fired .45 with a can, and a
 *   .50 hand cannon), because a pistol IS its proportions: slide length, slide
 *   mass and grip rake are what tell them apart at arm's length.
 */
export function buildPistol(o = {}) {
  const bore = 0.036;
  const slideH = o.slideH ?? 0.0248;
  const slideW = o.slideW ?? 0.0262;
  const slideLen = o.slideLen ?? 0.183;
  const zSlideRear = 0.052;
  const zSlideFront = zSlideRear - slideLen;
  const gripAngle = o.gripAngle ?? 0.32;
  const frameMat = o.frameMat ?? 'polymer';
  const slideMat = o.slideMat ?? 'steel_black';
  const reflexOn = o.reflex ?? false;
  const suppressor = o.suppressor ?? false;

  const body = new Assembly('pistol-frame');

  /* ---- frame ---------------------------------------------------------- */
  // Dust cover / frame rails under the slide.
  const dust = extrude(
    [
      [-slideW * 0.5 + 0.001, 0],
      [slideW * 0.5 - 0.001, 0],
      [slideW * 0.5 - 0.001, -0.0125],
      [slideW * 0.5 - 0.004, -0.016],
      [-slideW * 0.5 + 0.004, -0.016],
      [-slideW * 0.5 + 0.001, -0.0125],
    ],
    0.108,
    { bevel: 0.001 }
  );
  body.add(dust, frameMat, { y: bore - 0.0075, z: -0.062 });
  dust.dispose();

  // Frame body around the trigger and the magwell.
  const frameCore = blob(slideW - 0.001, 0.05, 0.062, 0.004, 3);
  body.add(frameCore, frameMat, { y: bore - 0.032, z: 0.012 });
  frameCore.dispose();

  // Beavertail / tang.
  const tang = extrude(
    [
      [-0.008, 0],
      [0.03, -0.004],
      [0.032, -0.012],
      [-0.008, -0.014],
    ],
    slideW - 0.003,
    { bevel: 0.0012 }
  );
  body.add(tang, 'polymer', { y: bore - 0.014, z: 0.034, ry: Math.PI / 2 });
  tang.dispose();

  /**
   * Accessory rail under the dust cover — teeth DOWN.
   *
   * `picatinny()` only builds teeth toward +Y, so this ran upside down AND
   * inside its host: MEASURED, the rail occupied y 13.5-18.5 mm while the dust
   * cover it hangs off occupies 11.5-29.5, i.e. the whole thing was buried in the
   * frame and not one tooth was visible from any angle.
   *
   * `down` mirrors it, and the crown plane is now derived from the host rather
   * than guessed: the cover's belly measures y = 11.5 (its outline stops at 12.5
   * and `extrude` grows it 1 mm outward with the bevel), and a 2.4 mm tooth
   * hanging under that puts the crown at 9.0 = bore - 0.027. The base plate then
   * sits flush up inside the polymer, which is how an integral frame rail is
   * moulded, and only the teeth break the silhouette.
   */
  addRail(body, 'polymer', -0.112, -0.058, bore - 0.027, 0, {
    down: true,
    width: 0.0175,
    waist: 0.013,
    baseH: 0.0026,
    topH: 0.0024,
    pitch: 0.0092,
    slot: 0.0046,
  });

  // Trigger guard: undercut, with a slight index ledge.
  const guardOuter = [
    [-0.024, 0],
    [0.026, 0],
    [0.028, -0.007],
    [0.024, -0.022],
    [0.013, -0.027],
    [-0.016, -0.027],
    [-0.024, -0.021],
  ];
  const guardInner = [
    [-0.019, -0.003],
    [0.021, -0.003],
    [0.0225, -0.009],
    [0.0185, -0.0205],
    [0.01, -0.0235],
    [-0.013, -0.0235],
    [-0.019, -0.0185],
  ];
  const guard = extrude(guardOuter, slideW - 0.004, { bevel: 0.001, holes: [guardInner] });
  /**
   * BAKE THE ROLL — the axis mistake geometry.js warns about, seventh instance.
   *
   * `guardOuter` is a SIDE view: its first coordinate is fore/aft (-24 to +28 mm)
   * and its second is up/down. Extruded and added with no rotation, that 52 mm
   * of fore/aft extent was lying ACROSS the weapon. MEASURED: the guard's AABB
   * was x[-25, +29] y[-16.5, +12.5] z[-41, -19] — a 54 mm-wide, 22 mm-deep slab
   * on a 26 mm slide, which is the whole of `body polymer x[-25, 29]` on both
   * the Glock and the USP: the "grip off-centre and 4x too thick", the "chunky
   * empty ring", and the trigger standing clear of a bow it was never inside.
   *
   * rotateY(+PI/2) maps the outline's (a, b, 0) to (0, b, -a), so the outline's
   * +x (the front of the bow) lands toward the muzzle at -Z and the extrusion
   * depth becomes the across-the-weapon width. 22.2 mm across a 26.2 mm slide,
   * which is what a polymer frame actually measures.
   */
  guard.rotateY(Math.PI / 2);
  body.add(guard, 'polymer', { y: bore - 0.0245, z: -0.03 });
  guard.dispose();

  /* ---- grip ----------------------------------------------------------- */
  addPistolGrip(body, 'polymer', 'rubber', {
    y: bore - 0.014,
    z: 0.016,
    angle: gripAngle,
    len: 0.113,
    w: 0.0305,
  });
  // Stippling: a field of tiny raised pyramids on both side panels.
  const stipple = [];
  for (let r = 0; r < 9; r++) {
    for (let cIdx = 0; cIdx < 5; cIdx++) {
      const g = box(0.0024, 0.0024, 0.0009, 0.0003, 1);
      g.translate(-0.005 + cIdx * 0.0026 + (r % 2) * 0.0013, -0.012 - r * 0.0072, 0);
      stipple.push(g);
    }
  }
  const stippleG = mergeAll(stipple);
  for (const sx of [-1, 1]) {
    body.add(stippleG, 'polymer', {
      x: sx * 0.0152,
      y: bore - 0.016,
      z: 0.017,
      ry: sx * Math.PI * 0.5,
      rx: 0,
      rz: sx > 0 ? -gripAngle : gripAngle,
    });
  }
  stippleG.dispose();

  // Magazine release, slide stop lever, takedown lever.
  const relButton = latheZ(
    [
      [0, 0],
      [0, 0.0042],
      [0.0015, 0.0048],
      [0.0038, 0.0048],
      [0.0038, 0],
    ],
    12
  );
  body.add(relButton, 'polymer', { x: 0.0138, y: bore - 0.032, z: -0.014, ry: Math.PI / 2 });
  relButton.dispose();
  const stopLever = extrude(
    [
      [-0.014, -0.0028],
      [0.012, -0.0035],
      [0.014, 0.0028],
      [-0.014, 0.0035],
    ],
    0.0032,
    { bevel: 0.0005 }
  );
  body.add(stopLever, 'steel', { x: -0.0132, y: bore - 0.0135, z: -0.022, ry: Math.PI / 2 });
  body.add(stopLever, 'steel', { x: 0.0132, y: bore - 0.0135, z: -0.022, ry: Math.PI / 2 });
  stopLever.dispose();
  const takedown = latheZ(
    [
      [0, 0],
      [0, 0.0035],
      [0.0022, 0.004],
      [0.0022, 0],
    ],
    12
  );
  body.add(takedown, 'steel', { x: -0.0138, y: bore - 0.0175, z: -0.046, ry: -Math.PI / 2 });
  takedown.dispose();

  /* ---- barrel, exposed at the muzzle, plus the recoil spring ---------- */
  const barrel = latheZ(
    [
      [0, 0],
      [0, 0.0082],
      [0.0016, 0.0088],
      [0.006, 0.0088],
      [0.0072, 0.0078],
      [0.0072, 0.0048],
    ],
    18
  );
  body.add(barrel, 'steel_bright', { y: bore, z: zSlideFront + 0.0012, ry: Math.PI });
  barrel.dispose();
  const boreHole = tubeZ(0.0048, 0.0034, 0.03, 12, 0.0002);
  body.add(boreHole, 'cavity', { y: bore, z: zSlideFront + 0.012 });
  boreHole.dispose();
  const spring = latheZ(
    [
      [0, 0.0032],
      [0, 0.0048],
      [0.004, 0.0048],
      [0.004, 0.0032],
    ],
    12
  );
  body.add(spring, 'steel_bright', { y: bore - 0.0125, z: zSlideFront + 0.0025 });
  spring.dispose();

  /* ---- moving parts --------------------------------------------------- */
  const slideAsm = new Assembly('pistol-slide');
  const slide = buildSlide(slideAsm, {
    w: slideW,
    h: slideH,
    len: slideLen,
    // Nitrided, not bare steel: a slide is one big flat facing the sky.
    mat: slideMat,
    zRear: zSlideRear,
  });
  // Slide-mounted mini reflex, in a milled pocket behind the rear sight.
  const reflex = reflexOn
    ? buildMiniReflex(slideAsm, {
        w: 0.0246,
        h: 0.021,
        len: 0.0455,
        y: slideH * 0.5 + 0.0018,
        z: zSlideRear - 0.038,
        matBody: 'alu_fine',
      })
    : null;
  const opticY = reflexOn
    ? bore + slideH * 0.5 + 0.0018 + 0.021 * 0.56
    : bore + slideH * 0.5 + 0.0065;
  const opticZ = reflexOn ? zSlideRear - 0.038 + 0.0455 * 0.14 : zSlideRear - 0.012;

  /**
   * A screw-on suppressor. Real proportions: 190 mm long, 34 mm across, with a
   * visible thread collar and a stepped front cap — that step is what keeps it
   * from reading as a length of pipe glued to the muzzle.
   */
  let muzzleZ = zSlideFront - 0.004;
  if (suppressor) {
    const len = o.suppressorLen ?? 0.148;
    const r = 0.017;
    /**
     * THE CAN THREADS ONTO THE BARREL, so 14 mm of it is BEHIND the slide's
     * front face, not in front of it.
     *
     * A tactical pistol's threaded barrel stands ~13 mm proud of the slide and
     * the suppressor's rear collar screws down over it. Hung off the front face
     * instead, every millimetre of the can's 148 mm is added to the gun's length:
     * MEASURED, the USP came out at 369 mm against a real 340 (+8.4%, the worst
     * dimensional error in the rack) with `z[-302 .. +67]`. Sinking the collar 14
     * mm takes it to 355 and, more to the point, makes the join a threaded
     * shoulder instead of a butt joint.
     */
    const thread = 0.014;
    const collar = latheZ([[0, 0], [0, 0.0108], [0.008, 0.0125], [0.018, 0.0125], [0.018, 0]], 18);
    body.add(collar, 'steel', { y: bore, z: zSlideFront + thread + 0.002, ry: Math.PI });
    collar.dispose();
    const canBody = latheZ(
      [[0, 0], [0, r], [len - 0.012, r], [len - 0.006, r - 0.0022], [len, r - 0.0032], [len, 0]],
      22
    );
    body.add(canBody, 'steel_black', { y: bore, z: zSlideFront + thread - 0.012, ry: Math.PI });
    canBody.dispose();
    // The bore through the front cap. Without the cavity the can reads solid.
    const canBore = tubeZ(0.0052, 0.0038, 0.028, 12, 0.0002);
    body.add(canBore, 'cavity', { y: bore, z: zSlideFront + thread - len + 0.002 });
    canBore.dispose();
    // Knurled grip band, so the tube has a scale reference on it.
    for (let i = 0; i < 3; i++) {
      const band = tubeZ(r + 0.0006, r - 0.001, 0.006, 20, 0.0002);
      body.add(band, 'steel', { y: bore, z: zSlideFront + thread - 0.04 - i * 0.03 });
      band.dispose();
    }
    muzzleZ = zSlideFront + thread - len - 0.006;
  }

  const magazine = new Assembly('pistol-mag');
  const mag = buildMagazine(magazine, null, {
    w: 0.0212,
    d: 0.0295,
    /**
     * 95 mm of body, which is 114 mm overall once buildMagazine adds the feed
     * lips and the floorplate.
     *
     * MEASURED at 108: the magazine's overall length was 127 mm and, seated, its
     * floorplate sat at y = -113 against a grip toe at y = -92 — 21 mm of
     * magazine hanging out of the bottom of a grip that is 113 mm long. A real
     * 17-round 9 mm magazine is 114 mm and its floorplate stands ~5 mm proud;
     * that is the whole of the "magazine hangs below a grip it isn't inside"
     * verdict, and it is a length error, not a seat error — raising the seat
     * instead would have pushed the feed lips up into the breech face.
     */
    len: 0.095,
    curve: 0.004,
    segs: 5,
    witness: 3,
    caseLen: 0.0192,
    rimR: 0.00478,
    bulletLen: 0.0132,
    poly: 'polymer',
  });

  const trigger = new Assembly('pistol-trigger');
  const trg = triggerPart(frameMat);
  trigger.add(trg.geo, frameMat, {});
  trg.geo.dispose();
  // The trigger safety blade down the middle of the face.
  const blade = extrude(
    [
      [-0.0022, 0.003],
      [0.0022, 0.003],
      [0.0022, -0.016],
      [-0.0022, -0.017],
    ],
    0.0028,
    { bevel: 0.0004 }
  );
  trigger.add(blade, 'steel', { x: 0, y: -0.001, z: 0.0022 });
  blade.dispose();

  return {
    id: o.id ?? 'pistol',
    label: o.label ?? 'P-19',
    fxClass: 'pistol',
    body,
    moving: { magazine, trigger, slide: slideAsm },
    nodes: {
      muzzle: [0, bore, muzzleZ],
      chamber: [0, bore, zSlideRear - 0.05],
      eject: [slideW * 0.5 + 0.004, bore + 0.005, zSlideRear - 0.05],
      ejectDir: [0.82, 0.52, 0.24],
      sight: [0, opticY, opticZ],
      sightAxis: [0, 0, -1],
      ironSight: [0, bore + slideH * 0.5 + 0.0065, zSlideRear - 0.012],
      // Wrist targets (see models/rifle.js for the derivation).
      gripR: {
        pos: [0.028, 0.003, 0.07],
        finger: [0, -0.315, -0.949],
        back: [0.98, 0, -0.2],
      },
      /** Support hand cups the firing hand rather than the frame. */
      gripL: {
        pos: [-0.03, -0.012, 0.076],
        finger: [0.34, -0.28, -0.9],
        back: [0.15, 0.93, -0.33],
      },
      magSeat: { pos: [0, bore - 0.03, 0.019], rot: [-gripAngle, 0, 0] },
      magDrop: [0, -0.42, 0.05],
      slideRest: { pos: [0, bore, 0], rot: [0, 0, 0] },
      slideTravel: [0, 0, 0.0225],
      /**
       * The blade has to hang INSIDE the bow.
       *
       * MEASURED at bore-0.0135: the trigger's seated AABB was y[1.5, 27.7]
       * while the guard's inner opening is y[8.5, -12] — i.e. 26 of the blade's
       * 28 mm were up inside the frame and 1.5 mm of tip showed at the very top
       * of the loop. From straight on the guard read as an empty ring, which is
       * the "no trigger" verdict on both pistols. 8 mm lower puts the finger pad
       * at y = -6.5, a third of the way up a 20 mm opening, where a finger goes.
       */
      triggerPivot: { pos: [0, bore - 0.0215, -0.0165], rot: [0, 0, 0] },
      triggerPull: -0.3,
      opticGlass: reflex,
      slideGeom: slide,
    },
    shell: { caseLen: 0.0192, rimR: 0.00478 },
    magSize: { len: mag.len, w: mag.w, d: mag.d },
  };
}
