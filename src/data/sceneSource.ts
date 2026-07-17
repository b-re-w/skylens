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
/** Stand antimatter15 .splat data upright (it reads flipped in three.js). */
const UPRIGHT = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));

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

function deriveFromSplat(
  buffer: import('@mkkellogg/gaussian-splats-3d').SplatBuffer,
  url: string,
): LoadedScene {
  const total = buffer.getSplatCount();
  if (total === 0) return fallback();

  const c = new THREE.Vector3();

  // Pass 1: bounds of the UPRIGHT-rotated raw centers (pre-scale/translate).
  const rotMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const rotMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  // Stride the first pass for speed on huge clouds; bounds barely change.
  const boundsStride = Math.max(1, Math.floor(total / 200_000));
  for (let i = 0; i < total; i += boundsStride) {
    buffer.getSplatCenter(i, c);
    c.applyQuaternion(UPRIGHT);
    rotMin.min(c);
    rotMax.max(c);
  }

  const size = new THREE.Vector3().subVectors(rotMax, rotMin);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = TARGET_EXTENT / maxDim;

  const rotCenter = new THREE.Vector3().addVectors(rotMin, rotMax).multiplyScalar(0.5);
  // world = s*(R*raw) + P ; choose P to center XZ at origin and floor Y at 0.
  const P = new THREE.Vector3(-s * rotCenter.x, -s * rotMin.y, -s * rotCenter.z);

  // Pass 2: build the downsampled world-space cloud.
  const stride = Math.max(1, Math.floor(total / TARGET_POINTS));
  const kept = Math.ceil(total / stride);
  const positions = new Float32Array(kept * 3);
  const colors = new Float32Array(kept * 3);
  const col = new THREE.Vector4();
  const bounds = new THREE.Box3(
    new THREE.Vector3(Infinity, Infinity, Infinity),
    new THREE.Vector3(-Infinity, -Infinity, -Infinity),
  );

  let j = 0;
  for (let i = 0; i < total; i += stride) {
    buffer.getSplatCenter(i, c);
    c.applyQuaternion(UPRIGHT).multiplyScalar(s).add(P);
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
