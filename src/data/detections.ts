// Manually-placed detection markers. PROJECT.md §2-3 / §7: in the mid-eval
// prototype these coordinates are authored by hand (a legit demo choice), later
// swapped for real UNet + Depth-Map raycasting output. Positions sit inside the
// scene footprint so they get revealed as drones sweep past.

import type { Detection } from '../core/types';

export const DETECTIONS: Detection[] = [
  {
    id: 'p1',
    kind: 'person',
    pos: [-9, 1.2, 5],
    label: '생존자 추정 · 구역 A',
    confidence: 0.86,
  },
  {
    id: 'p2',
    kind: 'person',
    pos: [10, 2.4, 4],
    label: '생존자 추정 · 구역 B',
    confidence: 0.74,
  },
  {
    id: 'd1',
    kind: 'danger',
    pos: [-2, 3.0, 8],
    label: '붕괴 위험구역 · 중앙',
    confidence: 0.91,
  },
];
