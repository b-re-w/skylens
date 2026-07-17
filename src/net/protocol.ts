// Wire protocol for SIM -> RECON state streaming over the WebRTC DataChannel.
//
// Data flow is one-directional: the SIM computer owns the simulation (drone
// poses, the visited buffer, active drone, sim clock) and streams snapshots to
// the RECON computer, which computes reveal + camera + detections locally from
// what it receives. Confirmations happen on RECON and stay local, so nothing
// needs to travel back.

import * as THREE from 'three';
import type { AppState, DroneMode, Vec3 } from '../core/types';

/** One drone's pose on the wire (plain arrays, no THREE objects). */
export interface WireDrone {
  id: number;
  zone: string;
  pos: Vec3;
  quat: [number, number, number, number];
  forward: Vec3;
  mode: DroneMode;
  pathTime: number;
}

export interface WireVisited {
  pos: Vec3;
  t: number;
}

/** A full SIM->RECON snapshot. `visitedDelta` carries only new visited spots. */
export interface StateSnapshot {
  kind: 'state';
  time: number;
  activeDroneId: number;
  drones: WireDrone[];
  visitedDelta: WireVisited[];
  /** Running total of visited entries on the sender, so RECON can detect gaps. */
  visitedTotal: number;
}

/**
 * Encode the SIM's current state into a snapshot. `sinceVisited` is the number
 * of visited entries already sent, so we transmit only the delta.
 */
export function encodeState(state: AppState, sinceVisited: number): StateSnapshot {
  const drones: WireDrone[] = state.drones.map((d) => ({
    id: d.id,
    zone: d.zone,
    pos: [d.pos.x, d.pos.y, d.pos.z],
    quat: [d.quat.x, d.quat.y, d.quat.z, d.quat.w],
    forward: [d.forward.x, d.forward.y, d.forward.z],
    mode: d.mode,
    pathTime: d.pathTime,
  }));

  const visitedDelta: WireVisited[] = [];
  for (let i = Math.max(0, sinceVisited); i < state.visited.length; i++) {
    const v = state.visited[i];
    visitedDelta.push({ pos: v.pos, t: v.t });
  }

  return {
    kind: 'state',
    time: state.time,
    activeDroneId: state.activeDroneId,
    drones,
    visitedDelta,
    visitedTotal: state.visited.length,
  };
}

/**
 * Apply a received snapshot onto RECON's local store state, mutating in place.
 * Reuses existing DroneRuntime objects/vectors where possible to avoid churn.
 */
export function applyState(snap: StateSnapshot, state: AppState): void {
  state.time = snap.time;
  state.activeDroneId = snap.activeDroneId;

  // Sync drones by id.
  for (const wd of snap.drones) {
    let d = state.drones.find((x) => x.id === wd.id);
    if (!d) {
      d = {
        id: wd.id,
        zone: wd.zone,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        forward: new THREE.Vector3(),
        mode: wd.mode,
        pathTime: wd.pathTime,
      };
      state.drones.push(d);
    }
    d.zone = wd.zone;
    d.pos.set(wd.pos[0], wd.pos[1], wd.pos[2]);
    d.quat.set(wd.quat[0], wd.quat[1], wd.quat[2], wd.quat[3]);
    d.forward.set(wd.forward[0], wd.forward[1], wd.forward[2]);
    d.mode = wd.mode;
    d.pathTime = wd.pathTime;
  }

  // Append visited delta. If the sender is ahead of us by more than the delta
  // (e.g. we joined late), we just take what we're given — reveal is monotonic
  // so missing early spots only means a slightly later bloom, never corruption.
  for (const v of snap.visitedDelta) {
    state.visited.push({ pos: v.pos, t: v.t });
  }
}
