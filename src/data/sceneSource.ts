// Single source of truth for the 3D scene.
//
// PROJECT.md §1 core trick: BOTH viewers must show the SAME data, differing only
// in how they render it. So the real Gaussian splat is the source: we load it,
// extract its splat centers+colors into a downsampled point cloud, and auto-fit
// it into a normalized world frame. SIM renders that point cloud low-fi; RECON
// renders the full splat (with the SAME transform) plus reveal over the same
// points. Both computers load the same URL and run the same deterministic
// pipeline, so their clouds are identical.
//
// If the splat is disabled (?splat=off) or fails to load, both sides fall back
// to the same deterministic procedural cloud — so they still match.

import * as THREE from 'three';
import { SplatLoader } from '@mkkellogg/gaussian-splats-3d';
import { CONFIG } from '../core/config.ts';
import { buildSceneData } from './sceneData.ts';
import type { SceneData } from './sceneData.ts';

/**
 * Resolve which splat URL to load from `?splat=` + config. Both SIM and RECON
 * call this so they load the same asset.
 *   off → null (procedural fallback) | light|nike → lighter sample
 *   http(s)://… → custom | (absent) → default
 */
export function resolveSplatUrl(): string | null {
  if (!CONFIG.splat.enabled) return null;
  const q =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('splat');
  if (!q) return CONFIG.splat.url;
  if (q === 'off') return null;
  if (q === 'light' || q === 'nike') return CONFIG.splat.urlLight;
  if (/^https?:\/\//.test(q)) return q;
  return CONFIG.splat.url;
}

/** Transform that places the splat identically to the derived point cloud. */
export interface SplatTransform {
  url: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface LoadedScene {
  data: SceneData;
  /** Non-null when the real splat should be rendered (RECON); null on fallback. */
  splat: SplatTransform | null;
}

/** Longest world-space dimension we fit the scene into (matches the old footprint). */
const TARGET_EXTENT = 44;
/** Points kept for the low-fi/reveal cloud (the full splat renders separately). */
const TARGET_POINTS = 120_000;
/** Orientation presets to stand the splat upright (SfM frames vary per asset). */
const UP_PRESETS: Record<string, THREE.Euler> = {
  none: new THREE.Euler(0, 0, 0),
  x180: new THREE.Euler(Math.PI, 0, 0),
  x90: new THREE.Euler(Math.PI / 2, 0, 0),
  'x-90': new THREE.Euler(-Math.PI / 2, 0, 0),
  z90: new THREE.Euler(0, 0, Math.PI / 2),
  'z-90': new THREE.Euler(0, 0, -Math.PI / 2),
  z180: new THREE.Euler(0, 0, Math.PI),
};

/** Chosen upright rotation. These SfM/photo splats are gravity-aligned already,
 *  so no flip by default; override per asset with ?up=<preset>. */
function uprightQuat(): THREE.Quaternion {
  let key = 'none';
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('up');
    if (q && UP_PRESETS[q]) key = q;
  }
  return new THREE.Quaternion().setFromEuler(UP_PRESETS[key]);
}

export interface LoadSceneOptions {
  url: string | null;
  onProgress?: (percent: number) => void;
}

export async function loadScene(opts: LoadSceneOptions): Promise<LoadedScene> {
  if (!opts.url) return fallback();
  try {
    const buffer = await SplatLoader.loadFromURL(
      opts.url,
      (pct: number) => opts.onProgress?.(pct),
      false, // full buffer, not progressive
      undefined,
      1,
      0,
      true,
    );
    return deriveFromSplat(buffer, opts.url);
  } catch {
    // Network/parse failure — degrade to the shared procedural cloud.
    return fallback();
  }
}

function fallback(): LoadedScene {
  return { data: buildSceneData(), splat: null };
}

/** Percentile of a sorted ascending array. */
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function deriveFromSplat(
  buffer: import('@mkkellogg/gaussian-splats-3d').SplatBuffer,
  url: string,
): LoadedScene {
  const total = buffer.getSplatCount();
  if (total === 0) return fallback();

  const UPRIGHT = uprightQuat();
  const c = new THREE.Vector3();

  // --- ROBUST bounds (UPRIGHT-rotated frame) ---
  // Photo/SfM splats carry lots of outlier "floater" gaussians far from the real
  // structure. Naive min/max is dominated by them, so we fit to robust
  // percentile bounds instead — the building, not the noise, sets the scale.
  const sampleStride = Math.max(1, Math.floor(total / 60_000));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < total; i += sampleStride) {
    buffer.getSplatCenter(i, c);
    c.applyQuaternion(UPRIGHT);
    xs.push(c.x);
    ys.push(c.y);
    zs.push(c.z);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);

  const LO = 0.05;
  const HI = 0.95;
  const rMin = new THREE.Vector3(pct(xs, LO), pct(ys, LO), pct(zs, LO));
  const rMax = new THREE.Vector3(pct(xs, HI), pct(ys, HI), pct(zs, HI));
  const size = new THREE.Vector3().subVectors(rMax, rMin);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = TARGET_EXTENT / maxDim;

  const rCenter = new THREE.Vector3().addVectors(rMin, rMax).multiplyScalar(0.5);
  // world = s*(R*raw) + P ; center XZ at origin, floor the robust bottom at y=0.
  const P = new THREE.Vector3(-s * rCenter.x, -s * rMin.y, -s * rCenter.z);

  // Keep points a bit beyond the robust box so the structure isn't clipped, but
  // drop far floaters. Margin in rotated (pre-scale) units.
  const margin = maxDim * 0.15;
  const clipMin = rMin.clone().subScalar(margin);
  const clipMax = rMax.clone().addScalar(margin);

  // --- Build the downsampled, clipped world-space cloud ---
  const stride = Math.max(1, Math.floor(total / TARGET_POINTS));
  const cap = Math.ceil(total / stride);
  const positions = new Float32Array(cap * 3);
  const colors = new Float32Array(cap * 3);
  const col = new THREE.Vector4();
  const rot = new THREE.Vector3();
  const bounds = new THREE.Box3(
    new THREE.Vector3(Infinity, Infinity, Infinity),
    new THREE.Vector3(-Infinity, -Infinity, -Infinity),
  );

  let j = 0;
  for (let i = 0; i < total; i += stride) {
    buffer.getSplatCenter(i, rot);
    rot.applyQuaternion(UPRIGHT);
    // Reject floaters outside the robust box (+margin).
    if (
      rot.x < clipMin.x || rot.x > clipMax.x ||
      rot.y < clipMin.y || rot.y > clipMax.y ||
      rot.z < clipMin.z || rot.z > clipMax.z
    ) {
      continue;
    }
    c.copy(rot).multiplyScalar(s).add(P);
    positions[j * 3] = c.x;
    positions[j * 3 + 1] = c.y;
    positions[j * 3 + 2] = c.z;
    buffer.getSplatColor(i, col);
    colors[j * 3] = col.x / 255;
    colors[j * 3 + 1] = col.y / 255;
    colors[j * 3 + 2] = col.z / 255;
    bounds.expandByPoint(c);
    j++;
  }

  const data: SceneData = {
    positions: positions.subarray(0, j * 3),
    colors: colors.subarray(0, j * 3),
    count: j,
    bounds,
    groundY: 0,
  };

  const splat: SplatTransform = {
    url,
    position: [P.x, P.y, P.z],
    rotation: [UPRIGHT.x, UPRIGHT.y, UPRIGHT.z, UPRIGHT.w],
    scale: [s, s, s],
  };

  return { data, splat };
}
