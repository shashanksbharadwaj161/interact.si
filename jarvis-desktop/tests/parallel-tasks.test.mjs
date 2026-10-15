// Task board tests: filtering, counts, overdue/date truth, grouping order, and the rendered screen (filters, selected-task
// details, keyboard hints, empty states). Bundles the real TypeScript in memory with stubbed store/focus hooks; no DOM,
// no real files, desktop, network or Electron. Dates are computed relative to today so the suite never goes stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const iconNames = new Set();
for (const dir of ['src/components', 'src/ui']) {
  for (const f of await readdir(path.join(root, dir))) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = await readFile(path.join(root, dir, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
}

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'tasks-test-entry.ts',
    loader: 'tsx',
    contents: `
      export * from './src/components/Tasks.tsx';
      export { localDateKey } from './src/ui/util.ts';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'stub' }));
        b.onResolve({ filter: /\/ui\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
        b.onResolve({ filter: /\/ui\/focus$/ }, () => ({ path: 'focus', namespace: 'stub' }));
        b.onLoad({ filter: /^icons$/, namespace: 'stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
        b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ contents: 'export const useReady = () => globalThis.__store; export const useStore = () => globalThis.__store; export const useOptionalStore = () => globalThis.__store ?? null;' }));
        b.onLoad({ filter: /^focus$/, namespace: 'stub' }, () => ({ contents: 'export const useFocus = () => globalThis.__focus; export const FocusProvider = ({children}) => children;' }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { taskGroup, taskMatches, filterCounts, daysBetween, dueSummary, groupTasks, TASK_FILTERS, Tasks, localDateKey, createElement, renderToStaticMarkup } = mod;

// ---- fixtures ------------------------------------------------------------------------------------------------------
const TODAY = '2026-10-15';
const t = (id, title, o = {}) => ({ id, title, done: false, createdAt: `2026-10-0${1 + Number(id.replace(/\D/g, '') || 0) % 9}T08:00:00.000Z`, ...o });
const TASKS = [
  t('a1', 'Pay rent', { due: '2026-10-10' }),
  t('a2', 'Send report', { due: '2026-10-15' }),
  t('a3', 'Book flights', { due: '2026-10-18' }),
  t('a4', 'Tidy desk'),
  t('a5', 'Old finished thing', { done: true, due: '2026-09-01' }),
  t('a6', 'Done today', { done: true }),
];

// ---- pure logic ----------------------------------------------------------------------------------------------------
test('taskGroup: completed tasks are never overdue; dates drive the rest', () => {
  assert.deepEqual(TASKS.map((x) => taskGroup(x, TODAY)), ['overdue', 'today', 'upcoming', 'none', 'done', 'done']);
  assert.equal(taskGroup(t('x', 'x', { due: '2026-10-15T23:30:00.000Z' }), TODAY), 'today', 'a stored timestamp is bucketed by its date part, as on Home');
});

test('filterCounts match what each filter actually shows', () => {
  const c = filterCounts(TASKS, TODAY);
  assert.deepEqual(c, { all: 6, open: 4, overdue: 1, today: 1, upcoming: 1, none: 1, done: 2 });
  for (const f of TASK_FILTERS) {
    assert.equal(TASKS.filter((x) => taskMatches(x, f.id, '', TODAY)).length, c[f.id], f.id);
  }
});

test('taskMatches combines status with a case-insensitive title search and ignores blank queries', () => {
  assert.equal(taskMatches(TASKS[0], 'overdue', 'RENT', TODAY), true);
  assert.equal(taskMatches(TASKS[0], 'overdue', 'flights', TODAY), false);
  assert.equal(taskMatches(TASKS[0], 'done', '', TODAY), false);
  assert.equal(taskMatches(TASKS[3], 'all', '   ', TODAY), true);
  assert.equal(taskMatches(TASKS[4], 'open', '', TODAY), false, 'completed tasks are not open');
});

test('daysBetween counts calendar days and is unaffected by month/year ends and DST', () => {
  assert.equal(daysBetween('2026-10-15', '2026-10-15'), 0);
  assert.equal(daysBetween('2026-10-15', '2026-10-10'), -5);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-30', '2026-11-02'), 3);
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2, 'leap year');
});

test('dueSummary states overdue, today, upcoming, none and completed truthfully', () => {
  assert.match(dueSummary(TASKS[0], TODAY), /^Overdue by 5 days \(due .*10.*\)$/);
  assert.match(dueSummary(t('o', 'o', { due: '2026-10-14' }), TODAY), /^Overdue by 1 day \(/);
  assert.match(dueSummary(TASKS[1], TODAY), /^Due today \(/);
  assert.match(dueSummary(TASKS[2], TODAY), /^Due in 3 days \(/);
  assert.match(dueSummary(t('u', 'u', { due: '2026-10-16' }), TODAY), /^Due in 1 day \(/);
  assert.equal(dueSummary(TASKS[3], TODAY), 'No due date');
  assert.match(dueSummary(TASKS[4], TODAY), /^Was due /, 'a completed task is not reported as overdue');
  assert.doesNotMatch(dueSummary(TASKS[4], TODAY), /verdue/);
  assert.equal(dueSummary(TASKS[5], TODAY), 'No due date');
});

test('the same task moves from upcoming to today to overdue as the date advances', () => {
  const x = t('m', 'moving', { due: '2026-10-16' });
  assert.deepEqual(['2026-10-15', '2026-10-16', '2026-10-17'].map((d) => taskGroup(x, d)), ['upcoming', 'today', 'overdue']);
});

test('groupTasks orders by due date then creation, completed newest-created first, without mutating input', () => {
  const input = [
    t('b1', 'late B', { due: '2026-10-09', createdAt: '2026-10-02T00:00:00.000Z' }),
    t('b2', 'late A', { due: '2026-10-09', createdAt: '2026-10-01T00:00:00.000Z' }),
    t('b3', 'later', { due: '2026-10-12', createdAt: '2026-09-01T00:00:00.000Z' }),
    t('b4', 'done old', { done: true, createdAt: '2026-08-01T00:00:00.000Z' }),
    t('b5', 'done new', { done: true, createdAt: '2026-09-01T00:00:00.000Z' }),
  ];
  const before = input.map((x) => x.id).join();
  const g = groupTasks(input, TODAY);
  assert.deepEqual(g.overdue.map((x) => x.id), ['b2', 'b1', 'b3']);
  assert.deepEqual(g.done.map((x) => x.id), ['b5', 'b4']);
  assert.equal(input.map((x) => x.id).join(), before);
});

// ---- rendered screen -----------------------------------------------------------------------------------------------
const settings = { onboarded: true, mode: 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'm', localEndpoint: 'http://127.0.0.1:11434', cloudModel: '', voice: '', allowedRoots: [], approvedApps: [], retainDays: 30 };
function render(tasks) {
  const noop = async () => true;
  globalThis.__store = {
    status: 'ready', loadError: null, settings, state: { settings, capsules: [], notes: [], tasks, chat: [], activity: [] },
    api: { saveTask: async () => ({}), deleteTask: async () => ({}) }, productivityApi: null, productivity: null,
    applyProductivity: noop, mutate: noop, toast: () => {},
  };
  globalThis.__focus = { phase: 'idle', durationSec: 1500, remainingSec: 1500, taskId: null, taskTitle: null, start() {}, pause() {}, resume() {}, reset() {} };
  return renderToStaticMarkup(createElement(Tasks));
}
const real = localDateKey();
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDateKey(d); };

test('screen shows a count on every status chip and lists tasks in overdue → completed groups relative to the real today', () => {
  const html = render([
    t('r1', 'Overdue one', { due: shift(-3) }),
    t('r2', 'Today one', { due: real }),
    t('r3', 'Later one', { due: shift(4) }),
    t('r4', 'Undated one'),
    t('r5', 'Finished one', { done: true, due: shift(-9) }),
  ]);
  for (const [label, n] of [['All', 5], ['Open', 4], ['Overdue', 1], ['Due today', 1], ['Upcoming', 1], ['No date', 1], ['Completed', 1]]) {
    assert.match(html, new RegExp(`aria-pressed="(true|false)"[^>]*>${label} · ${n}<|>${label}(?:\\s|<!-- -->)*·(?:\\s|<!-- -->)*${n}<`), `${label} chip count ${n}`);
  }
  assert.match(html, /aria-pressed="true"[^>]*>All/, 'starts on All');
  const order = ['Overdue · 1', 'Due today · 1', 'Upcoming · 1', 'No date · 1', 'Completed · 1'].map((h) => html.replace(/<!-- -->/g, '').indexOf(h));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => !i || v > order[i - 1]), `group order ${order}`);
  const plain = html.replace(/<!-- -->/g, '');
  assert.equal((plain.match(/class="badge badge-danger"[^>]*>Overdue · /g) ?? []).length, 1, 'only the open overdue task carries a dated overdue badge, in text not colour alone');
  assert.match(html.replace(/<!-- -->/g, ''), /Showing 5 of 5 tasks/);
});

test('completed tasks are not flagged overdue on screen', () => {
  const html = render([t('d1', 'Finished late', { done: true, due: shift(-30) })]);
  const plain = html.replace(/<!-- -->/g, '');
  assert.doesNotMatch(plain, /badge-danger/, 'no overdue badge');
  assert.match(plain, />Overdue · 0</, 'overdue count chip is zero');
  assert.match(plain, /Completed · 1/);
});

test('each task title is a keyboard-focusable button with a descriptive name; checkbox, edit and delete stay explicit', () => {
  const html = render([t('k1', 'Write tests')]);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Show details for “Write tests”"/);
  assert.match(html, /aria-label="Complete “Write tests”"/);
  assert.match(html, /aria-label="Edit “Write tests”"/);
  assert.match(html, /aria-label="Delete “Write tests”"/);
  assert.match(html, /Up and Down arrows move between tasks/);
  assert.match(html, /there is no manual order/, 'does not imply drag reordering exists');
  assert.doesNotMatch(html, /draggable/);
});

test('no details panel until a task is selected; no invented progress or completion percentage', () => {
  const html = render(TASKS);
  assert.doesNotMatch(html, /Task details/);
  assert.doesNotMatch(html, /%/, 'no made-up completion percentage');
  assert.doesNotMatch(html, /autonomous|running automatically/i);
});

test('empty list explains itself and offers no filter controls', () => {
  const html = render([]);
  assert.match(html, /No tasks yet/);
  assert.doesNotMatch(html, /Filter tasks by status/);
});

test('source: selection moves with arrows, delete is confirmed, completion is only by explicit user action, midnight refresh is a timer', async () => {
  const src = await readFile(path.join(root, 'src/components/Tasks.tsx'), 'utf8');
  assert.match(src, /e\.key === 'ArrowDown'/);
  assert.match(src, /<ConfirmDialog open=\{del !== null\}/);
  assert.match(src, /setTimeout\(\(\) => \{ refresh\(\); arm\(\); \}/, 'next-midnight timer, not polling');
  assert.doesNotMatch(src, /setInterval/);
  assert.doesNotMatch(src, /Math\.random|progress\s*=/);
});
