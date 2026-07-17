// Progressive reveal field for viewer 2 (§5.2). Consumes the lagged
// `state.visited` trail from the drone module and blooms nearby points of
// the full point cloud into visibility over CONFIG.reveal.fadeSeconds.
//
// Perf approach: brute-force distance test, but only against NEWLY-active
// visited spots each frame (not the whole trail), and only for points not
// already revealed. A coarse uniform grid buckets the cloud so each new
// visited spot only tests points in nearby cells instead of the full cloud.

import type { Visited } from '../core/types';
import { CONFIG } from '../core/config';
import { clamp } from '../core/math';

const CELL_SIZE = CONFIG.reveal.radius * 2;

export class RevealField {
  /** Per-point reveal progress in [0,1], written into the geometry's aReveal attribute. */
  readonly progress: Float32Array;
  /** Per-point revealed bitmask — true once bloom has started (progress may still be < 1). */
  private readonly started: Uint8Array;
  private readonly positions: Float32Array;
  private readonly count: number;

  /** Uniform grid: cell key -> point indices, for fast spatial lookup. */
  private readonly grid = new Map<string, number[]>();

  /** How many entries of state.visited we've already consumed. */
  private consumedVisited = 0;

  constructor(positions: Float32Array, count: number) {
    this.positions = positions;
    this.count = count;
    this.progress = new Float32Array(count);
    this.started = new Uint8Array(count);
    this.buildGrid();
  }

  private cellKey(x: number, y: number, z: number): string {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    return `${cx}_${cy}_${cz}`;
  }

  private buildGrid(): void {
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      const key = this.cellKey(this.positions[j], this.positions[j + 1], this.positions[j + 2]);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  /**
   * Advance reveal state. `visited` is the full trail (already lagged upstream
   * by the caller passing only entries with t <= now - lagSeconds), `now` is
   * sim time, `dt` is frame delta. Returns true if any progress values changed
   * (so the caller knows to mark the geometry attribute dirty).
   */
  update(visitedLagged: Visited[], now: number, dt: number): boolean {
    let dirty = false;

    // Activate bloom for any newly-lagged-in visited spots.
    if (this.consumedVisited < visitedLagged.length) {
      const radius = CONFIG.reveal.radius;
      const radiusSq = radius * radius;
      const cellRadius = Math.ceil(radius / CELL_SIZE);

      for (let vi = this.consumedVisited; vi < visitedLagged.length; vi++) {
        const spot = visitedLagged[vi];
        const [sx, sy, sz] = spot.pos;
        const cx = Math.floor(sx / CELL_SIZE);
        const cy = Math.floor(sy / CELL_SIZE);
        const cz = Math.floor(sz / CELL_SIZE);

        for (let gx = cx - cellRadius; gx <= cx + cellRadius; gx++) {
          for (let gy = cy - cellRadius; gy <= cy + cellRadius; gy++) {
            for (let gz = cz - cellRadius; gz <= cz + cellRadius; gz++) {
              const bucket = this.grid.get(`${gx}_${gy}_${gz}`);
              if (!bucket) continue;
              for (const pi of bucket) {
                if (this.started[pi]) continue;
                const j = pi * 3;
                const dx = this.positions[j] - sx;
                const dy = this.positions[j + 1] - sy;
                const dz = this.positions[j + 2] - sz;
                if (dx * dx + dy * dy + dz * dz <= radiusSq) {
                  this.started[pi] = 1;
                }
              }
            }
          }
        }
      }
      this.consumedVisited = visitedLagged.length;
      dirty = true;
    }

    // Fade any started-but-not-yet-full points toward 1.
    const fadeRate = dt / Math.max(1e-6, CONFIG.reveal.fadeSeconds);
    for (let i = 0; i < this.count; i++) {
      if (this.started[i] && this.progress[i] < 1) {
        this.progress[i] = clamp(this.progress[i] + fadeRate, 0, 1);
        dirty = true;
      }
    }

    void now;
    return dirty;
  }

  /** True if any point within `radius` of `pos` has begun revealing. */
  isAreaRevealed(pos: [number, number, number], radius = CONFIG.reveal.radius): boolean {
    const [sx, sy, sz] = pos;
    const radiusSq = radius * radius;
    const cellRadius = Math.ceil(radius / CELL_SIZE);
    const cx = Math.floor(sx / CELL_SIZE);
    const cy = Math.floor(sy / CELL_SIZE);
    const cz = Math.floor(sz / CELL_SIZE);

    for (let gx = cx - cellRadius; gx <= cx + cellRadius; gx++) {
      for (let gy = cy - cellRadius; gy <= cy + cellRadius; gy++) {
        for (let gz = cz - cellRadius; gz <= cz + cellRadius; gz++) {
          const bucket = this.grid.get(`${gx}_${gy}_${gz}`);
          if (!bucket) continue;
          for (const pi of bucket) {
            if (!this.started[pi]) continue;
            const j = pi * 3;
            const dx = this.positions[j] - sx;
            const dy = this.positions[j + 1] - sy;
            const dz = this.positions[j + 2] - sz;
            if (dx * dx + dy * dy + dz * dz <= radiusSq) return true;
          }
        }
      }
    }
    return false;
  }
}
