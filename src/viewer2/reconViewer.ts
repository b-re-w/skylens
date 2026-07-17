// Viewer 2 — the "real" 3D reconstruction situation board (PROJECT.md §5, §8).
// Renders the FULL point cloud with a progressive, lagged bloom-reveal driven
// by the drone module's `state.visited` trail, places detection markers that
// appear once their area is revealed, and drives the camera through the
// SYNCED/FOCUSING/LOCKED/RETURNING state machine (§8.3).
//
// A placeholder point cloud stands in for a future Gaussian splat; the
// reveal/camera choreography and coordinate frame are real and swappable.

import * as THREE from 'three';
import type { SceneData } from '../data/sceneData';
import type { Detection, DetectionRuntime } from '../core/types';
import { state, emit } from '../core/store';
import { CONFIG } from '../core/config';
import { RevealField } from './reveal.ts';
import { SplatReveal } from './splatReveal.ts';
import { CameraSync } from './cameraSync.ts';
import { SplatScene } from './splatScene.ts';
import type { SplatOptions, SplatStatus } from './splatScene.ts';

const POINT_VERT = /* glsl */ `
  attribute float aReveal;
  varying vec3 vColor;
  varying float vReveal;
  void main() {
    vColor = color;
    vReveal = aReveal;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Freshly revealed points pop slightly larger, then settle.
    float pop = 1.0 + 0.6 * (1.0 - vReveal) * step(0.001, vReveal);
    gl_PointSize = (2.2 * pop) * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vReveal;
  void main() {
    if (vReveal <= 0.001) discard;
    vec2 c = gl_PointCoord - vec2(0.5);
    if (dot(c, c) > 0.25) discard;
    // Brief emissive pop while fading in, settling to base color at full reveal.
    vec3 pop = mix(vColor * 1.8 + 0.2, vColor, smoothstep(0.0, 1.0, vReveal));
    gl_FragColor = vec4(pop, vReveal);
  }
`;

/** One marker's live visuals (pin + pulsing ring), kept in sync with a DetectionRuntime. */
interface MarkerVisual {
  det: DetectionRuntime;
  group: THREE.Group;
  ring: THREE.Mesh;
  visible: boolean;
}

