/**
 * Deterministic RNG (SplitMix32) with the interface the geometry kit expects.
 *
 * Set dressing must be identical for every player in a room and identical
 * between reloads — it is seeded off the map id, never off Math.random.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed(seed);
  }

  seed(s) {
    if (typeof s === 'string') {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      s = h;
    }
    this._s = (s >>> 0) || 1;
    return this;
  }

  float() {
    this._s = (this._s + 0x9e3779b9) >>> 0;
    let z = this._s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.float();
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  signed() {
    return this.float() * 2 - 1;
  }

  bool(p = 0.5) {
    return this.float() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.float() * arr.length) % arr.length];
  }

  fork(salt = 0) {
    return new Rng((this._s ^ (0x85ebca6b + salt * 0x9e3779b9)) >>> 0);
  }
}
