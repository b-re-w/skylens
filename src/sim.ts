// SIM page bootstrap — the "drone simulation" computer (컴퓨터 A).
//
// Access URL:  http://<서버IP>:5173/sim.html?room=<방이름>
// Pair with RECON at the SAME room: /recon.html?room=<방이름>
//
// Owns the simulation: runs the drone controller + the low-fi viewer, advances
// the shared clock, and streams state snapshots to the RECON computer over the
// WebRTC DataChannel. Keyboard control (fly / switch drone / pause) lives here.

import './style.css';
import { state } from './core/store.ts';
import { CONFIG } from './core/config.ts';
import { buildSceneData } from './data/sceneData.ts';
import { createDroneController } from './drones/pathFollower.ts';
import { LowfiViewer } from './viewer1/lowfiViewer.ts';
import { createTransport } from './net/peer.ts';
import { encodeState } from './net/protocol.ts';
import { roomFromQuery, mountNetBadge } from './net/statusUi.ts';

function getCanvas(id: string): HTMLCanvasElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLCanvasElement)) throw new Error(`Canvas #${id} missing`);
  return el;
}

const scene = buildSceneData();
const drones = createDroneController();
const lowfi = new LowfiViewer(getCanvas('view1'), scene);

const transport = createTransport('sim', roomFromQuery());
mountNetBadge(transport, 'sim');

function resize(): void {
  lowfi.resize();
}
window.addEventListener('resize', resize);
resize();

// --- Snapshot streaming (throttled) ---
const SEND_INTERVAL = 1 / 30; // 30 Hz
let sendAcc = 0;
let sentVisited = 0;

function stream(): void {
  if (transport.status !== 'connected') return;
  const snap = encodeState(state, sentVisited);
  transport.send(snap);
  sentVisited = snap.visitedTotal;
}

// --- Main loop ---
const MAX_DT = 1 / 20;
let last = performance.now();

function frame(now: number): void {
  const real = (now - last) / 1000;
  last = now;
  const dt = Math.min(real, MAX_DT) * CONFIG.sim.speed;

  if (state.running) {
    state.time += dt;
    drones.update(dt);
    sendAcc += real;
    if (sendAcc >= SEND_INTERVAL) {
      sendAcc = 0;
      stream();
    }
  }

  lowfi.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Pause toggle (space) ---
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    state.running = !state.running;
  }
});

// Debug/e2e handle.
(window as unknown as { skylens?: unknown }).skylens = {
  role: 'sim',
  state,
  scene,
  CONFIG,
  transport,
};
