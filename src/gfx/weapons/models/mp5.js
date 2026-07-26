import { Assembly, alignZ, box, blob, extrude, latheZ, rodZ, tubeZ, ring } from '../geometry.js';
import {
  addBarrel,
  addMuzzleDevice,
  addPistolGrip,
  addPin,
  addSlingLoop,
  buildMagazine,
  triggerPart,
  cartridge,
} from '../parts.js';

/**
 * The MP5A2 — a roller-delayed 9 mm, and unmistakably that one.
 *
 * The features that make it an MP5 rather than "a submachine gun":
 *
 *   - the COCKING TUBE: a second tube WELDED along the upper left of the
 *     receiver — the two sections make a figure-of-eight seen end on — running
 *     the whole way forward to the front sight tower, with the cocking handle
 *     standing out of its front end at 45 degrees. Nothing else looks like this;
 *   - the hooded FRONT SIGHT TOWER, a ring on four posts on top of the barrel,
 *     tall enough to clear the cocking tube;
 *   - the ROTARY DRUM rear sight — a knurled 22 mm cylinder turning on a
 *     TRANSVERSE axis, with four apertures bored through it, on a tall base at
 *     the back of the receiver;
 *   - the flared stamped MAGWELL hanging under the receiver immediately behind
 *     the handguard, which is what puts an MP5's magazine so far forward;
 *   - a slim tapered handguard with the lower vent slot and finger scallops;
 *   - the polymer trigger group hanging under the receiver with the SEF
 *     selector, and the paddle magazine release behind the magwell;
 *   - a curved 30-round 9 mm magazine — slim, 33 mm deep because a 9 mm
 *     cartridge is only 29.7 mm long, and barely curved next to an AK's.
 *
 * REAL DIMENSIONS this is built to (MP5A2):
 *   overall length      680 mm      modelled 682
 *   barrel              225 mm      modelled 227
 *   sight radius        340 mm      modelled 340
 *   receiver tube        34 mm dia  modelled 34
 *   length of pull      330 mm      modelled 336
 *   handguard           195 mm      modelled 187
 *   magazine, 30 rd     222 x 24.5 x 33 mm
 *   9x19                case 19.2 mm, OAL 29.7 mm
 *
 * Layout (weapon-local metres, origin at the shooting hand's thumb web, bore
 * down -Z):
 *   bore axis        y = +0.062
 *   receiver         z = +0.020 .. -0.160
 *   magwell centre   z = -0.118
 *   handguard        z = -0.138 .. -0.325
 *   front sight      z = -0.332
 *   muzzle crown     z = -0.372
 *   butt plate       z = +0.310
 */
