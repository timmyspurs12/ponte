/**
 * Phase 2B.1 — Deterministic SplitMix64 BigInt PRNG for reproducible synthetic
 * differential, property, and benchmark datasets.
 */

const MASK_64 = (1n << 64n) - 1n;

/** Fixed documented seed ("PONTE_2B" in big-endian ASCII = 0x504f4e54455f3242). */
export const DEFAULT_DIFFERENTIAL_SEED = 0x504f4e54455f3242n;
export const DEFAULT_BENCHMARK_SEED = 0x504f4e54455f424dn;

export class DeterministicPrng {
  private state: bigint;

  constructor(seed: bigint = DEFAULT_DIFFERENTIAL_SEED) {
    this.state = seed & MASK_64;
  }

  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  }

  nextU128(): bigint {
    const hi = this.nextU64();
    const lo = this.nextU64();
    return (hi << 64n) | lo;
  }

  /** Inclusive integer range [min, max] for small JS integer bounds. */
  intBetween(min: number, max: number): number {
    if (min > max) {
      throw new Error(`Invalid intBetween bounds: ${min} > ${max}`);
    }
    const span = BigInt(max - min + 1);
    const offset = Number(this.nextU64() % span);
    return min + offset;
  }

  /** Inclusive BigInt range [min, max]. */
  bigIntBetween(min: bigint, max: bigint): bigint {
    if (min > max) {
      throw new Error("Invalid bigIntBetween bounds");
    }
    const span = max - min + 1n;
    if (span <= MASK_64 + 1n) {
      return min + (this.nextU64() % span);
    }
    return min + (this.nextU128() % span);
  }

  /** Log-uniform U128 sampling across 1..128 bit widths to cover all scales. */
  sampleLogUniformU128(allowZero = false): bigint {
    if (allowZero && this.intBetween(0, 19) === 0) {
      return 0n;
    }
    const bits = this.intBetween(1, 128);
    if (bits === 128 && this.intBetween(0, 7) === 0) {
      return (1n << 128n) - 1n;
    }
    const mask = (1n << BigInt(bits)) - 1n;
    const raw = this.nextU128() & mask;
    return raw === 0n && !allowZero ? 1n : raw;
  }

  /** Generates a deterministic canonical lowercase 0x-prefixed bytes32 string. */
  nextBytes32(prefixByte?: number): string {
    const w0 = this.nextU64();
    const w1 = this.nextU64();
    const w2 = this.nextU64();
    const w3 = this.nextU64();
    let hex =
      w0.toString(16).padStart(16, "0") +
      w1.toString(16).padStart(16, "0") +
      w2.toString(16).padStart(16, "0") +
      w3.toString(16).padStart(16, "0");
    if (prefixByte !== undefined) {
      const p = (prefixByte & 0xff).toString(16).padStart(2, "0");
      hex = p + hex.slice(2);
    }
    return `0x${hex}`;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.intBetween(0, items.length - 1)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.intBetween(0, i);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }
}
