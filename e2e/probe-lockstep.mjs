/**
 * Drives a real two-player lockstep session in a real browser and reports what
 * actually happens to a keypress.
 *
 * Not a test - a probe. It exists because "the controls do not work" can mean
 * the key never reached the collector, the pad never left the session, or the
 * pad arrived and the emulator ignored it, and those three have nothing in
 * common except the symptom.
 *
 *   node e2e/probe-lockstep.mjs
 *
 * Needs the stack up with AUTH_MODE=dev, and a ROM in the library.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Reuse whatever chromium is already in the playwright cache, the way
 * e2e/playwright.config.ts does. The bundled download expects one exact build
 * number and fails on any other, which on a machine that already has a browser
 * is a pointless download.
 */
function findChromium() {
	if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
	const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
	if (!fs.existsSync(cache)) return undefined;
	const builds = fs
		.readdirSync(cache)
		.filter((d) => d.startsWith('chromium-'))
		.sort()
		.reverse();
	for (const build of builds) {
		const bin = path.join(cache, build, 'chrome-linux64', 'chrome');
		if (fs.existsSync(bin)) return bin;
	}
	return undefined;
}

const API = process.env.E2E_API_URL || 'http://localhost:3000';
const APP = process.env.E2E_APP_URL || 'http://localhost:5173';

