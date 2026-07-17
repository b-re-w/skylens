// Progressive reveal applied to the REAL splat itself (not a point overlay), so
// RECON stays photorealistic. A top-down coverage texture over the scene's world
// XZ bounds encodes reveal progress; a drone "scans" a disc into it as it passes.
// The splat material's shader is patched (via onBeforeCompile) to sample that
// coverage at each splat's world XZ and fade the splat in — unrevealed splats are
// discarded, so the reconstruction blooms exactly where drones have flown.

import * as THREE from 'three';
import type { Visited } from '../core/types';
import { CONFIG } from '../core/config';

const RES = 256;

export class SplatReveal {
  private readonly progress: Float32Array; // RES*RES reveal value [0,1]
  private readonly started: Uint8Array; // texel has been scanned
  private readonly tex: THREE.DataTexture;
  private readonly worldMin = new THREE.Vector2();
  private readonly worldSize = new THREE.Vector2();
  private consumed = 0;

  // Uniform holders shared with the patched material.
  private readonly uniforms: {
    uRevealTex: { value: THREE.Texture };
    uRevealMin: { value: THREE.Vector2 };
    uRevealSize: { value: THREE.Vector2 };
  };

  constructor(bounds: THREE.Box3) {
    // Cover the XZ footprint, padded by the reveal radius so edges are reachable.
    const pad = CONFIG.reveal.radius;
    this.worldMin.set(bounds.min.x - pad, bounds.min.z - pad);
    this.worldSize.set(
      Math.max(1, bounds.max.x - bounds.min.x + pad * 2),
      Math.max(1, bounds.max.z - bounds.min.z + pad * 2),
    );

    this.progress = new Float32Array(RES * RES);
    this.started = new Uint8Array(RES * RES);
    this.tex = new THREE.DataTexture(this.progress, RES, RES, THREE.RedFormat, THREE.FloatType);
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;

    this.uniforms = {
      uRevealTex: { value: this.tex },
      uRevealMin: { value: this.worldMin },
      uRevealSize: { value: this.worldSize },
    };
  }

  /** World XZ -> texel indices (clamped). */
  private texel(x: number, z: number): { tx: number; tz: number } {
    const u = (x - this.worldMin.x) / this.worldSize.x;
    const v = (z - this.worldMin.y) / this.worldSize.y;
    return {
      tx: Math.min(RES - 1, Math.max(0, Math.floor(u * RES))),
      tz: Math.min(RES - 1, Math.max(0, Math.floor(v * RES))),
    };
  }

  /** Advance reveal: stamp newly-lagged visited spots, then fade started texels. */
  update(visitedLagged: Visited[], dt: number): void {
    let dirty = false;

    if (this.consumed < visitedLagged.length) {
      const rTexX = Math.ceil((CONFIG.reveal.radius / this.worldSize.x) * RES);
      const rTexZ = Math.ceil((CONFIG.reveal.radius / this.worldSize.y) * RES);
      const rSq = Math.max(rTexX, rTexZ) ** 2;
      for (let vi = this.consumed; vi < visitedLagged.length; vi++) {
        const spot = visitedLagged[vi];
        const { tx, tz } = this.texel(spot.pos[0], spot.pos[2]);
        for (let dz = -rTexZ; dz <= rTexZ; dz++) {
          const z = tz + dz;
          if (z < 0 || z >= RES) continue;
          for (let dx = -rTexX; dx <= rTexX; dx++) {
            const x = tx + dx;
            if (x < 0 || x >= RES) continue;
            if (dx * dx + dz * dz > rSq) continue;
            this.started[z * RES + x] = 1;
          }
        }
      }
      this.consumed = visitedLagged.length;
      dirty = true;
    }

    // Fade scanned texels toward full reveal.
    const rate = dt / Math.max(1e-6, CONFIG.reveal.fadeSeconds);
    for (let i = 0; i < this.progress.length; i++) {
      if (this.started[i] && this.progress[i] < 1) {
        this.progress[i] = Math.min(1, this.progress[i] + rate);
        dirty = true;
      }
    }
    if (dirty) this.tex.needsUpdate = true;
  }

  /** True once the area around a world position has begun revealing. */
  isAreaRevealed(pos: [number, number, number]): boolean {
    const { tx, tz } = this.texel(pos[0], pos[2]);
    return this.progress[tz * RES + tx] > 0.02;
  }

  /**
   * Patch a splat ShaderMaterial to fade splats in by coverage. Idempotent per
   * material. Safe to call once the splat mesh material exists.
   */
  attachTo(material: THREE.ShaderMaterial): void {
    const store = material as THREE.ShaderMaterial & { userData: { splatRevealed?: boolean } };
    if (store.userData.splatRevealed) return;
    store.userData.splatRevealed = true;

    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.(shader, renderer);
      shader.uniforms.uRevealTex = this.uniforms.uRevealTex;
      shader.uniforms.uRevealMin = this.uniforms.uRevealMin;
      shader.uniforms.uRevealSize = this.uniforms.uRevealSize;

      // --- Vertex: sample coverage at the splat's world XZ into a varying. ---
      shader.vertexShader = shader.vertexShader
        .replace(
          'attribute uint splatIndex;',
          `attribute uint splatIndex;
           uniform sampler2D uRevealTex;
           uniform vec2 uRevealMin;
           uniform vec2 uRevealSize;
           varying float vReveal;`,
        )
        .replace(
          'vColor = uintToRGBAVec(sampledCenterColor.r);',
          `vColor = uintToRGBAVec(sampledCenterColor.r);
           {
             vec4 wc = modelMatrix * vec4(splatCenter, 1.0);
             vec2 ruv = (wc.xz - uRevealMin) / uRevealSize;
             float rev = 0.0;
             if (ruv.x >= 0.0 && ruv.x <= 1.0 && ruv.y >= 0.0 && ruv.y <= 1.0) {
               rev = texture(uRevealTex, ruv).r;
             }
             vReveal = rev;
           }`,
        );

      // --- Fragment: fade/discard by reveal. ---
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'varying vec2 vPosition;',
          `varying vec2 vPosition;
           varying float vReveal;`,
        )
        .replace(
          'gl_FragColor = vec4(color.rgb, opacity);',
          `if (vReveal < 0.003) discard;
           gl_FragColor = vec4(color.rgb, opacity * vReveal);`,
        );
    };
    material.needsUpdate = true;
  }
}
