// Preset drone paths. PROJECT.md §4.1 — three drones sweep three zones.
// Waypoints are hand-authored to cover the scene footprint (see sceneData.ts,
// roughly [-24..24] on X/Z) so the reveal choreography sweeps the whole cloud.

import type { DronePath } from '../core/types';

export const DRONE_PATHS: DronePath[] = [
  {
    id: 1,
    zone: '구역 A (서편)',
    waypoints: [
      { t: 0, pos: [-22, 10, -20], look: [1, -0.2, 0.3] },
      { t: 6, pos: [-14, 9, -6], look: [1, -0.2, 0.4] },
      { t: 12, pos: [-10, 8, 6], look: [0.5, -0.1, 1] },
      { t: 18, pos: [-16, 9, 16], look: [-0.3, 0, 1] },
      { t: 24, pos: [-6, 11, 18], look: [1, -0.1, 0.2] },
      { t: 30, pos: [-2, 12, 6], look: [0.2, -0.2, -1] },
    ],
  },
  {
    id: 2,
    zone: '구역 B (동편)',
    waypoints: [
      { t: 0, pos: [22, 11, -18], look: [-1, -0.2, 0.3] },
      { t: 6, pos: [12, 10, -8], look: [-0.6, -0.1, 0.6] },
      { t: 12, pos: [9, 9, 4], look: [0, -0.1, 1] },
      { t: 18, pos: [16, 10, 14], look: [-0.4, -0.1, 0.6] },
      { t: 24, pos: [6, 12, 16], look: [-1, -0.2, -0.2] },
      { t: 30, pos: [3, 13, 4], look: [-0.2, -0.2, -1] },
    ],
  },
  {
    id: 3,
    zone: '구역 C (중앙/남)',
    waypoints: [
      { t: 0, pos: [0, 14, -22], look: [0, -0.3, 1] },
      { t: 6, pos: [-4, 12, -12], look: [0.3, -0.2, 1] },
      { t: 12, pos: [4, 11, -2], look: [-0.2, -0.2, 1] },
      { t: 18, pos: [0, 12, 10], look: [0, -0.2, 1] },
      { t: 24, pos: [8, 13, 20], look: [-0.5, -0.2, 0] },
      { t: 30, pos: [-8, 14, 20], look: [0.6, -0.3, -0.4] },
    ],
  },
];