export class ReconViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;

  private readonly points: THREE.Points;
  private readonly pointGeom: THREE.BufferGeometry;
  private readonly revealAttr: THREE.BufferAttribute;
  // Reveal is driven on the point cloud (fallback) OR on the splat itself
  // (photorealistic mode, via a coverage texture + patched splat shader).
  private readonly reveal: RevealField | null;
  private readonly splatReveal: SplatReveal | null;
  private splatAttached = false;
  private readonly camSync = new CameraSync();
  private readonly markers: MarkerVisual[] = [];
  private splat: SplatScene | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    sceneData: SceneData,
    detections: Detection[],
    useSplat: boolean,
  ) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

    this.scene.background = new THREE.Color(CONFIG.color.reconBg);
    this.scene.fog = new THREE.Fog(CONFIG.color.reconBg, 20, 90);
    // Subtle warm-neutral fill so the "real" reconstruction reads photographic.
    this.scene.add(new THREE.AmbientLight(0xffe8cf, 0.35));
    const key = new THREE.DirectionalLight(0xfff1d8, 0.5);
    key.position.set(10, 20, 8);
    this.scene.add(key);

    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 500);

    // Full point cloud with a per-point aReveal attribute we drive over time.
    this.pointGeom = new THREE.BufferGeometry();
    this.pointGeom.setAttribute('position', new THREE.BufferAttribute(sceneData.positions, 3));
    this.pointGeom.setAttribute('color', new THREE.BufferAttribute(sceneData.colors, 3));
    const revealArray = new Float32Array(sceneData.count); // starts at 0 — fully hidden
    this.revealAttr = new THREE.BufferAttribute(revealArray, 1);
    this.revealAttr.setUsage(THREE.DynamicDrawUsage);
    this.pointGeom.setAttribute('aReveal', this.revealAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.pointGeom, material);

    if (useSplat) {
      // RECON is photorealistic: the splat itself reveals. The point cloud is
      // NOT shown — it's the SIM's representation.
      this.reveal = null;
      this.splatReveal = new SplatReveal(sceneData.bounds);
    } else {
      // No splat (disabled/failed): show the point cloud and reveal on it.
      this.scene.add(this.points);
      this.reveal = new RevealField(sceneData.positions, sceneData.count);
      this.splatReveal = null;
    }

    // Initialize shared detection state on first construction (state owner).
    if (state.detections.length === 0) {
      state.detections = detections.map((d) => ({
        ...d,
        revealed: false,
        confirmed: false,
        revealedAt: null,
      }));
    }

    for (const det of state.detections) {
      this.markers.push(this.buildMarker(det));
    }

    this.resize();
  }

  private buildMarker(det: DetectionRuntime): MarkerVisual {
    const color = det.kind === 'person' ? CONFIG.color.markerPerson : CONFIG.color.markerDanger;
    const group = new THREE.Group();

    const pinGeom = new THREE.ConeGeometry(0.5, 1.6, 12);
    const pinMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 });
    const pin = new THREE.Mesh(pinGeom, pinMat);
    pin.position.y = 0.8;
    pin.rotation.x = Math.PI;
    group.add(pin);

    const ringGeom = new THREE.RingGeometry(0.8, 1.0, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    group.position.set(det.pos[0], det.pos[1], det.pos[2]);
    group.visible = false;
    this.scene.add(group);

    return { det, group, ring, visible: false };
  }

  update(dt: number): void {
    const now = state.time;

    // Lag the visited trail before feeding the reveal (§5.2).
    const cutoff = now - CONFIG.sim.revealLagSeconds;
    const lagged = state.visited.filter((v) => v.t <= cutoff);

    // Patch the splat shader once its material exists (photorealistic reveal).
    if (this.splatReveal && this.splat && !this.splatAttached) {
      const mat = this.splat.material;
      if (mat) {
        this.splatReveal.attachTo(mat);
        this.splatAttached = true;
      }
    }

    if (this.splatReveal) {
      this.splatReveal.update(lagged, dt);
    } else if (this.reveal) {
      const dirty = this.reveal.update(lagged, now, dt);
      if (dirty) {
        (this.revealAttr.array as Float32Array).set(this.reveal.progress);
        this.revealAttr.needsUpdate = true;
      }
    }

    const isRevealed = (pos: [number, number, number]): boolean =>
      this.splatReveal ? this.splatReveal.isAreaRevealed(pos) : !!this.reveal?.isAreaRevealed(pos);

    // Detection reveal + marker visibility.
    for (const m of this.markers) {
      if (!m.det.revealed) {
        if (isRevealed(m.det.pos)) {
          m.det.revealed = true;
          m.det.revealedAt = now;
          emit({ type: 'detection-revealed', id: m.det.id });
        }
      }
      const shouldShow = m.det.revealed;
      if (shouldShow !== m.visible) {
        m.group.visible = shouldShow;
        m.visible = shouldShow;
      }
      if (shouldShow) {
        const pulse = 0.8 + 0.4 * Math.sin(now * 3 + m.group.position.x);
        m.ring.scale.setScalar(pulse);
      }
    }

    // Camera state machine (§8.3).
    this.camSync.step(dt, now, state.detections);
    const pose = this.camSync.getPose();
    this.camera.position.copy(pose.pos);
    this.camera.lookAt(pose.target);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Attach the real Gaussian splat layer (TEST asset). Fit into the same frame
   * as the procedural cloud so reveal/markers/camera stay aligned. Idempotent.
   */
  loadSplat(opts: SplatOptions): void {
    if (this.splat) return;
    this.splat = new SplatScene(this.scene);
    this.splat.load(opts);
  }

  get splatStatus(): SplatStatus {
    return this.splat?.status ?? 'idle';
  }

  get splatProgress(): number {
    return this.splat?.progress ?? 0;
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.splat?.dispose();
    this.pointGeom.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const m of this.markers) {
      m.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat.dispose();
        }
      });
    }
    this.renderer.dispose();
  }
}
