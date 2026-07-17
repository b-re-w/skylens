import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// End-to-end smoke tests for the two-page WebRTC build.
//
//  - Per-page tests verify each role boots the real browser runtime (WebGL
//    shader compilation, first-frame code paths) without uncaught exceptions.
//  - The integration test opens BOTH pages against the public PeerJS broker in
//    a unique room and verifies live state actually flows SIM -> RECON and the
//    detection choreography runs on RECON.
//
// Each page exposes `window.skylens = { role, state, scene, transport, CONFIG? }`.

type Vec = { x: number; y: number; z: number };
interface DetectionRuntime {
  id: string;
  kind: 'person' | 'danger';
  revealed: boolean;
  confirmed: boolean;
}
interface SkylensHandle {
  role: 'sim' | 'recon';
  state: {
    time: number;
    running: boolean;
    drones: { id: number; mode: string; pos: Vec }[];
    visited: unknown[];
    detections: DetectionRuntime[];
    activeDroneId: number;
    cameraSync: string;
    focusedDetectionId: string | null;
  };
  transport: { status: string };
  CONFIG?: { sim: { speed: number } };
}

declare global {
  interface Window {
    skylens: SkylensHandle;
  }
}

// PeerJS/STUN/websocket chatter is expected noise, especially while a peer is
// waiting for its partner. We only care about genuine app-level failures.
const NET_NOISE = /peerjs|peer-unavailable|ice|stun|turn|websocket|could not connect/i;

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !NET_NOISE.test(msg.text())) {
      errors.push(`console: ${msg.text()}`);
    }
  });
  return errors;
}

function uniqueRoom(): string {
  return `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function hasWebGL(page: Page, canvasId: string): Promise<boolean> {
  return page.$eval(`#${canvasId}`, (el) => {
    const c = el as HTMLCanvasElement;
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
}

test.describe('per-page boot', () => {
  test('SIM page boots, drives drones, no uncaught errors', async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto(`/sim.html?room=${uniqueRoom()}`);
    await page.waitForFunction(
      () => window.skylens?.role === 'sim' && window.skylens.state.drones.length === 3,
      undefined,
      { timeout: 15_000 },
    );

    expect(await hasWebGL(page, 'view1')).toBeTruthy();

    // Clock advances and the drone moves along its path.
    const p0 = await page.evaluate(() => window.skylens.state.drones[0].pos);
    const t0 = await page.evaluate(() => window.skylens.state.time);
    await page.waitForTimeout(1200);
    const p1 = await page.evaluate(() => window.skylens.state.drones[0].pos);
    const t1 = await page.evaluate(() => window.skylens.state.time);
    expect(t1).toBeGreaterThan(t0);
    expect(
      Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) + Math.abs(p1.z - p0.z),
    ).toBeGreaterThan(0.05);

    // visited buffer (reveal source) accumulates locally on SIM.
    expect(
      await page.evaluate(() => window.skylens.state.visited.length),
    ).toBeGreaterThan(0);

    // Active-drone switch via number key.
    await page.locator('#view1').click({ position: { x: 50, y: 50 } });
    await page.keyboard.press('3');
    await expect
      .poll(() => page.evaluate(() => window.skylens.state.activeDroneId))
      .toBe(3);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('RECON page boots, initializes detections, no uncaught errors', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto(`/recon.html?room=${uniqueRoom()}`);
    await page.waitForFunction(
      () => window.skylens?.role === 'recon',
      undefined,
      { timeout: 15_000 },
    );

    expect(await hasWebGL(page, 'view2')).toBeTruthy();
    // Detections are initialized locally (3 authored markers).
    await expect
      .poll(() => page.evaluate(() => window.skylens.state.detections.length))
      .toBe(3);

    // Render a few frames with no drones yet (unconnected) — must not throw.
    await page.waitForTimeout(800);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('WebRTC integration (SIM <-> RECON)', () => {
  // Needs outbound access to the public PeerJS broker + STUN.
  test('connects, streams state, runs detection choreography', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const room = uniqueRoom();
    const ctx = await browser.newContext();
    const sim = await ctx.newPage();
    const recon = await ctx.newPage();
    const simErrors = trackPageErrors(sim);
    const reconErrors = trackPageErrors(recon);

    await sim.goto(`/sim.html?room=${room}`);
    await recon.goto(`/recon.html?room=${room}`);

    // Both peers report a live DataChannel.
    await expect
      .poll(() => sim.evaluate(() => window.skylens.transport.status), {
        timeout: 45_000,
      })
      .toBe('connected');
    await expect
      .poll(() => recon.evaluate(() => window.skylens.transport.status), {
        timeout: 45_000,
      })
      .toBe('connected');

    // State flows SIM -> RECON: drones + clock + visited appear on RECON.
    await expect
      .poll(() => recon.evaluate(() => window.skylens.state.drones.length), {
        timeout: 15_000,
      })
      .toBe(3);
    await expect
      .poll(() => recon.evaluate(() => window.skylens.state.time), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => recon.evaluate(() => window.skylens.state.visited.length), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // Fast-forward the SIM so detections get revealed on RECON quickly.
    await sim.evaluate(() => {
      window.skylens.CONFIG!.sim.speed = 25;
    });

    // RECON's camera focuses a detection once its area is revealed.
    await recon.waitForFunction(
      () =>
        window.skylens.state.cameraSync === 'FOCUSING' ||
        window.skylens.state.cameraSync === 'LOCKED',
      undefined,
      { timeout: 30_000 },
    );
    await expect(recon.locator('.detect-card.is-open')).toBeVisible({
      timeout: 10_000,
    });

    const total = await recon.evaluate(
      () => window.skylens.state.detections.length,
    );

    // Confirm every revealed detection; the board cycles through the queue.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const confirmed = await recon.evaluate(
        () => window.skylens.state.detections.filter((d) => d.confirmed).length,
      );
      if (confirmed >= total) break;
      const card = recon.locator('.detect-card.is-open');
      if ((await card.count()) === 0) {
        await recon.waitForTimeout(150);
        continue;
      }
      const fid = await recon.evaluate(
        () => window.skylens.state.focusedDetectionId,
      );
      await card.locator('.detect-card__btn').click();
      await expect
        .poll(
          () =>
            recon.evaluate(
              (id) =>
                window.skylens.state.detections.find((d) => d.id === id)
                  ?.confirmed,
              fid,
            ),
          { timeout: 6_000 },
        )
        .toBe(true);
    }

    expect(
      await recon.evaluate(
        () => window.skylens.state.detections.filter((d) => d.confirmed).length,
      ),
    ).toBe(total);

    // Slow down; with nothing left to focus the camera rests at SYNCED.
    await sim.evaluate(() => {
      window.skylens.CONFIG!.sim.speed = 1;
    });
    await expect
      .poll(() => recon.evaluate(() => window.skylens.state.cameraSync), {
        timeout: 15_000,
      })
      .toBe('SYNCED');

    expect(simErrors, simErrors.join('\n')).toEqual([]);
    expect(reconErrors, reconErrors.join('\n')).toEqual([]);
    await ctx.close();
  });
});
