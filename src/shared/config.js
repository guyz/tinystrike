// Global gameplay constants. All distances in meters, times in seconds, speeds in m/s.
export const CONFIG = {
  TEAM: { CT: 'ct', T: 't' },

  MATCH: {
    WIN_ROUNDS: 8,          // first team to 8 round wins takes the match
    MAX_ROUNDS: 15,
    FREEZE_TIME: 6,         // buy/freeze phase at round start
    ROUND_TIME: 115,        // live phase length
    BOMB_TIME: 40,          // fuse after plant
    ROUND_END_TIME: 5,      // slack before next round
    PLANT_TIME: 3.2,        // seconds holding the plant
    DEFUSE_TIME: 10,        // without kit
    DEFUSE_TIME_KIT: 5,     // with kit
    BOTS_PER_TEAM: 5,       // T side bot count; CT side is player + (BOTS_PER_TEAM - 1)
  },

  ECON: {
    START_MONEY: 8000,
    MAX_MONEY: 16000,
    WIN_REWARD: 3250,
    LOSS_BASE: 1400,        // + LOSS_STEP per consecutive loss
    LOSS_STEP: 500,
    LOSS_MAX: 3400,
    PLANT_REWARD: 300,      // to player if their team planted
    DEFUSE_REWARD: 300,
    KIT_PRICE: 400,
    ARMOR_PRICE: 650,
  },

  PLAYER: {
    EYE_STAND: 1.62,
    EYE_CROUCH: 1.08,
    HEIGHT_STAND: 1.83,
    HEIGHT_CROUCH: 1.25,
    RADIUS: 0.35,
    RUN_SPEED: 5.2,         // scaled by weapon moveSpeedMult
    WALK_SPEED: 2.4,
    CROUCH_SPEED: 1.7,
    JUMP_VELOCITY: 4.4,   // apex ~0.48 m; + STEP_HEIGHT mantle clears 0.9 m crates
    GRAVITY: 20,
    ACCEL_GROUND: 60,
    ACCEL_AIR: 8,
    FRICTION_GROUND: 9,
    STEP_HEIGHT: 0.55,      // auto step-up for stairs
    MAX_HEALTH: 100,
    MAX_ARMOR: 100,
    FOV: 74,
  },

  BOT: {
    HEALTH: 100,
    RADIUS: 0.35,
    HEIGHT: 1.83,
    EYE: 1.62,
    RUN_SPEED: 4.6,
    TURN_SPEED: 8,          // rad/s aim smoothing
    REACTION_MIN: 0.22,     // seconds from spotting to first shot
    REACTION_MAX: 0.55,
    ENGAGE_RANGE: 45,
    HEAR_RANGE: 22,         // hears gunfire within this radius
    FOV_DEG: 110,
  },

  // Damage armor model: armored damage = dmg * 0.5, armor absorbs dmg * 0.5 * 0.5
  ARMOR_DAMAGE_SCALE: 0.5,
  HEADSHOT_LAYER: { HEAD: 'head', BODY: 'body', LEGS: 'legs' },
};
