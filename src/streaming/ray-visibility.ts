/**
 * Ray-guided streaming (behind `?rayguide=1`): which finest-level brick cells
 * the raycaster actually entered recently. The compute shader sets one bit per
 * cell a ray enters before it terminates; the renderer reads that bitset back
 * every few frames and reports it here.
 *
 * Age is counted in rendered frames, not wall time: when the image has converged
 * the renderer stops, no readbacks arrive, and what was visible stays visible.
 * Frames rather than readbacks, so the window is the same whether a readback
 * covers one frame (TAA off) or several.
 */

import type { Vec3 } from '../core/pyramid.js';

/** Bits per word of the shader's visibility bitset (cell i → word i >> 5, bit i & 31). */
const WORD_BITS = 32;

export class RayVisibility {
  /** Frame count at the readback in which each cell was last seen (0 = never). */
  private readonly lastSeen: Uint32Array;
  private frame = 0;

  constructor(
    private readonly grid: Vec3,
    /** Frames a cell stays visible after it was last seen, so refinement can't thrash the cache. */
    private readonly holdFrames = 16,
  ) {
    this.lastSeen = new Uint32Array(grid[0] * grid[1] * grid[2]);
  }

  /** Number of u32 words the shader's bitset needs for this grid. */
  static wordCount(grid: Vec3): number {
    return Math.ceil((grid[0] * grid[1] * grid[2]) / WORD_BITS);
  }

  /** True once at least one readback arrived since construction or the last reset. */
  get ready(): boolean {
    return this.frame > 0;
  }

  /** Fold one readback in: bit i set ⇔ a ray entered cell i during the `frames` frames it covers. */
  report(bits: Uint32Array, frames = 1): void {
    this.frame += Math.max(1, frames);
    const cells = this.lastSeen.length;
    for (let w = 0; w < bits.length; w++) {
      let word = bits[w]!;
      while (word !== 0) {
        const low = word & -word;
        const cell = w * WORD_BITS + (31 - Math.clz32(low));
        if (cell < cells) this.lastSeen[cell] = this.frame;
        word ^= low;
      }
    }
  }

  /** Forget everything, e.g. when no rays are marched (slice mode). */
  reset(): void {
    this.frame = 0;
    this.lastSeen.fill(0);
  }

  /** Whether any cell of the box [base, base + span) was seen within the hold window. */
  anySeen(base: Vec3, span: Vec3): boolean {
    const [gx, gy, gz] = this.grid;
    const x1 = Math.min(base[0] + span[0], gx);
    const y1 = Math.min(base[1] + span[1], gy);
    const z1 = Math.min(base[2] + span[2], gz);
    // Seen within the window means lastSeen > oldest; 0 (never seen) never qualifies
    const oldest = Math.max(this.frame - this.holdFrames, 0);
    for (let z = base[2]; z < z1; z++) {
      for (let y = base[1]; y < y1; y++) {
        const row = (z * gy + y) * gx;
        for (let x = base[0]; x < x1; x++) {
          if (this.lastSeen[row + x]! > oldest) return true;
        }
      }
    }
    return false;
  }
}
