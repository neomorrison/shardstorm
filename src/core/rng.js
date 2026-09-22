// Seeded PRNG (sfc32) with serializable state. Pure: safe in Node and the browser.
// Usage:
//   const rng = new Rng(12345);
//   rng.next()        -> float in [0, 1)
//   rng.range(a, b)   -> float in [a, b)
//   rng.int(n)        -> integer in [0, n)
//   rng.getState() / rng.setState(state)   (state is a plain array of 4 uint32)

// Hash any seed (number or string) into a uint32.
export function hashSeed(seed) {
  if (typeof seed === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  let x = Number(seed) || 0;
  // fold fractional/large numbers deterministically
  x = (Math.floor(x) ^ Math.floor(x / 4294967296)) >>> 0;
  return x;
}

function splitmix32(a) {
  return function () {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  constructor(seed = 1) {
    this.a = 0; this.b = 0; this.c = 0; this.d = 0;
    this.seed(seed);
  }

  seed(seed) {
    const sm = splitmix32(hashSeed(seed));
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 15; i++) this.u32();
  }

  u32() {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  next() { return this.u32() / 4294967296; }
  range(lo, hi) { return lo + (hi - lo) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  getState() { return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]; }
  setState(s) {
    this.a = s[0] | 0; this.b = s[1] | 0; this.c = s[2] | 0; this.d = s[3] | 0;
  }
}
