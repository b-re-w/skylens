// Camera sync state machine for viewer 2 (§8.3): SYNCED -> FOCUSING -> LOCKED
// -> RETURNING -> SYNCED. Drives the recon camera's position/target each
// frame; the ReconViewer just calls step(camera, dt) and applies whatever
// pose comes out. Reads/writes shared store state so the UI (overlay.ts) can
// interoperate purely through `state.cameraSync` / `state.focusedDetectionId`
// and the {type:'detection-confirmed'} event.

import * as THREE from 'three';
import type { DetectionRuntime, DroneRuntime } from '../core/types';
import { state, emit, setCameraState } from '../core/store';
import { CONFIG } from '../core/config';
import { easeInOut, dampFactor, toVector3 } from '../core/math';

interface PoseSample {
  t: number;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
}

const RING_MAX = 240; // ~4s of history at 60fps, plenty for a few-second lag

export class CameraSync {
  private readonly camPos = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private initialized = false;

  /** Ring buffer of the active drone's recent pose, for the lagged SYNCED follow. */
  private readonly history: PoseSample[] = [];

  // Tween bookkeeping for FOCUSING / RETURNING.
  private tweenStart = 0;
  private tweenFrom = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private tweenTo = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

  /** Current camera position/target for the ReconViewer to apply. */
  getPose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    return { pos: this.camPos, target: this.camTarget };
  }

  /**
   * Advance the state machine and camera pose by dt seconds.
   * `detections` lets FOCUSING/LOCKED look up the focused detection's position.
   */
  step(dt: number, now: number, detections: DetectionRuntime[]): void {
    const active = state.drones.find((d) => d.id === state.activeDroneId) ?? state.drones[0];
    if (active) this.recordHistory(active, now);

    const lagged = this.laggedPose(now);

    // State-driven confirmation: once the operator acknowledges the focused
    // detection (overlay sets confirmed=true + emits detection-confirmed), the
    // camera returns. Reading the flag rather than consuming a one-shot event
    // means a confirmation can never be dropped by an unlucky sub-state.
    if (
      state.focusedDetectionId !== null &&
      (state.cameraSync === 'LOCKED' || state.cameraSync === 'FOCUSING')
    ) {
      const det = detections.find((d) => d.id === state.focusedDetectionId);
      if (det && det.confirmed) {
        this.beginReturning(lagged);
      }
    }

    switch (state.cameraSync) {
      case 'SYNCED':
        this.stepSynced(lagged, dt);
        break;
      case 'FOCUSING':
        this.stepTween(now, () => setCameraState('LOCKED'));
        break;
      case 'LOCKED':
        // Hold on the focused detection; keep target/pos fixed at tween end.
        break;
      case 'RETURNING':
        this.stepTween(now, () => {
          state.focusedDetectionId = null;
          setCameraState('SYNCED');
        });
        break;
    }

    // Trigger a new focus if something just became revealed and nothing's focused.
    if (state.cameraSync === 'SYNCED' && state.focusedDetectionId === null) {
      const candidate = detections.find((d) => d.revealed && !d.confirmed);
      if (candidate) {
        state.focusedDetectionId = candidate.id;
        this.beginFocusing(candidate, now);
        emit({ type: 'detection-focused', id: candidate.id });
      }
    }
  }

  private recordHistory(drone: DroneRuntime, now: number): void {
    this.history.push({ t: now, pos: drone.pos.clone(), forward: drone.forward.clone() });
    if (this.history.length > RING_MAX) this.history.shift();
  }

  /** Situation-board framing offset behind/above a drone pose. */
  private framePose(pos: THREE.Vector3, forward: THREE.Vector3): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const behind = forward.clone().multiplyScalar(-10);
    const camPos = pos.clone().add(behind).add(new THREE.Vector3(0, 7, 0));
    return { pos: camPos, target: pos.clone() };
  }

  /** Pose from ~revealLagSeconds ago in the drone history (or oldest/newest available). */
  private laggedPose(now: number): { pos: THREE.Vector3; target: THREE.Vector3 } {
    if (this.history.length === 0) {
      return { pos: new THREE.Vector3(0, 20, 30), target: new THREE.Vector3(0, 0, 0) };
    }
    const targetT = now - CONFIG.sim.revealLagSeconds;
    let sample = this.history[0];
    for (const s of this.history) {
      if (s.t <= targetT) sample = s;
      else break;
    }
    return this.framePose(sample.pos, sample.forward);
  }

  private stepSynced(lagged: { pos: THREE.Vector3; target: THREE.Vector3 }, dt: number): void {
    if (!this.initialized) {
      this.camPos.copy(lagged.pos);
      this.camTarget.copy(lagged.target);
      this.initialized = true;
      return;
    }
    // syncLerp is specified as a per-frame factor at 60fps; convert to a
    // continuous damping rate so the follow feels the same at any frame rate.
    const rate = -Math.log(1 - Math.min(0.999, CONFIG.camera.syncLerp)) * 60;
    const alpha = dampFactor(rate, dt);
    this.camPos.lerp(lagged.pos, alpha);
    this.camTarget.lerp(lagged.target, alpha);
  }

  private beginFocusing(det: DetectionRuntime, now: number): void {
    this.tweenFrom.pos.copy(this.camPos);
    this.tweenFrom.target.copy(this.camTarget);

    const detPos = toVector3(det.pos);
    const dir = detPos.clone().sub(this.camPos);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const camPos = detPos.clone().sub(dir.multiplyScalar(CONFIG.camera.focusDistance));
    camPos.y += CONFIG.camera.focusDistance * 0.35;

    this.tweenTo.pos.copy(camPos);
    this.tweenTo.target.copy(detPos);
    this.tweenStart = now;
    setCameraState('FOCUSING');
  }

  private beginReturning(lagged: { pos: THREE.Vector3; target: THREE.Vector3 }): void {
    this.tweenFrom.pos.copy(this.camPos);
    this.tweenFrom.target.copy(this.camTarget);
    this.tweenTo.pos.copy(lagged.pos);
    this.tweenTo.target.copy(lagged.target);
    this.tweenStart = state.time;
    setCameraState('RETURNING');
  }

  private stepTween(now: number, onDone: () => void): void {
    const t = (now - this.tweenStart) / Math.max(1e-6, CONFIG.camera.tweenSeconds);
    const e = easeInOut(t);
    this.camPos.lerpVectors(this.tweenFrom.pos, this.tweenTo.pos, e);
    this.camTarget.lerpVectors(this.tweenFrom.target, this.tweenTo.target, e);
    if (t >= 1) onDone();
  }
}