async function loginDev(userId) {
	const res = await fetch(`${API}/auth/dev/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userId })
	});
	if (!res.ok) throw new Error(`dev login ${userId} failed: ${res.status}`);
	return res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
}

function cookieObjects(header) {
	return header.split('; ').map((pair) => {
		const eq = pair.indexOf('=');
		return {
			name: pair.slice(0, eq),
			value: pair.slice(eq + 1),
			domain: 'localhost',
			path: '/'
		};
	});
}

async function api(cookie, path, init = {}) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers || {}) }
	});
	return res.json().catch(() => ({}));
}

const log = (...args) => console.log(...args);

const executablePath = findChromium();
const browser = await chromium.launch({
	...(executablePath ? { executablePath } : {}),
	args: ['--no-sandbox']
});

try {
	const hostCookie = await loginDev('1');
	const guestCookie = await loginDev('2');

	const games = await api(hostCookie, '/api/games');
	if (!Array.isArray(games) || games.length === 0) {
		throw new Error('Dev User 1 has no games; upload a ROM first');
	}
	const game = games[0];
	log(`ROM: ${game.title}`);

	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	await hostCtx.addCookies(cookieObjects(hostCookie));
	await guestCtx.addCookies(cookieObjects(guestCookie));

	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();

	for (const [name, page] of [
		['host', host],
		['guest', guest]
	]) {
		page.on('console', (m) => log(`  [${name} ${m.type()}] ${m.text().slice(0, 300)}`));
		page.on('requestfailed', (r) =>
			log(`  [${name} requestfailed] ${r.url().slice(0, 140)} ${r.failure()?.errorText ?? ''}`)
		);
		page.on('response', (r) => {
			if (r.status() >= 400) log(`  [${name} HTTP ${r.status()}] ${r.url().slice(0, 140)}`);
		});
		page.on('pageerror', (e) => log(`  [${name} pageerror] ${String(e).slice(0, 200)}`));
	}

	// Create the room through the socket the app itself uses, so the room ends
	// up in exactly the state the UI would produce.
	await host.goto(APP);
	await host.waitForTimeout(2500);

	// Click the real button. The app's room:created handler only exists inside
	// its own click handler, so emitting room:create on the socket creates a
	// room that nothing navigates to.
	await host.waitForSelector('.btn-play', { timeout: 15000 });
	await host.locator('.btn-play').first().click();
	await host.waitForURL(/\/room\//, { timeout: 15000 });
	const roomId = host.url().split('/room/')[1];
	log(`room: ${roomId}`);

	// Rooms are created in streaming mode; switch to the mode under test the
	// same way the lobby's selector does.
	await host.evaluate(
		(id) => window.__psnesSocket?.emit('room:setEmulationMode', { roomId: id, emulationMode: 'lockstep' }),
		roomId
	);

	await guest.goto(`${APP}/room/${roomId}`);
	await host.waitForTimeout(3000);

	// The lobby requires a controller port and a ready flag before it will let
	// the game start, so the probe has to go through the same gate a player does.
	await guest.evaluate((id) => window.__psnesSocket?.emit('room:join', { roomId: id }), roomId);
	await host.waitForTimeout(1500);

	// selectPort already sets isReady; toggling after it turns readiness back off.
	await host.evaluate(
		(id) => window.__psnesSocket?.emit('room:selectPort', { roomId: id, port: 1 }),
		roomId
	);
	await guest.evaluate(
		(id) => window.__psnesSocket?.emit('room:selectPort', { roomId: id, port: 2 }),
		roomId
	);
	await host.waitForTimeout(1500);

	// Report what the lobby thinks before trying to start, so a refusal is
	// legible instead of a timeout.

	const startButton = host.locator('.btn-start');
	log(`start button disabled: ${await startButton.isDisabled()}`);
	await startButton.click({ force: true });
	// The failure only appeared when the resync landed early in the session, so
	// how long the session runs before it is forced is the knob that matters.
	await host.waitForTimeout(Number(process.env.PROBE_WARMUP ?? 25000));

	for (const [name, page] of [
		['host', host],
		['guest', guest]
	]) {
		const state = await page.evaluate(() => {
			const z = window.__znet;
			return {
				znet: !!z,
				canvas: !!document.querySelector('canvas'),
				lockstepRoot: !!document.querySelector('.lockstep'),
				overlayText: document.querySelector('.overlay')?.textContent?.trim().slice(0, 120) ?? null,
				bodyStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
				stats: z ? z.stats() : null,
				pad: z ? z.readPad() : null
			};
		});
		log(`${name}: ${JSON.stringify(state, null, 1)}`);
		const keys = await page.evaluate(() => window.__znet?.collector?.codeToBit
			? [...window.__znet.collector.codeToBit.entries()]
			: null);
		log(`${name} bindings: ${JSON.stringify(keys)}`);
		await page.screenshot({ path: `/tmp/claude-1000/-home-pleymor-projects-psnes-repos-psnes/8dc8d0fa-4815-4165-84b0-60ea91d0a042/scratchpad/${name}.png` });
	}

	// Tally netplay message types in both directions. 1=Hello 3=Pads 4=Crc
	// 5=State 6=StateAck 7=Desync 8=Ping 9=Pong
	for (const [, page] of [['host', host], ['guest', guest]]) {
		await page.evaluate(() => {
			const sock = window.__psnesSocket;
			window.__tx = {};
			window.__rx = {};
			const origEmit = sock.emit.bind(sock);
			sock.emit = (ev, payload, ...rest) => {
				if (ev === 'znet:packet' && payload?.payload) {
					const t = new Uint8Array(payload.payload)[0];
					window.__tx[t] = (window.__tx[t] ?? 0) + 1;
				}
				return origEmit(ev, payload, ...rest);
			};
			sock.on('znet:packet', (e) => {
				const t = new Uint8Array(e.payload)[0];
				window.__rx[t] = (window.__rx[t] ?? 0) + 1;
			});
		});
	}

	// Force a resync and watch whether the session comes back.
	log('\n-- resync forcé --');
	const before = await host.evaluate(() => window.__znet.stats().frame);
	await host.evaluate(() => window.__znet.session.requestResync('probe'));
	for (let i = 0; i < 8; i++) {
		await host.waitForTimeout(2000);
		const row = [];
		for (const [n, page] of [['host', host], ['guest', guest]]) {
			const v = await page.evaluate(() => {
				const st = window.__znet.stats();
				return { s: window.__znet.session.state, f: st.frame, e: st.epoch, boot: window.__znet.boot, types: { tx: window.__tx, rx: window.__rx } };
			});
			row.push(`${n} boot=${v.boot} ${v.s} f=${v.f} ep=${v.e} tx=${JSON.stringify(v.types.tx)} rx=${JSON.stringify(v.types.rx)}`);
		}
		log(`  t+${(i + 1) * 2}s (départ f=${before})  ${row.join('  |  ')}`);
	}

	log('\n-- 60s de surveillance --');
	for (const [name, page] of [['host', host], ['guest', guest]]) {
		await page.evaluate(() => {
			window.__roomEvents = [];
			window.__psnesSocket?.on('room:updated', (r) =>
				window.__roomEvents.push({ n: r.players.length, at: Date.now() })
			);
			window.__psnesSocket?.on('disconnect', () => window.__roomEvents.push('DISCONNECT'));
		});
	}
	for (let i = 0; i < 6; i++) {
		await host.waitForTimeout(10000);
		const line = [];
		for (const [name, page] of [['host', host], ['guest', guest]]) {
			const v = await page.evaluate(() => ({
				boots: window.__znetBoots ?? 0,
				frame: window.__znet?.stats().frame ?? null,
				state: window.__znet?.session?.state ?? null,
				odd: (window.__roomEvents ?? []).filter((e) => e === 'DISCONNECT' || e.n !== 2).length
			}));
			line.push(`${name} boot=${v.boots} frame=${v.frame} ${v.state} anomalies=${v.odd}`);
		}
		log(`  t+${(i + 1) * 10}s  ${line.join('  |  ')}`);
	}

	// The actual question: does a keypress become a pad bit, and does the
	// emulator advance while it is held?
	log('\n-- pressing X (button A) on the host for 2s --');
	await host.keyboard.down('x');
	await host.waitForTimeout(300);
	log(`host pad while held: ${await host.evaluate(() => window.__znet?.readPad())}`);
	await host.waitForTimeout(1700);
	await host.keyboard.up('x');
	log(`host pad after release: ${await host.evaluate(() => window.__znet?.readPad())}`);

	for (const [name, page] of [
		['host', host],
		['guest', guest]
	]) {
		const stats = await page.evaluate(() => window.__znet?.stats());
		log(`${name} final: ${JSON.stringify(stats)}`);
		const evs = await page.evaluate(() => window.__znetEvents ?? []);
		log(`${name} events: ${JSON.stringify(evs.slice(-8))}`);
	}
} finally {
	await browser.close();
}
