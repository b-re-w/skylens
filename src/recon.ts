// RECON page bootstrap — the "3D reconstruction situation board" computer (컴퓨터 B).
//
// Access URL:  http://<서버IP>:5173/recon.html?room=<방이름>
// Pair with SIM at the SAME room: /sim.html?room=<방이름>
//
// Consumes state snapshots from the SIM computer over WebRTC and computes reveal,
// detection markers, and the camera state machine locally. The clock and drone
// poses come from the wire; confirmations happen here and stay local.

import './style.css';
import { state } from './core/store.ts';
import { buildSceneData } from './data/sceneData.ts';
import { ReconViewer } from './viewer2/reconViewer.ts';
import { initUI } from './ui/overlay.ts';
import { createTransport } from './net/peer.ts';
import { applyState } from './net/protocol.ts';
import type { StateSnapshot } from './net/protocol.ts';
import { roomFromQuery, mountNetBadge } from './net/statusUi.ts';

function getCanvas(id: string): HTMLCanvasElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLCanvasElement)) throw new Error(`Canvas #${id} missing`);
  return el;
}

const scene = buildSceneData();
const recon = new ReconViewer(getCanvas('view2'), scene);
const ui = initUI();

const transport = createTransport('recon', roomFromQuery());
mountNetBadge(transport, 'recon');

transport.onData((d) => {
  const snap = d as StateSnapshot;
  if (snap && snap.kind === 'state') applyState(snap, state);
});

function resize(): void {
  recon.resize();
}
window.addEventListener('resize', resize);
resize();

// --- Render loop ---
// The sim clock (state.time) advances from incoming snapshots; here dt is only
// used for frame-rate-independent camera damping/tweening and marker pulsing.
const MAX_DT = 1 / 20;
let last = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;
  recon.update(dt);
  ui.update();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug/e2e handle.
(window as unknown as { skylens?: unknown }).skylens = {
  role: 'recon',
  state,
  scene,
  transport,
};
