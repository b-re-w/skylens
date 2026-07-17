// Drone paths (PROJECT.md §4.1). The scene comes from whatever splat is loaded,
// so paths are GENERATED to cover the actual scene footprint: the XZ bounds are
// split into three strips (one drone each) and each drone flies a boustrophedon
// ("lawnmower") sweep over its strip at a fixed altitude. This guarantees the
// whole reconstruction reveals as drones scan — no gaps — and detections placed
// anywhere on the scene get revealed. Both computers derive from identical bounds.

import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { DronePath, Waypoint } from '../core/types';

const DURATION = 30; // seconds for one full sweep
const ZONE_NAMES = ['구역 A (서편)', '구역 B (중앙)', '구역 C (동편)'];

export function buildDronePaths(bounds: THREE.Box3): DronePath[] {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const minX = bounds.min.x;
  const minZ = bounds.min.z;
  const maxZ = bounds.max.z;

  // Constant scan altitude above the scene top.
  const flightY = bounds.max.y + THREE.MathUtils.clamp(size.y * 0.15, 2, 8);

  // Line spacing < 2*radius so adjacent sweep lines' reveal discs overlap.
  const spacing = Math.max(2, CONFIG.reveal.radius * 1.6);
  const stripW = size.x / 3;

  const paths: DronePath[] = [];
  for (let d = 0; d < 3; d++) {
    const stripMinX = minX + d * stripW;
    const nLines = Math.max(2, Math.ceil(stripW / spacing));
    const raw: Array<[number, number]> = []; // [x, z] before timing

    for (let k = 0; k < nLines; k++) {
      // Center the lines within the strip.
      const x = stripMinX + ((k + 0.5) / nLines) * stripW;
      // Alternate sweep direction for a continuous lawnmower.
      if (k % 2 === 0) {
        raw.push([x, minZ], [x, maxZ]);
      } else {
        raw.push([x, maxZ], [x, minZ]);
      }
    }

    const n = raw.length;
    const waypoints: Waypoint[] = raw.map(([x, z], i): Waypoint => {
      const t = n > 1 ? (i / (n - 1)) * DURATION : 0;
      // Look roughly downward, tilted along travel.
      const next = raw[Math.min(n - 1, i + 1)];
      const dz = next[1] - z;
      return { t, pos: [x, flightY, z], look: [0, -1, dz >= 0 ? 0.3 : -0.3] };
    });

    paths.push({ id: d + 1, zone: ZONE_NAMES[d], waypoints });
  }

  return paths;
}
