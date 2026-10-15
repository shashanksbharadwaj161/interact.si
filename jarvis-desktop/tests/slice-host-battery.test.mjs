// Host battery reader (Electron powerMonitor behind an injectable adapter), the Battery Status API -> host -> unmeasured
// fallback in resource-policy, the bridge/preload/IPC wiring and the Status.tsx labels. Fakes only: no real power state,
// no Electron, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'slice-host-battery-entry.ts',
    loader: 'ts',
    contents: `
      export * as policy from './src/ui/resource-policy.ts';
      export { System, HostBatteryReader, powerMonitorAdapter } from './electron/services/system.ts';
      export { hostBatteryBridge, navigatorBatteryReader, createHostBatteryApi, parseHostBatteryStatus } from './src/ui/bridges.ts';
      export { HOST_BATTERY_EVENT, METHODS } from './electron/channels.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {policy: p, HostBatteryReader, powerMonitorAdapter, hostBatteryBridge, navigatorBatteryReader, createHostBatteryApi, parseHostBatteryStatus, HOST_BATTERY_EVENT, METHODS} = mod;
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const NOW = () => Date.parse('2025-01-02T03:04:05.000Z');

test('host reader: adapter reports on battery and on AC with source host and an ISO timestamp, never a level', () => {
  let onBattery = true;
  const r = new HostBatteryReader({isOnBatteryPower: () => onBattery}, NOW);
  assert.deepEqual(r.read(), {source: 'host', onBattery: true, measuredAt: '2025-01-02T03:04:05.000Z'});
  onBattery = false;
  const ac = r.read();
  assert.deepEqual(ac, {source: 'host', onBattery: false, measuredAt: '2025-01-02T03:04:05.000Z'});
  assert.ok(!('level' in ac) && !('percent' in ac));
});

test('host reader: missing, throwing or malformed adapter yields unmeasured without throwing', () => {
  for (const adapter of [undefined, null, {}, {isOnBatteryPower: () => { throw new Error('no power api'); }}, {isOnBatteryPower: () => 'yes'}]) {
    const r = new HostBatteryReader(adapter, NOW);
    assert.deepEqual(r.read(), {source: 'unmeasured', onBattery: null, measuredAt: '2025-01-02T03:04:05.000Z'});
    const off = r.subscribe(() => assert.fail('no events from a missing adapter'));
    assert.equal(typeof off, 'function');
    off();
  }
  const pmNoFn = powerMonitorAdapter(new EventEmitter());
  assert.equal(new HostBatteryReader(pmNoFn, NOW).read().source, 'unmeasured');
});

test('powerMonitor adapter: on-battery/on-ac events update subscribers, unsubscribe and dispose detach listeners', () => {
  const pm = new EventEmitter();
  let state = false;
  pm.isOnBatteryPower = () => state;
  const r = new HostBatteryReader(powerMonitorAdapter(pm), NOW);
  assert.equal(r.read().onBattery, false);
  const seen = [];
  const off = r.subscribe((s) => seen.push(s));
  r.subscribe(() => { throw new Error('broken view'); });
  state = true;
  pm.emit('on-battery');
  pm.emit('on-ac');
  assert.deepEqual(seen.map((s) => [s.source, s.onBattery]), [['host', true], ['host', false]]);
  assert.equal(r.read().onBattery, true);
  off();
  pm.emit('on-battery');
  assert.equal(seen.length, 2);
  assert.equal(pm.listenerCount('on-battery'), 1);
  r.dispose();
  assert.equal(pm.listenerCount('on-battery'), 0);
  assert.equal(pm.listenerCount('on-ac'), 0);
});

test('fallback order: Battery Status API first, then host bridge, then unmeasured', async () => {
  const browser = navigatorBatteryReader(async () => ({charging: false, level: 0.42}));
  const host = async () => ({source: 'host', onBattery: false, measuredAt: '2025-01-01T00:00:00.000Z'});
  const a = await p.resolveBatteryStatus({browser, host, now: NOW});
  assert.equal(a.source, 'navigator');
  assert.equal(a.onBattery, true);
  assert.equal(a.level, 0.42);
  assert.equal(p.batteryLabel(a), 'Battery: on battery, 42% (navigator)');
  assert.deepEqual(p.batteryTelemetry(a), {charging: false, level: 0.42});

  assert.equal(navigatorBatteryReader(undefined), null);
  const b = await p.resolveBatteryStatus({browser: navigatorBatteryReader(undefined), host: async () => ({source: 'host', onBattery: true, measuredAt: 'x'}), now: NOW});
  assert.deepEqual(b, {source: 'host', onBattery: true, charging: null, level: null, measuredAt: '2025-01-02T03:04:05.000Z'});
  assert.equal(p.batteryLabel(b), 'Battery: on battery (host)');
  assert.equal(p.batteryTelemetry(b), null, 'host gives no level, so no low-battery suggestion is invented');
  assert.equal(p.batterySaverMotionActive(b, true), true);
  assert.equal(p.batterySaverMotionActive(b, false), false);

  const c = await p.resolveBatteryStatus({browser: async () => { throw new Error('denied'); }, host: async () => ({source: 'host', onBattery: false}), now: NOW});
  assert.equal(p.batteryLabel(c), 'Battery: on AC power (host)');
  assert.equal(p.batterySaverMotionActive(c, true), false);

  const d = await p.resolveBatteryStatus({now: NOW});
  assert.deepEqual(d, {source: 'unmeasured', onBattery: null, charging: null, level: null, measuredAt: '2025-01-02T03:04:05.000Z'});
  assert.equal(p.batteryLabel(d), 'Battery: unmeasured');
  assert.equal(p.batterySaverMotionActive(d, true), false);
});

test('fallback: rejection, timeout, unmeasured host and malformed results fall back without throwing', async () => {
  const never = () => new Promise(() => {});
  const r1 = await p.resolveBatteryStatus({browser: never, host: never, timeoutMs: 10, now: NOW});
  assert.equal(r1.source, 'unmeasured');
  const r2 = await p.resolveBatteryStatus({host: async () => ({source: 'unmeasured', onBattery: null}), now: NOW});
  assert.equal(r2.source, 'unmeasured');
  const r3 = await p.resolveBatteryStatus({browser: async () => ({source: 'navigator', charging: 'maybe'}), host: () => { throw new Error('sync throw'); }, now: NOW});
  assert.equal(r3.source, 'unmeasured');
  const r4 = await p.resolveBatteryStatus({browser: async () => ({source: 'host', charging: false, level: 0.1}), now: NOW});
  assert.equal(r4.source, 'unmeasured', 'a browser reading cannot claim the host label');
  const r5 = await p.resolveBatteryStatus({browser: navigatorBatteryReader(async () => null), host: async () => ({source: 'host', onBattery: true}), now: NOW});
  assert.equal(r5.source, 'host');
});

test('event update path: host events update host/unmeasured state but never override a Battery Status API reading', () => {
  const un = p.unmeasuredBattery(NOW);
  const up = p.applyHostBatteryEvent(un, {source: 'host', onBattery: true, measuredAt: '2025-01-02T03:04:06.000Z'}, NOW);
  assert.equal(p.batteryLabel(up), 'Battery: on battery (host)');
  const down = p.applyHostBatteryEvent(up, {source: 'host', onBattery: false}, NOW);
  assert.equal(p.batteryLabel(down), 'Battery: on AC power (host)');
  assert.equal(p.applyHostBatteryEvent(down, {source: 'host', onBattery: 'x'}, NOW), down);
  assert.equal(p.applyHostBatteryEvent(null, null, NOW), null);
  const nav = p.normalizeBrowserBattery({source: 'navigator', charging: true, level: 1}, NOW);
  assert.equal(p.applyHostBatteryEvent(nav, {source: 'host', onBattery: true}, NOW), nav);
});

test('preload host API: unmeasured until a valid push, caches the latest, forwards changes, drops malformed pushes', async () => {
  let push = null;
  let detached = false;
  const host = createHostBatteryApi((l) => { push = l; return () => { detached = true; }; }, NOW);
  assert.deepEqual(await host.hostBattery(), {source: 'unmeasured', onBattery: null, measuredAt: '2025-01-02T03:04:05.000Z'});
  const seen = [];
  const off = host.onHostBattery((s) => seen.push(s));
  host.onHostBattery(() => { throw new Error('broken view'); });
  push({source: 'host', onBattery: true, measuredAt: '2025-01-02T03:04:06.000Z'});
  push({source: 'host', onBattery: 'yes', measuredAt: '2025-01-02T03:04:07.000Z'});
  push({source: 'navigator', onBattery: true, measuredAt: '2025-01-02T03:04:07.000Z'});
  push(null);
  assert.deepEqual(await host.hostBattery(), {source: 'host', onBattery: true, measuredAt: '2025-01-02T03:04:06.000Z'});
  assert.equal(seen.length, 1);
  off();
  push({source: 'host', onBattery: false, measuredAt: '2025-01-02T03:04:08.000Z'});
  assert.equal(seen.length, 1);
  assert.equal((await host.hostBattery()).onBattery, false);
  assert.equal(detached, false);
  assert.throws(() => host.onHostBattery('nope'), TypeError);
  assert.equal(parseHostBatteryStatus({source: 'unmeasured', onBattery: null, measuredAt: '2025-01-02T03:04:05.000Z'}).source, 'unmeasured');
  assert.equal(parseHostBatteryStatus({source: 'host', onBattery: true, measuredAt: 'not a date'}), null);
});

test('bridge: hostBatteryBridge exposes read and subscribe only when the API has them', async () => {
  assert.equal(hostBatteryBridge({}), null);
  assert.equal(hostBatteryBridge(undefined), null);
  const handlers = [];
  const api = {hostBattery: async () => ({source: 'host', onBattery: true, measuredAt: 'x'}), onHostBattery: (h) => { handlers.push(h); return () => handlers.splice(handlers.indexOf(h), 1); }};
  const b = hostBatteryBridge(api);
  assert.deepEqual(await b.read(), {source: 'host', onBattery: true, measuredAt: 'x'});
  const off = b.subscribe(() => {});
  assert.equal(handlers.length, 1);
  off();
  assert.equal(handlers.length, 0);
  assert.equal(hostBatteryBridge({hostBattery: api.hostBattery}).subscribe, undefined);
});

test('IPC wiring: push-only trusted channel, no new METHODS entry or handler, separate read-only preload surface', () => {
  assert.equal(HOST_BATTERY_EVENT, 'jarvis:hostBatteryChanged');
  assert.ok(!METHODS.includes('hostBattery') && !METHODS.includes('onHostBattery'));
  const ipc = read('electron/ipc.ts');
  assert.ok(!/ipcMain\.(handle|on)\(HOST_BATTERY/.test(ipc), 'the renderer cannot send on the battery channel');
  assert.match(ipc, /isTrustedUrl\(wc\.getURL\(\), opts\.appFileUrl, opts\.devOrigin\)\) wc\.send\(HOST_BATTERY_EVENT, status\)/);
  assert.match(ipc, /powerMonitorAdapter\(powerMonitor/);
  assert.match(ipc, /'did-finish-load'/);
  assert.match(ipc, /stopBattery\(\);/);
  const preload = read('electron/preload.ts');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('jarvisHost', jarvisHost\)/);
  assert.match(preload, /ipcRenderer\.removeListener\(HOST_BATTERY_EVENT, l\)/);
  assert.ok(!/invoke\([^)]*HOST_BATTERY/.test(preload));
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /export type BatterySource='host'\|'navigator'\|'unmeasured'/);
  assert.match(contracts, /hostBattery\?\(\):Promise<HostBatteryStatus>/);
  assert.match(contracts, /jarvisHost\?:HostBatteryAPI/);
});

test('Status.tsx wiring: fallback order, honest source labels and listener cleanup on unmount', () => {
  const s = read('src/components/Status.tsx');
  assert.match(s, /navigatorBatteryReader\(nav\?\.getBattery, nav\)/);
  assert.match(s, /hostBatteryBridge\(typeof window !== 'undefined' \? window\.jarvisHost : null\)/);
  assert.match(s, /resolveBatteryStatus\(\{ browser, host:/);
  assert.match(s, /applyHostBatteryEvent\(cur, s\)/);
  assert.match(s, /batteryLabel\(battery\)/);
  assert.match(s, /unmeasuredBattery\(\)/);
  assert.match(s, /alive = false;\s*try \{ off\?\.\(\); \}/);
  assert.match(s, /the host gives no percentage/);
  assert.match(s, /<BatteryPanel \/>/);
});
