// Preset drone paths (PROJECT.md §4.1). The scene now comes from whatever splat
// is loaded, so paths are derived: authored template curves (normalized to a
// half-extent of 24 on X/Z) are fitted to the actual scene bounds and flown at a
// band above the scene top. Both computers derive from identical bounds, so the
// paths match.

import * as THREE from 'three';
import type { DronePath, Waypoint } from '../core/types';

const AUTHOR_HALF = 24;

interface Template {
  zone: string;
  /** Normalized waypoints: x/z in ~[-24..24], y in ~[8..14] (flight band). */
  points: Waypoint[];
}

const TEMPLATES: Template[] = [
  {
    zone: '구역 A (서편)',
    points: [
      { t: 0, pos: [-22, 10, -20], look: [1, -0.2, 0.3] },
      { t: 6, pos: [-14, 9, -6], look: [1, -0.2, 0.4] },
      { t: 12, pos: [-10, 8, 6], look: [0.5, -0.1, 1] },
      { t: 18, pos: [-16, 9, 16], look: [-0.3, 0, 1] },
      { t: 24, pos: [-6, 11, 18], look: [1, -0.1, 0.2] },
      { t: 30, pos: [-2, 12, 6], look: [0.2, -0.2, -1] },
    ],
  },
  {
    zone: '구역 B (동편)',
    points: [
      { t: 0, pos: [22, 11, -18], look: [-1, -0.2, 0.3] },
      { t: 6, pos: [12, 10, -8], look: [-0.6, -0.1, 0.6] },
      { t: 12, pos: [9, 9, 4], look: [0, -0.1, 1] },
      { t: 18, pos: [16, 10, 14], look: [-0.4, -0.1, 0.6] },
      { t: 24, pos: [6, 12, 16], look: [-1, -0.2, -0.2] },
      { t: 30, pos: [3, 13, 4], look: [-0.2, -0.2, -1] },
    ],
  },
  {
    zone: '구역 C (중앙/남)',
    points: [
      { t: 0, pos: [0, 14, -22], look: [0, -0.3, 1] },
      { t: 6, pos: [-4, 12, -12], look: [0.3, -0.2, 1] },
      { t: 12, pos: [4, 11, -2], look: [-0.2, -0.2, 1] },
      { t: 18, pos: [0, 12, 10], look: [0, -0.2, 1] },
      { t: 24, pos: [8, 13, 20], look: [-0.5, -0.2, 0] },
      { t: 30, pos: [-8, 14, 20], look: [0.6, -0.3, -0.4] },
    ],
  },
];

/** Fit the templates to the actual scene bounds and a flight band above it. */
export function buildDronePaths(bounds: THREE.Box3): DronePath[] {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const sx = size.x / 2 / AUTHOR_HALF || 1;
  const sz = size.z / 2 / AUTHOR_HALF || 1;
  const topY = bounds.max.y;

  return TEMPLATES.map((tpl, idx) => ({
    id: idx + 1,
    zone: tpl.zone,
    waypoints: tpl.points.map((w) => ({
      t: w.t,
      pos: [
        center.x + w.pos[0] * sx,
        // Map the template's 8..14 flight height into a band above the scene top.
        topY + 2 + (w.pos[1] - 8) * 0.5,
        center.z + w.pos[2] * sz,
      ] as [number, number, number],
      look: w.look,
    })),
  }));
}