export function buildMP5() {
  const bore = 0.062;
  const rRec = 0.0170;
  const zRecRear = 0.020;
  const zRecFront = -0.160;
  /**
   * MAGWELL CENTRE, derived and not eyeballed: the well's FRONT wall has to sit
   * at the bolt face, because that is the only place a round can be stripped
   * into the chamber from. Bolt face at -0.145, well 34.5 mm deep, so the
   * centre lands at -0.126 — which is also why an MP5's magazine looks so far
   * forward, with 49 mm of daylight between it and the trigger guard for the
   * paddle to hang in.
   */
  const magZ = -0.126;
  /**
   * +3.4 degrees. An MP5's magazine is very nearly vertical — it leans forward
   * just enough to clear the trigger group — where the old -0.10 rad leaned it
   * BACKWARDS into the grip hand.
   */
  const magTilt = 0.06;
  const magW = 0.0245;
  const magD = 0.0345;
  const zBreech = -0.145;
  const zBarrelEnd = -0.330;
  const hgZ0 = -0.146;
  const hgZ1 = -0.325;
  /**
   * COCKING TUBE AXIS. 21 mm across, its centre 23.1 mm off the bore at 39
   * degrees from vertical, which sinks it 4.5 mm INTO the 34 mm receiver — a
   * welded joint. The old axis stood 3.2 mm clear of the receiver, so the most
   * recognisable feature on the weapon was a pipe floating beside it.
   */
  const cockR = 0.0106;
  const cockX = -0.0145;
  const cockY = bore + 0.0180;
  const fsZ = -0.332;
  const drumZ = 0.008;      // 340 mm behind the front post, per the HK drawing
  const zButt = 0.310;

  const body = new Assembly('mp5-body');

  // ---- receiver ------------------------------------------------------------
  /**
   * A stamped tube with a flattened bottom where the trigger group hangs. Built
   * as a lathe so the section is genuinely round — an MP5 receiver has no flats
   * on its flanks, and squaring it off is the fastest way to lose the read.
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
   * The receiver's FLAT BOTTOM and its weld beads.
   *
   * A 180 mm unbroken cylinder is the one shape that cannot avoid a continuous
   * specular sweep down its length, and measured against the flat-sided AK
   * receiver in the same rig the MP5's tube was reading as chrome pipe. A real
   * MP5 receiver is not a plain tube either: the sheet is folded flat under the
   * trigger group, and there is a rolled bead down each flank plus the two
   * pin bosses. Those breaks are what let the highlight terminate.
   */
  const recFloor = box(0.024, 0.0035, zRecRear - zRecFront - 0.010, 0.0008, 1);
  body.add(recFloor, 'steel_black', {
    y: bore - rRec + 0.0016,
    z: (zRecRear + zRecFront) / 2,
  });
  recFloor.dispose();
  for (const sx of [-1, 1]) {
    const bead = box(0.0024, 0.0038, zRecRear - zRecFront - 0.026, 0.0007, 1);
    body.add(bead, 'steel_black', {
      x: sx * (rRec - 0.0016),
      y: bore - rRec * 0.62,
      z: (zRecRear + zRecFront) / 2 - 0.004,
    });
    bead.dispose();
  }

  /**
   * Ejection port, with its front edge AT the bolt face. It was 93 mm behind
   * the chamber, which put the hole a case-and-a-half's travel away from
   * anything that could come out of it, and left the whole front half of the
   * receiver blank. The deflector stands proud just behind it.
   */
  const portZ = -0.122;
  const port = box(0.010, 0.019, 0.046, 0.0012, 1);
  body.add(port, 'cavity', { x: rRec - 0.0022, y: bore + 0.004, z: portZ });
  port.dispose();
  const deflector = extrude(
    [
      [-0.003, -0.008],
      [0.008, -0.005],
      [0.008, 0.006],
      [-0.003, 0.008],
    ],
    0.014,
    { bevel: 0.0008 }
  );
  body.add(deflector, 'steel_black', { x: rRec + 0.002, y: bore + 0.009, z: portZ + 0.032 });
  deflector.dispose();

  /**
   * THE MAGWELL — the part that was simply missing.
   *
   * An MP5 feeds through a flared stamped trumpet welded under the receiver,
   * immediately behind the handguard. Without it the magazine hung 18 mm clear
   * of the receiver's underside with a band of daylight between them, which is
   * the single most obvious "unfinished model" tell a weapon can have. It is
   * also what puts the magazine so far forward on this gun: the well is at the
   * FRONT of the exposed receiver, not under the ejection port.
   */
  const well = extrude(
    [
      [-magW * 0.5 - 0.0055, 0],
      [magW * 0.5 + 0.0055, 0],
      [magW * 0.5 + 0.0022, -0.030],
      [-magW * 0.5 - 0.0022, -0.030],
    ],
    magD + 0.010,
    { bevel: 0.0012 }
  );
  body.add(well, 'steel_black', { y: bore - rRec + 0.004, z: magZ, rx: magTilt });
  well.dispose();
  // The mouth's rolled lip, which is the shadow line that separates well from
  // magazine when the two are the same colour.
  const wellLip = extrude(
    [
      [-magW * 0.5 - 0.006, 0],
      [magW * 0.5 + 0.006, 0],
      [magW * 0.5 + 0.006, -0.005],
      [-magW * 0.5 - 0.006, -0.005],
    ],
    magD + 0.012,
    { bevel: 0.001 }
  );
  body.add(wellLip, 'steel_black', { y: bore - rRec - 0.026, z: magZ + 0.0016, rx: magTilt });
  wellLip.dispose();

  /**
   * The cocking tube and its handle. The tube is welded to the receiver at the
   * rear and to the front sight base at the front; the handle sits at its front
   * end, canted up and out, and drops into the 90-degree locking notch.
   */
  const cockRear = zRecRear - 0.024;
  const cockLen = cockRear - fsZ;
  const cockTube = tubeZ(cockR, cockR - 0.0016, cockLen, 18, 0.0004);
  body.add(cockTube, 'steel_black', { x: cockX, y: cockY, z: (fsZ + cockRear) / 2 });
  cockTube.dispose();
  /**
   * The cocking-lever support: the swollen housing at the front of the tube
   * that the handle actually pivots in. 55 mm behind the front sight, which is
   * where the shooting hand's thumb finds it on a real gun.
   */
  const cockShoe = blob(0.024, 0.022, 0.048, 0.0035, 3);
  body.add(cockShoe, 'steel_black', { x: cockX, y: cockY, z: fsZ + 0.040 });
  cockShoe.dispose();
  // The locking notch cut into the top of the support — the slot the handle is
  // pushed into to hold the bolt back.
  const notchCut = box(0.006, 0.008, 0.016, 0.0006, 1);
  body.add(notchCut, 'cavity', { x: cockX - 0.010, y: cockY + 0.009, z: fsZ + 0.058 });
  notchCut.dispose();

  /**
   * THE CHARGING-HANDLE SLOT — and it is what stops the cocking tube reading as
   * a chrome pipe laid along the receiver roof.
   *
   * MEASURED in the studio rig at a = 270 deg (left flank), exposure 1.0,
   * luminance = 0.2126R + 0.7152G + 0.0722B out of 255, sampled by raycasting
   * each pixel back to the surface it hit:
   *   cocking tube    med 16.9   p90 209.1   max 220.0     686 px
   *   receiver flank  med  5.4   p90 119.8   max 132.4     346 px
   *   polymer stock   med  2.1   p90  24.2   max  28.4     128 px
   * A p90 of 209 is very nearly clipped white. The peak is not the problem on its
   * own — the AK's own gas tube, the same 10.6 mm radius in the same material,
   * measures p90 175 / max 245 in this rig. The problem is UNBROKEN AREA: the
   * AK's tube shows 26 px because the wooden upper handguard, the tube collar and
   * the gas block chop it up, while this one presented 686 px of continuous
   * cylinder — 264 mm of it between the cocking shoe and the receiver with
   * nothing crossing it. The receiver tube below it was given a flat floor and
   * two rolled beads for exactly this reason (see the recFloor comment above);
   * the tube welded on top of it never got the same treatment.
   *
   * The fix is the feature a real MP5 has there and this model was missing: the
   * longitudinal slot the cocking lever's arm travels in, cut down the tube's
   * upper-left. It lands where it is needed, and that is derived rather than
   * hoped for — the key light is at (1.2, 1.6, 1.0) and the flank camera looks
   * along -X, so the specular bisector on the tube sits at a clock angle of about
   * 125 deg, and the handle's own bearing (`u` below) is 140 deg. The slot runs
   * along 140 deg, straight through the bright band.
   *
   * Straddling, per the rule addFlankRecess states: 0.3 mm proud of the skin so
   * it cannot z-fight, 2.6 mm in, which is through the tube's 1.6 mm wall.
   */
  /** The handle's bearing, in radians off +X. `u` below is (cos, sin) of this. */
  const cockClock = Math.atan2(0.643, -0.766);
  const slotProud = 0.0003;
  const slotT = slotProud + 0.0026;
  const slotR = cockR + slotProud - slotT * 0.5;
  // From the shoe's rear face (fsZ + 0.064) back to 10 mm short of the tube's
  // rear end, leaving both end faces of the tube intact.
  const slotZ0 = fsZ + 0.064;
  const slotZ1 = cockRear - 0.010;
  const cockSlot = box(slotT, 0.0070, slotZ1 - slotZ0, 0.0005, 1);
  body.add(cockSlot, 'cavity', {
    x: cockX + Math.cos(cockClock) * slotR,
    y: cockY + Math.sin(cockClock) * slotR,
    z: (slotZ0 + slotZ1) / 2,
    // A lone rz is unambiguous under Assembly's 'XYZ' order: it maps the box's
    // thin local +X onto the radial direction at `cockClock`.
    rz: cockClock,
  });
  cockSlot.dispose();

  /**
   * THE WELD FILLETS, on the two lines where the tube's skin actually crosses
   * the receiver's.
   *
   * Solved, not placed by eye. Tube axis (-14.5, 80.0) r 10.6, receiver axis
   * (0, 62.0) r 17.0, so the centres are 23.12 mm apart and the circles overlap
   * by 4.5 mm. The standard two-circle intersection gives a = 7.74 mm along the
   * centre line and h = 7.24 mm off it, which puts the two weld lines at
   * (-4.01, 78.51) and (-15.28, 69.44) — clock angles -8 and -94 deg on the tube.
   *
   * They matter for two reasons: a 1.2 mm bead half-buried in both parts is what
   * a welded joint looks like (the tube was interpenetrating the receiver with no
   * transition at all), and the outboard one at -94 deg lays a shadow line down
   * the full length of the tube on the side the flank camera sees, which is a
   * second interruption of the specular sweep for 96 triangles.
   */
  for (const [wx, wy] of [[-0.0040, 0.0785], [-0.0153, 0.0694]]) {
    const bead = rodZ(0.0012, 0.0012, cockLen - 0.020, 8);
    body.add(bead, 'steel_black', { x: wx, y: wy, z: (fsZ + cockRear) / 2 });
    bead.dispose();
  }

  /**
   * Weld boss at the tube's rear end. `latheZ` grows its profile REARWARD from
   * where it is placed, so -0.014 spans z -14..-4 mm, capping the tube's own rear
   * face — which was an open annulus standing in clear air above the receiver,
   * only partly covered by the drum base (x +/-11 mm against a tube reaching out
   * to x = -25 mm).
   */
  const cockBoss = latheZ([[0, 0], [0, cockR + 0.0014], [0.010, cockR + 0.0014], [0.010, 0]], 16);
  body.add(cockBoss, 'steel_black', { x: cockX, y: cockY, z: cockRear - 0.010 });
  cockBoss.dispose();

  /**
   * The cocking handle: a stubby lever, blued, with a flattened knurled paddle
   * on the end — not a chrome ball. Real HK handles are the same phosphate as
   * the tube they ride in, worn bright only on the face the hand slaps.
   */
  const charging = new Assembly('mp5-charging');
  /**
   * ONE DIRECTION VECTOR FOR THE WHOLE HANDLE, because `{ ry, rz }` cannot aim
   * an axial primitive: `Assembly.add` composes Euler 'XYZ', rz goes first, and
   * `rodZ`'s +Z axis is invariant under rz. MEASURED with the old
   * `{ ry: -PI/2, rz: -0.72 }`: the stalk lay dead flat along -X (y 85.8-96.2,
   * i.e. exactly its own 10.4 mm diameter) while the knob was hand-placed at the
   * end of the 41-degree cant the stalk never took — y 96.1-109.9, hanging off
   * the stalk's top edge. It also threw the knob out to x = -64.5, which with
   * the deflector at +27.8 put the MP5 at 92 mm across against a real 62.
   *
   * Everything now walks along `u` from a root ON the cocking tube's upper-left
   * surface, so the three pieces cannot come apart again, and the assembly is
   * sized to the real lever: 12 mm of stalk and a 16 mm paddle, which puts the
   * knob's outer face at x = -48.7 and the weapon at 76 mm across.
   */
  const u = [-0.766, 0.643, 0]; // 40 deg above horizontal, outboard and up
  const cr = [cockX - 0.0075, cockY + 0.0075, fsZ + 0.040]; // on the tube skin
  const at = (t) => ({ x: cr[0] + u[0] * t, y: cr[1] + u[1] * t, z: cr[2] + u[2] * t });
  const aim = alignZ(u[0], u[1], u[2]);
  const handleStalk = rodZ(0.0052, 0.0048, 0.012, 10);
  charging.add(handleStalk, 'steel_black', { ...at(0.006), ...aim });
  handleStalk.dispose();
  // Authored CENTRED on its own axis so it can be walked along `u` like the rest.
  const handleKnob = latheZ(
    [[-0.008, 0], [-0.008, 0.0068], [0.002, 0.0082], [0.008, 0.0074], [0.008, 0]],
    12
  );
  // Flattened across its own axis: the paddle is a disc you push with a thumb,
  // and a body of revolution left round reads as a doorknob. Baked into the
  // geometry rather than passed as `sy`, because after `aim` the part's own flat
  // is no longer on the weapon's Y.
  handleKnob.scale(1, 0.72, 1);
  charging.add(handleKnob, 'steel_black', { ...at(0.020), ...aim });
  handleKnob.dispose();
  const handleFace = box(0.010, 0.014, 0.0035, 0.0005, 1);
  charging.add(handleFace, 'steel_bright', { ...at(0.029), ...aim });
  handleFace.dispose();

  // ---- rotary drum rear sight ---------------------------------------------
  /**
   * 22 mm across the knurl and 16 mm wide, on a transverse axis: rotating the
   * drum swings a different one of its four bored apertures onto the sight
   * line. The old drum was 32 mm across and 24 mm wide — half again too big in
   * every direction, and it turned the back of the receiver into a cotton reel.
   */
  const drumR = 0.0112;
  const drumBase = blob(0.022, 0.024, 0.026, 0.003, 2);
  body.add(drumBase, 'steel_black', { y: bore + rRec + 0.006, z: drumZ });
  drumBase.dispose();
  const drum = latheZ(
    [
      [0, 0],
      [0, drumR - 0.0012],
      [0.003, drumR],
      [0.013, drumR],
      [0.016, drumR - 0.0012],
      [0.016, 0],
    ],
    18
  );
  body.add(drum, 'steel_black', {
    x: -0.008,
    y: bore + rRec + 0.018,
    z: drumZ,
    ry: Math.PI / 2,
  });
  drum.dispose();
  // The aperture facing the eye is a real hole bored through the drum.
  const aperture = tubeZ(0.0030, 0.0019, 0.018, 10, 0.0002);
  body.add(aperture, 'cavity', { y: bore + rRec + 0.018, z: drumZ });
  aperture.dispose();
  /**
   * The knurled lands between the drum's four numbered flats.
   *
   * PHOSPHATE, 0.7 mm PROUD, AND ONLY WHERE THEY CAN BE SEEN. All three of those
   * were wrong, and this drum is the closest geometry to the eye in ADS on this
   * weapon, so it is the one place on the MP5 where a 2 mm part is read at full
   * size.
   *
   * - `steel_bright` on a `steel_black` drum made eight polished tabs on a blued
   *   cylinder. An HK drum sight is phosphated with the rest of the receiver;
   *   bright bare steel on this gun belongs on the bolt face, the muzzle crown
   *   and the handle's thumb pad, which is where it still is.
   * - 2.2 mm thick on an 11.2 mm radius stood each land 1.1 mm proud — a tenth of
   *   the drum's radius. At the magnification a rear sight is actually inspected
   *   at, that is not knurling, it is eight blades sticking out of the wheel.
   *   1.4 mm gives 0.7 mm of relief, which still catches the key on its edge.
   * - The lower four were inside the drum BASE and always have been: the base is
   *   a 24 mm blob topping out at y = 97.0, the drum's axis is at y = 97.0, so
   *   every land with sin(a) < 0 sits below the base's crown and inside its
   *   22 x 26 mm footprint. Confirmed by tools/measure-weapon-defects.mjs, which
   *   reported them enclosed. Four lands, not eight.
   */
  const drumAxisY = bore + rRec + 0.018;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    if (Math.sin(a) < 0) continue; // buried in the drum base — see above
    const land = box(0.017, 0.0014, 0.0022, 0.0003, 1);
    body.add(land, 'steel', {
      y: drumAxisY + Math.sin(a) * drumR,
      z: drumZ + Math.cos(a) * drumR,
      rx: -a,
    });
    land.dispose();
  }

  // ---- barrel, front sight tower ------------------------------------------
  addBarrel(body, 'steel_black', 'cavity', {
    y: bore,
    zBreech,
    zMuzzle: zBarrelEnd,
    rChamber: 0.0122,
    rBarrel: 0.0072,
    rGas: 0.0072,
    // Same radius as the shank, so the station exists in the profile but
    // cannot be seen: a roller-delayed action has no gas system at all.
    gasAt: (zBreech + zBarrelEnd) * 0.5,
    knurl: false,
  });

  /**
   * The front sight: a ring hood carried on four posts over the barrel, tall
   * enough that the cocking tube passes under its left side. Built as a real
   * ring so daylight shows through it.
   */
  /**
   * SIGHT LINE, set by the rear aperture and then obeyed.
   *
   * The drum's aperture is bored at bore + rRec + 0.018 = 35 mm over the bore,
   * and everything at the front end is derived from that rather than eyeballed.
   * MEASURED before: the front post's tip was at 30 mm over the bore against a
   * 35 mm rear aperture — 5.0 mm of drop over the 340 mm sight radius, i.e.
   * 14.7 mrad of built-in error, which is a metre and a half low at 100 m.
   *
   * The post now stops 0.5 mm under the aperture centre. That is not zero on
   * purpose: sight height over bore is 35 mm and 9x19 drops ~110 mm by 100 m, so
   * a real 100 m zero wants the bore about 1.4 mrad above the line of sight, and
   * 0.5 mm over a 340 mm radius is exactly that.
   */
  const sightY = bore + rRec + 0.018;   // the rear aperture's own axis
  const fsTip = sightY - 0.0005;
  const towerBase = blob(0.026, 0.020, 0.030, 0.003, 2);
  body.add(towerBase, 'steel_black', { y: bore + 0.004, z: fsZ });
  towerBase.dispose();
  /**
   * The pillar between the base and the hood. Without it the hood ring floated
   * 14 mm above the tower with nothing under it — an MP5's most recognisable
   * front-end feature hanging in the air.
   */
  const fsPillar = box(0.010, 0.020, 0.022, 0.0008, 1);
  body.add(fsPillar, 'steel_black', { y: bore + 0.016, z: fsZ });
  fsPillar.dispose();
  /**
   * THE HOOD, standing UP.
   *
   * `ring()` is a torus built in the XY plane, i.e. its axis is already +Z —
   * pointing down the barrel, which is what a sight hood needs. The `rx: PI/2`
   * that used to be here swung that axis onto -Y and laid the ring flat:
   * MEASURED, a 28.6 x 3.6 x 28.2 mm halo lying horizontally over the barrel,
   * with the sight picture it is supposed to frame nowhere near it.
   */
  const hoodR = 0.0112;
  const hood = ring(hoodR, 0.0021, 18, 6);
  body.add(hood, 'steel_black', { y: fsTip, z: fsZ });
  hood.dispose();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const post = box(0.0026, 0.0026, 0.024, 0.0004, 1);
    body.add(post, 'steel_black', {
      x: Math.cos(a) * hoodR,
      y: fsTip + Math.sin(a) * hoodR,
      z: fsZ,
    });
    post.dispose();
  }
  // The post runs from inside the pillar up to the hood's centre: 24 mm of it,
  // so the tip lands on fsTip and the root is never in open air.
  const fsPost = rodZ(0.0014, 0.0012, 0.024, 8);
  body.add(fsPost, 'steel_bright', { y: fsTip - 0.012, z: fsZ, rx: Math.PI / 2 });
  fsPost.dispose();

  const muzzle = addMuzzleDevice(body, 'steel_soot', 'cavity', 'trilug', zBarrelEnd, 0.0072, bore);

  // A round in the chamber. Authored base-at-0 running +Z, so ry=PI turns it
  // muzzle-forward from the bolt face; only the case head shows in the port.
  const chamberRound = cartridge(0.0192, 0.00478, 0.0105);
  body.add(chamberRound.brass, 'brass', { z: zBreech, ry: Math.PI, y: bore });
  chamberRound.brass.dispose();
  chamberRound.bullet.dispose();

  // ---- handguard -----------------------------------------------------------
  /**
   * Slim, tapered, with a swell at the front and a vent slot along the bottom.
   * 43 mm across, not 52: an MP5's handguard is barely wider than the receiver
   * it hangs off, and the extra 9 mm was reading as a rifle forend.
   */
  const hg = extrude(
    [
      [-0.0185, 0.015],
      [-0.0215, -0.002],
      [-0.0170, -0.024],
      [0, -0.030],
      [0.0170, -0.024],
      [0.0215, -0.002],
      [0.0185, 0.015],
    ],
    Math.abs(hgZ1 - hgZ0),
    { bevel: 0.0022 }
  );
  body.add(hg, 'polymer', { y: bore - 0.002, z: (hgZ0 + hgZ1) / 2, ry: Math.PI });
  hg.dispose();
  // The handguard's rear collar clamps over the receiver's front trunnion.
  const hgCollar = latheZ([[0, 0], [0, 0.0208], [0.020, 0.0208], [0.020, 0]], 18);
  body.add(hgCollar, 'polymer', { y: bore, z: hgZ0 - 0.002 });
  hgCollar.dispose();
  const vent = box(0.014, 0.006, 0.090, 0.0008, 1);
  body.add(vent, 'cavity', { y: bore - 0.029, z: (hgZ0 + hgZ1) / 2 - 0.012 });
  vent.dispose();
  /**
   * FINGER GROOVES, and they are grooves rather than slots.
   *
   * On the wide handguard they are four scallops running ACROSS the underside
   * where the fingers wrap, each about 30 mm of arc — not three rectangles cut
   * into the flanks, which is where the hand never touches. Modelled as
   * transverse cylinders sunk into the lower shell, so each one leaves a
   * crescent of shadow with a highlight on the ridge between.
   */
  for (let i = 0; i < 4; i++) {
    // Axis ACROSS the weapon: ry=PI/2 maps the rod's +Z onto +X. rx would have
    // stood it on end, which is a hole in the handguard, not a finger groove.
    const groove = rodZ(0.0062, 0.0062, 0.040, 12);
    body.add(groove, 'cavity', {
      y: bore - 0.0305,
      z: hgZ0 - 0.040 - i * 0.032,
      ry: Math.PI / 2,
    });
    groove.dispose();
  }
  addPin(body, 'steel', 0, bore - 0.012, hgZ0 - 0.008, 0.0026, 0.040);

  // ---- trigger group + grip ------------------------------------------------
  /**
   * The polymer trigger housing is one part with the grip on an MP5, hanging
   * off two push pins under the receiver.
   */
  const housing = blob(0.030, 0.044, 0.108, 0.004, 3);
  body.add(housing, 'polymer', { y: bore - rRec - 0.019, z: -0.006 });
  housing.dispose();
  addPistolGrip(body, 'polymer', 'rubber', { y: 0.026, z: 0.010, angle: 0.34, len: 0.096, w: 0.030 });
  addPin(body, 'steel', 0, bore - rRec - 0.011, 0.036, 0.0028, 0.034);
  addPin(body, 'steel', 0, bore - rRec - 0.011, -0.048, 0.0028, 0.034);

  // SEF selector, both sides, with the three stamped positions.
  const selector = new Assembly('mp5-selector');
  const lever = extrude(
    [
      [-0.005, 0.004],
      [0.024, 0.002],
      [0.026, -0.006],
      [-0.005, -0.008],
    ],
    0.0055,
    { bevel: 0.0008 }
  );
  /**
   * AMBIDEXTROUS, AND BOTH LEVERS POINT THE SAME WAY.
   *
   * `ry: sx * PI/2` mirrors an asymmetric profile's THICKNESS but also its
   * SWEEP: MEASURED, the right lever ran z = -18.9..+13.3 (pointing forward) and
   * the left z = -5.3..+26.9 (pointing rearward) — the same control aimed in
   * opposite directions on the two sides of one gun. An HK SEF paddle sweeps
   * REARWARD and down from its pivot on both flanks, so both get -PI/2, which
   * maps the outline's +X onto +Z; the rz tilt is applied first and lives in the
   * outline's own plane, so it survives the turn identically on each side.
   */
  for (const sx of [-1, 1]) {
    selector.add(lever, 'polymer', {
      x: sx * 0.0165,
      y: bore - rRec - 0.013,
      z: 0.004,
      ry: -Math.PI / 2,
      rz: -0.5,
    });
  }
  lever.dispose();

  /**
   * THE PADDLE RELEASE — the HK lever, not a button.
   *
   * A 28 mm wide blade hinged across the back of the magwell and hanging into
   * the gap in front of the trigger guard, worked with the support hand's index
   * finger. The old part was a 16 mm tab with no hinge, which read as a chip of
   * plastic; the paddle's whole identity is that it is WIDE and that you can
   * see the pin it swings on.
   */
  const paddleZ = magZ + magD * 0.5 + 0.010;
  const paddleBoss = rodZ(0.0035, 0.0035, 0.030, 10);
  body.add(paddleBoss, 'steel_black', {
    y: bore - rRec - 0.012,
    z: paddleZ,
    ry: Math.PI / 2,
  });
  paddleBoss.dispose();
  const paddle = extrude(
    [
      [-0.005, 0.004],
      [0.006, 0.002],
      [0.008, -0.020],
      [0.001, -0.026],
      [-0.007, -0.022],
    ],
    0.028,
    { bevel: 0.0009 }
  );
  body.add(paddle, 'steel_black', {
    y: bore - rRec - 0.012,
    z: paddleZ,
    ry: Math.PI / 2,
    rz: -0.22,
  });
  paddle.dispose();

  const guardBar = box(0.028, 0.004, 0.056, 0.0008, 1);
  body.add(guardBar, 'polymer', { y: bore - rRec - 0.050, z: -0.026 });
  guardBar.dispose();
  for (const dz of [-0.052, 0.002]) {
    const wall = box(0.028, 0.022, 0.005, 0.0008, 1);
    body.add(wall, 'polymer', { y: bore - rRec - 0.040, z: dz });
    wall.dispose();
  }

  const trigger = new Assembly('mp5-trigger');
  const trg = triggerPart('steel_bright');
  trigger.add(trg.geo, 'steel_bright', {});
  trg.geo.dispose();

  // ---- fixed A2 stock ------------------------------------------------------
  /**
   * The solid polymer stock, not the A3's two rods.
   *
   * A retractable stock is two 7 mm tubes with 40 mm of daylight between them,
   * and at viewmodel distance that reads as an unfinished model rather than as
   * a stock — the eye sees the gap, not the rods. The A2 is equally correct for
   * an MP5, and it gives the weapon the rear mass its silhouette needs.
   *
   * 290 mm of it behind the receiver, which lands the butt 336 mm behind the
   * trigger: an MP5's length of pull, and 54 mm more than the stock used to
   * have. Authored as a side outline in (z, y) and extruded across the width.
   */
  const endCap = latheZ([[0, 0], [0, rRec], [0.014, rRec], [0.018, rRec * 0.8], [0.018, 0]], 18);
  body.add(endCap, 'steel_black', { y: bore, z: zRecRear });
  endCap.dispose();

  const stock = extrude(
    [
      [zRecRear - 0.004, bore + rRec - 0.002],
      [0.140, bore + rRec - 0.005],
      [0.268, bore + rRec - 0.011],
      [zButt, bore + rRec - 0.020],
      [zButt, bore - 0.050],
      [0.238, bore - 0.048],
      [0.136, bore - 0.032],
      [zRecRear + 0.006, bore - rRec - 0.004],
    ],
    0.038,
    { bevel: 0.0025 }
  );
  stock.rotateY(-Math.PI / 2);
  body.add(stock, 'polymer', {});
  stock.dispose();
  /**
   * The moulded recess down each flank and the sling slot through the belly.
   * A 290 mm slab of polymer with no relief in it is a wedge, and the eye reads
   * a wedge as unfinished geometry no matter how good the material is.
   */
  for (const sx of [-1, 1]) {
    const recess = extrude(
      [
        [-0.088, 0.014],
        [0.088, 0.008],
        [0.088, -0.012],
        [-0.088, -0.016],
      ],
      0.004,
      { bevel: 0.0009 }
    );
    body.add(recess, 'cavity', { x: sx * 0.0185, y: bore - 0.004, z: 0.180, ry: Math.PI / 2 });
    recess.dispose();
  }
  const slingSlot = box(0.026, 0.007, 0.032, 0.0009, 1);
  body.add(slingSlot, 'cavity', { y: bore - 0.042, z: 0.246 });
  slingSlot.dispose();

  const buttPlate = extrude(
    [
      [-0.020, bore + rRec - 0.020],
      [0.020, bore + rRec - 0.020],
      [0.021, bore - 0.022],
      [0.012, bore - 0.052],
      [-0.012, bore - 0.052],
      [-0.021, bore - 0.022],
    ],
    0.012,
    { bevel: 0.0018 }
  );
  body.add(buttPlate, 'rubber', { z: zButt + 0.004 });
  buttPlate.dispose();
  // Sling loop on the LEFT of the butt, the way an MP5 is actually carried.
  addSlingLoop(body, 'steel', -0.019, bore - 0.034, 0.240, 0.008, { ry: Math.PI / 2 });

  // ---- magazine ------------------------------------------------------------
  const magazine = new Assembly('mp5-mag');
  const mag = buildMagazine(magazine, null, {
    w: magW,
    /**
     * 34.5 mm deep. A 9x19 cartridge is 29.7 mm long, so this is the cartridge
     * plus its walls — the old 47 mm was a rifle magazine's depth and it made
     * the MP5's slimmest, most identifiable part read as a battle-rifle mag.
     */
    d: magD,
    /**
     * 185 mm of BODY, 200 mm with the floor plate buildMagazine hangs below it.
     * Derived rather than guessed: 30 rounds of 9x19 in a staggered column step
     * 5.8 mm each, so the stack is 168 mm, and the follower and base plate take
     * it to 200. That is also what keeps the weapon at 260 mm tall with a
     * magazine in — HK's own figure — instead of 306.
     *
     * 17 mm of forward offset at the toe: a 9 mm stack barely curves, 10
     * degrees of arc against an AK's 34.
     */
    len: 0.185,
    curve: 0.017,
    segs: 8,
    witness: 0,
    caseLen: 0.0192,
    rimR: 0.00478,
    bulletLen: 0.0105,
    poly: 'steel_black',
  });

  return {
    id: 'mp5',
    label: 'MP5',
    fxClass: 'smg',
    body,
    moving: { magazine, charging, trigger, selector },
    nodes: {
      muzzle: [0, bore, muzzle.crownZ],
      chamber: [0, bore, zBreech],
      eject: [rRec + 0.006, bore + 0.008, portZ],
      ejectDir: [0.9, 0.4, 0.2],
      sight: [0, bore + rRec + 0.018, drumZ],
      sightAxis: [0, 0, -1],
      ironSight: [0, bore + rRec + 0.018, drumZ],
      gripR: {
        pos: [0.0251, 0.050, 0.1105],
        finger: [0.05, -0.6, -0.798],
        back: [1, 0.03, 0.04],
      },
      // Support hand under the handguard, thumb up its left flank.
      gripL: {
        pos: [-0.092, 0.0508, -0.214],
        finger: [0.8977, -0.3267, -0.2955],
        back: [-0.2784, -0.7648, 0.581],
      },
      handguard: { axis: [0, bore - 0.004, 0], dir: [0, 0, 1], r: 0.021, z0: hgZ0, z1: hgZ1 },
      // The feed lips sit 10 mm under the bore, up inside the magwell, which is
      // where a 9 mm round has to start to be stripped by the bolt.
      magSeat: { pos: [0, bore - 0.010, magZ], rot: [magTilt, 0, 0] },
      magDrop: [0, -0.36, -0.06],
      chargeRest: { pos: [0, 0, 0], rot: [0, 0, 0] },
      chargePull: [0, 0, 0.062],
      triggerPivot: { pos: [0, bore - rRec - 0.028, -0.022], rot: [0, 0, 0] },
      triggerPull: -0.3,
      selectorPivot: { pos: [0, 0, 0], rot: [0, 0, 0] },
    },
    shell: { caseLen: 0.0192, rimR: 0.00478 },
    magSize: { len: mag.len, w: mag.w, d: mag.d },
  };
}
