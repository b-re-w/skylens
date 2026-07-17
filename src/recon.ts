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
import { CONFIG } from './core/config.ts';
import { buildSceneData } from './data/sceneData.ts';
import { ReconViewer } from './viewer2/reconViewer.ts';
import type { SplatOptions } from './viewer2/splatScene.ts';
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

/**
 * Resolve the real-splat option from the URL:
 *   ?splat=off            → disable (fast, point-cloud only)
 *   ?splat=light | nike   → the lighter 8.6 MB sample
 *   ?splat=<http…>        → a custom splat URL
 *   (absent)              → the default sample
 */
function resolveSplat(): SplatOptions | null {
  const base: SplatOptions = {
    url: CONFIG.splat.url,
    position: [...CONFIG.splat.position],
    rotation: [...CONFIG.splat.rotation],
    scale: [...CONFIG.splat.scale],
  };
  if (!CONFIG.splat.enabled) return null;
  const q = new URLSearchParams(window.location.search).get('splat');
  if (!q) return base;
  if (q === 'off') return null;
  if (q === 'light' || q === 'nike') return { ...base, url: CONFIG.splat.urlLight };
  if (/^https?:\/\//.test(q)) return { ...base, url: q };
  return base;
}

const scene = buildSceneData();
const recon = new ReconViewer(getCanvas('view2'), scene);
const ui = initUI();

// Attach the real Gaussian splat (test asset) unless disabled.
const splatOpts = resolveSplat();
if (splatOpts) {
  recon.loadSplat(splatOpts);
  mountSplatLoading();
}

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

// A small badge showing splat download/build progress until the scene is ready.
function mountSplatLoading(): void {
  const host = document.getElementById('overlay-recon');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'splat-loading';
  host.appendChild(el);

  let lastText = '';
  const tick = (): void => {
    const s = recon.splatStatus;
    let text = '';
    if (s === 'loading') text = `실사 3D 복원 데이터 로딩… ${Math.round(recon.splatProgress)}%`;
    else if (s === 'error') text = '실사 3D 로드 실패 — 포인트클라우드로 진행';
    // 'ready'/'idle' → hide.
    if (text !== lastText) {
      lastText = text;
      el.textContent = text;
      el.classList.toggle('is-visible', text !== '');
    }
    if (s === 'loading' || s === 'idle') requestAnimationFrame(tick);
    else if (s === 'error') setTimeout(() => el.classList.remove('is-visible'), 4000);
  };
  requestAnimationFrame(tick);
}

// Debug/e2e handle.
(window as unknown as { skylens?: unknown }).skylens = {
  role: 'recon',
  state,
  scene,
  transport,
  splat: {
    get status() {
      return recon.splatStatus;
    },
    get progress() {
      return recon.splatProgress;
    },
  },
};
