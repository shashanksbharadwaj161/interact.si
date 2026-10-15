import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Bundle the pure ledger module in memory (no files written) and import the result.
const source = fileURLToPath(new URL('../electron/services/usage.ts', import.meta.url));
const out = await build({entryPoints: [source], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent'});
const usage = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {createUsageLedger, UsageValidationError, parseOllamaMetrics, parseCloudUsage, USAGE_LIMITS} = usage;

const T0 = Date.parse('2026-10-14T12:00:00.000Z');
const clock = {t: T0};
let seq = 0;
// Each ledger starts from the same fixed instant so tests cannot leak clock movement into each other.
const ledger = (overrides = {}) => {
  clock.t = T0;
  return createUsageLedger({now: () => new Date(clock.t), newId: () => `id-${++seq}`, ...overrides});
};
const cloud = (over = {}) => ({runtime: 'cloud', provider: 'anthropic', model: 'claude-test', inputTokens: 1000, outputTokens: 500, ...over});
const local = (over = {}) => ({runtime: 'local', provider: 'ollama', model: 'llama-test', inputTokens: 200, outputTokens: 300, generationMs: 3000, ...over});
const priced = (l) => l.setPrices([{provider: 'anthropic', model: 'claude-test', inputPerMillion: 3, outputPerMillion: 15}]);

test('recorded events are validated and rejected with a usage error, never silently stored', () => {
  const l = ledger();
  assert.throws(() => l.recordEvent(cloud({runtime: 'remote'})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({provider: 'Bad Provider!'})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({inputTokens: -1})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({outputTokens: 1.5})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({inputTokens: Number.NaN})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({at: 'not a date'})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({at: new Date(T0 + 2 * 24 * 3600e3).toISOString()})), UsageValidationError);
  assert.throws(() => l.recordEvent(cloud({project: 'line\nbreak'})), UsageValidationError);
  assert.throws(() => l.recordEvent(null), UsageValidationError);
  assert.equal(l.report().totals.events, 0);
});

test('cloud events are priced from the user table; unpriced events are counted, never shown as zero', () => {
  const l = ledger();
  priced(l);
  const e = l.recordEvent(cloud());
  assert.equal(e.costState, 'estimated');
  assert.ok(Math.abs(e.cost - 0.0105) < 1e-12, `expected 0.0105, got ${e.cost}`);
  l.recordEvent(cloud({model: 'unlisted-model'}));
  const r = l.report();
  assert.ok(Math.abs(r.estimatedSpend - 0.0105) < 1e-12);
  assert.equal(r.unpricedEvents, 1);
  assert.equal(r.byModel.find((m) => m.model === 'unlisted-model').estimatedCost, null);
});

test('local events are tokens only: not charged and not counted as unpriced', () => {
  const l = ledger();
  const e = l.recordEvent(local());
  assert.equal(e.costState, 'not-applicable');
  assert.equal(e.cost, null);
  const r = l.report();
  assert.equal(r.estimatedSpend, 0);
  assert.equal(r.unpricedEvents, 0);
  assert.equal(r.totals.outputTokens, 300);
});

test('price tables reject negative, non-finite, oversized and non-list input', () => {
  const l = ledger();
  const ok = {provider: 'anthropic', model: 'm', inputPerMillion: 1, outputPerMillion: 2};
  assert.throws(() => l.setPrices('nope'), UsageValidationError);
  assert.throws(() => l.setPrices([{...ok, inputPerMillion: -1}]), UsageValidationError);
  assert.throws(() => l.setPrices([{...ok, outputPerMillion: Infinity}]), UsageValidationError);
  assert.throws(() => l.setPrices([{...ok, inputPerMillion: USAGE_LIMITS.pricePerMillion + 1}]), UsageValidationError);
  assert.throws(() => l.setPrices(Array.from({length: USAGE_LIMITS.prices + 1}, () => ok)), UsageValidationError);
  assert.equal(l.setPrices([ok]).length, 1);
});

test('reservations hold a conservative maximum until settled, then become one recorded event', () => {
  const l = ledger();
  priced(l);
  const r = l.reserve({provider: 'anthropic', model: 'claude-test', project: 'Launch', maxInputTokens: 1000, maxOutputTokens: 500});
  assert.ok(Math.abs(r.maxCost - 0.0105) < 1e-12);
  assert.ok(Math.abs(l.report().reservedSpend - 0.0105) < 1e-12);
  clock.t += 60_000;
  assert.equal(l.report().reservations[0].ageMs, 60_000);
  assert.equal(l.report().estimatedSpend, 0, 'an unsettled reservation is not yet an event');

  const e = l.settle(r.id, {inputTokens: 400, outputTokens: 100});
  assert.equal(e.project, 'Launch');
  assert.equal(l.report().reservedSpend, 0);
  assert.equal(l.report().reservations.length, 0);
  assert.ok(Math.abs(l.report().estimatedSpend - (400 * 3 + 100 * 15) / 1e6) < 1e-12);
  assert.throws(() => l.settle(r.id, {inputTokens: 1, outputTokens: 1}), UsageValidationError, 'a reservation settles only once');
});

test('reservations are retained when a call never completes (conservative), not dropped', () => {
  const l = ledger();
  priced(l);
  l.reserve({provider: 'anthropic', model: 'claude-test', maxInputTokens: 10, maxOutputTokens: 10});
  clock.t += 30 * 24 * 3600e3;
  assert.equal(l.report().reservations.length, 1);
  assert.ok(l.report().reservedSpend > 0);
});

test('billing is observed only when a snapshot exists; unknown, unsupported and stale stay visibly different', () => {
  const l = ledger();
  priced(l);
  l.recordEvent(cloud({provider: 'anthropic'}));
  let r = l.report();
  assert.equal(r.billing.find((b) => b.provider === 'anthropic').status, 'unsupported', 'no adapter declared');
  l.declareBillingAdapter('anthropic');
  assert.equal(l.report().billing.find((b) => b.provider === 'anthropic').status, 'unknown', 'adapter declared, no snapshot yet');
  assert.equal(l.report().billing.find((b) => b.provider === 'anthropic').balance, null, 'no balance is fabricated');

  const observedAt = new Date(clock.t).toISOString();
  l.recordBilling({provider: 'anthropic', observedAt, balance: 42.5, spent: null, resetsAt: new Date(clock.t + 2 * 3600e3).toISOString()});
  r = l.report().billing.find((b) => b.provider === 'anthropic');
  assert.equal(r.status, 'observed');
  assert.equal(r.balance, 42.5);
  assert.equal(r.spent, null, 'an unreported spend stays null');
  assert.equal(r.resetInMs, 2 * 3600e3);
  assert.equal(r.resetDue, false);

  clock.t += 7 * 3600e3;
  r = l.report().billing.find((b) => b.provider === 'anthropic');
  assert.equal(r.status, 'stale');
  assert.equal(r.resetDue, true, 'reset time has passed, so the countdown is due');
});

test('billing snapshots require a declared adapter and reject invalid balances', () => {
  const l = ledger();
  assert.throws(() => l.recordBilling({provider: 'anthropic', observedAt: new Date(clock.t).toISOString(), balance: 1, spent: null, resetsAt: null}), UsageValidationError);
  l.declareBillingAdapter('anthropic');
  assert.throws(() => l.recordBilling({provider: 'anthropic', observedAt: 'yesterday', balance: 1}), UsageValidationError);
  assert.throws(() => l.recordBilling({provider: 'anthropic', observedAt: new Date(clock.t).toISOString(), balance: -5}), UsageValidationError);
});

test('monthly budget reports conservative spend, threshold alerts and pace from elapsed period', () => {
  const l = ledger();
  priced(l);
  l.setBudget({amount: 1, period: 'month'});
  l.recordEvent(cloud());
  const b = l.report().budget;
  assert.equal(b.periodStart, '2026-10-01T00:00:00.000Z');
  assert.equal(b.periodEnd, '2026-11-01T00:00:00.000Z');
  assert.equal(b.pace, 'on-track');
  assert.ok(b.projected > 0 && b.projected < 1);
  assert.deepEqual(b.alerts.map((a) => a.reached), [false, false, false]);
});

test('budget alerts fire at thresholds and pace turns over-pace when projection exceeds the amount', () => {
  const l = ledger();
  priced(l);
  l.setBudget({amount: 0.01, period: 'month'});
  l.recordEvent(cloud());
  const b = l.report().budget;
  assert.ok(b.fractionUsed > 1);
  assert.deepEqual(b.alerts.map((a) => a.reached), [true, true, true]);
  assert.equal(b.pace, 'over-pace');
  assert.ok(b.remaining < 0);
});

test('budget pace refuses to project from a barely started period', () => {
  const l = ledger();
  clock.t = Date.parse('2026-10-01T00:00:00.000Z');
  l.setBudget({amount: 5, period: 'month'});
  assert.equal(l.report().budget.pace, 'insufficient-data');
  assert.equal(l.report().budget.projected, null);
});

test('budget config validates amount, period and thresholds', () => {
  const l = ledger();
  assert.throws(() => l.setBudget({amount: 1, period: 'year'}), UsageValidationError);
  assert.throws(() => l.setBudget({amount: -1, period: 'month'}), UsageValidationError);
  assert.throws(() => l.setBudget({amount: 1, period: 'day', thresholds: [0]}), UsageValidationError);
  assert.throws(() => l.setBudget({amount: 1, period: 'day', thresholds: Array(11).fill(0.5)}), UsageValidationError);
  assert.equal(l.setBudget(null), null);
});

test('attribution groups spend by project and worker and marks a row unknown when any event is unpriced', () => {
  const l = ledger();
  priced(l);
  l.recordEvent(cloud({project: 'Alpha', worker: 'w1'}));
  l.recordEvent(cloud({project: 'Alpha', worker: 'w1'}));
  l.recordEvent(cloud({project: 'Alpha', worker: 'w2', model: 'unlisted'}));
  l.recordEvent(local({project: 'Beta'}));
  const rows = l.report().attribution;
  const w1 = rows.find((r) => r.project === 'Alpha' && r.worker === 'w1');
  assert.ok(Math.abs(w1.estimatedCost - 0.021) < 1e-12);
  assert.equal(rows.find((r) => r.worker === 'w2').estimatedCost, null);
  assert.equal(rows.find((r) => r.project === 'Beta').estimatedCost, 0, 'local events add nothing but do not make the row unknown');
});

test('Ollama final-chunk metrics are parsed from nanoseconds and yield tokens per second history', () => {
  const m = parseOllamaMetrics({prompt_eval_count: 200, eval_count: 300, eval_duration: 3e9, prompt_eval_duration: 5e8});
  assert.deepEqual(m, {inputTokens: 200, outputTokens: 300, generationMs: 3000, promptMs: 500});
  assert.throws(() => parseOllamaMetrics({eval_count: -3}), UsageValidationError);
  assert.throws(() => parseOllamaMetrics({eval_count: 1, eval_duration: 'slow'}), UsageValidationError);
  assert.deepEqual(parseCloudUsage({input_tokens: 7, output_tokens: 9}), {inputTokens: 7, outputTokens: 9, generationMs: null, promptMs: null});

  const l = ledger();
  l.recordEvent(local(m));
  l.recordEvent(local({model: 'other', outputTokens: 10, generationMs: 1000}));
  l.recordEvent(cloud());
  const all = l.performance();
  assert.equal(all.length, 2, 'only local events with timing are in performance history');
  assert.equal(all[0].model, 'other', 'newest first');
  assert.ok(Math.abs(all[1].tokensPerSecond - 100) < 1e-9);
  assert.equal(l.performance({model: 'other'}).length, 1);
  assert.equal(l.performance({limit: 1}).length, 1);
});

test('CSV export is bounded, escapes cells and neutralises spreadsheet formulas', () => {
  const l = ledger();
  l.recordEvent(local({project: '=HYPERLINK("x")', worker: 'a,b'}));
  const csv = l.exportCsv();
  assert.ok(csv.content.startsWith('at,runtime,provider,model,project,worker,'));
  assert.ok(csv.content.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.content.includes('"a,b"'));
  assert.equal(csv.rows, 1);
  assert.equal(csv.truncated, false);
});

test('exports cap rows and carry a truncated flag rather than growing without limit', () => {
  const l = ledger();
  for (let i = 0; i < USAGE_LIMITS.exportRows + 3; i++) l.recordEvent(local({inputTokens: 1, outputTokens: 1}));
  const csv = l.exportCsv();
  assert.equal(csv.rows, USAGE_LIMITS.exportRows);
  assert.equal(csv.truncated, true);
  const json = JSON.parse(l.exportJson().content);
  assert.equal(json.format, 'desktop-companion-usage');
  assert.equal(json.truncated, true);
  // JSON rows are larger than CSV rows, so the byte bound (not the row cap) ends this export first.
  assert.ok(json.events.length > 0 && json.events.length < USAGE_LIMITS.exportRows);
  assert.ok(l.exportJson().content.length <= USAGE_LIMITS.exportBytes);
  assert.ok(json.disclaimer.includes('Not a provider invoice'));
});

test('JSON export respects the byte bound and the requested time range', () => {
  const l = ledger();
  l.recordEvent(local({at: new Date(T0 - 3 * 3600e3).toISOString(), project: 'old'}));
  l.recordEvent(local({at: new Date(T0 - 60e3).toISOString(), project: 'recent'}));
  const json = JSON.parse(l.exportJson({from: new Date(T0 - 3600e3).toISOString()}).content);
  assert.deepEqual(json.events.map((e) => e.project), ['recent']);
  assert.ok(l.exportJson().content.length <= USAGE_LIMITS.exportBytes);
});

test('the event store is capped, dropping oldest first', () => {
  const l = ledger();
  for (let i = 0; i < USAGE_LIMITS.events + 2; i++) l.recordEvent(local({inputTokens: 1}));
  assert.equal(l.report().totals.events, USAGE_LIMITS.events);
});

test('state round-trips through snapshot and loadState, rejecting malformed rows individually', () => {
  const a = ledger();
  priced(a);
  a.declareBillingAdapter('anthropic');
  a.setBudget({amount: 2, period: 'day'});
  a.recordEvent(cloud({project: 'Alpha'}));
  a.reserve({provider: 'anthropic', model: 'claude-test', maxInputTokens: 5, maxOutputTokens: 5});
  const state = JSON.parse(JSON.stringify(a.snapshot()));
  state.events.push({id: 'bad', at: 'nope', runtime: 'cloud'});
  state.prices.push({provider: 'x', model: 'y', inputPerMillion: -1, outputPerMillion: 0});

  const b = ledger();
  const result = b.loadState(state);
  assert.equal(result.rejected, 2);
  const r = b.report();
  assert.equal(r.totals.events, 1);
  assert.equal(r.reservations.length, 1);
  assert.equal(r.budget.amount, 2);
  assert.ok(Math.abs(r.estimatedSpend - 0.0105) < 1e-12);
  assert.throws(() => b.loadState({schemaVersion: 99}), UsageValidationError);
});

test('loading state drops billing for providers without a declared adapter and events beyond retention', () => {
  const a = ledger();
  a.declareBillingAdapter('anthropic');
  a.recordBilling({provider: 'anthropic', observedAt: new Date(clock.t).toISOString(), balance: 1, spent: null, resetsAt: null});
  const state = JSON.parse(JSON.stringify(a.snapshot()));
  state.declaredBilling = [];
  state.events = [{...local(), id: 'old', at: new Date(T0 - 400 * 24 * 3600e3).toISOString(), runtime: 'local', cost: null, costState: 'not-applicable', generationMs: null, promptMs: null, project: null, worker: null}];
  const b = ledger();
  b.loadState(state);
  assert.equal(b.report().totals.events, 0, 'retention cutoff applies on load');
  assert.equal(b.report().billing.length, 0, 'billing without a declared adapter is not restored');
});

// Panel tests render real ledger reports through the component, so the props have the module's actual shape.
const root = fileURLToPath(new URL('..', import.meta.url));
const ui = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'usage-ui-entry.ts',
    loader: 'ts',
    contents: `export {UsagePanel, fmtMoney} from './src/components/UsagePanel.tsx'; export {renderToStaticMarkup} from 'react-dom/server';`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  logLevel: 'silent',
  // react-dom/server is CommonJS and calls require() internally; a data: module has no file URL, so anchor require to the repo.
  banner: {js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(root + 'package.json')});`},
});
const {UsagePanel, fmtMoney, renderToStaticMarkup} = await import(`data:text/javascript;base64,${Buffer.from(ui.outputFiles[0].text).toString('base64')}`);
const React = await import('react');
const render = (props) => renderToStaticMarkup(React.createElement(UsagePanel, props));

test('panel shows Unknown, never zero, for unavailable money', () => {
  assert.equal(fmtMoney(null), 'Unknown');
  assert.match(fmtMoney(0), /\$0\.00/);
  const l = ledger();
  l.declareBillingAdapter('anthropic');
  l.recordEvent(cloud());
  const html = render({report: l.report()});
  assert.match(html, /Unknown: no snapshot/);
  assert.match(html, /Spend is partial/);
  assert.match(html, /Not a provider invoice/);
  assert.doesNotMatch(html, /Export CSV/, 'export controls appear only when a handler is supplied');
});

test('panel renders an empty state instead of invented figures when no report is loaded', () => {
  const html = render({report: null});
  assert.match(html, /Usage is not loaded yet/);
  assert.doesNotMatch(html, /Estimated spend/);
});

test('budget meter caps its visible value at 100 and marks over-pace', () => {
  const l = ledger();
  clock.t = T0;
  l.setPrices([{provider: 'anthropic', model: 'claude-test', inputPerMillion: 3, outputPerMillion: 15}]);
  l.setBudget({amount: 0.01, period: 'month'});
  l.recordEvent(cloud());
  const html = render({report: l.report()});
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /Over pace/);
  assert.match(html, /over\./);
});

test('export controls render when a handler is supplied', () => {
  const l = ledger();
  const html = render({report: l.report(), onExport: () => {}});
  assert.match(html, /Export CSV/);
  assert.match(html, /Export JSON/);
});
