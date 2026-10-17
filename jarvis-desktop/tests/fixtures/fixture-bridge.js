/*
 * TEST FIXTURE ONLY. Injected by scripts/ui-review.mjs and scripts/ui-journeys.mjs into a plain browser page before the
 * app loads. It implements the window.jarvis contract with labelled in-memory data so screenshots and journeys can show
 * real UI states (ready, unavailable, error, streaming) without Electron, a model, a key or the network.
 * It is never bundled with the app, never calls a provider and stores only booleans for keys (never the key text).
 *
 * Configure with window.__FIXTURE__ = { chat: 'ready' | 'unavailable', systemError: string | null, onboarded, seed: 'empty' | 'populated', stt, tts, speech }.
 * speech: 'scripted' answers transcribe/speak with labelled fixture results (never a recognizer or a voice) and records every
 * voice call in window.__FIXTURE_VOICE__ so a journey can check that stop and cancel really reached the backend.
 */
(function install() {
  const cfg = Object.assign({ chat: 'ready', systemError: null, onboarded: true, seed: 'empty', stt: false, tts: false, mode: 'offline', persist: true }, window.__FIXTURE__ || {});
  const KEY = 'fixture.backend.state';
  const voice = { calls: [], transcriptions: 0, cancelled: new Set(), stopSpeaking: null };
  window.__FIXTURE_VOICE__ = voice;
  const now = () => new Date().toISOString();
  let seq = 0;
  const id = (p) => `${p}_fx${Date.now().toString(36)}${(++seq).toString(36)}`;
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const base = () => ({
    settings: { onboarded: cfg.onboarded, mode: cfg.chat === 'ready' ? 'online' : 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: '', localEndpoint: 'http://127.0.0.1:11434', cloudModel: cfg.chat === 'ready' ? 'fixture-claude-model' : '', cloudProvider: 'anthropic', voice: '', allowedRoots: [], approvedApps: [], retainDays: 90 },
    capsules: [],
    notes: [],
    tasks: [],
    chat: [],
    activity: [],
  });
  const populated = (s) => {
    s.notes = [
      { id: 'n_fx1', title: 'Quarterly review outline', body: 'Wins: shipped offline search, cut onboarding to two steps.\nRisks: calendar import needs a real recurring-event test.\nAsk Priya for the support numbers before Thursday.', tags: ['work', 'review'], updatedAt: ago(35) },
      { id: 'n_fx2', title: 'Reading list', body: 'The Design of Everyday Things\nSmall Gods\nA paper on retrieval for personal notes', tags: ['personal'], updatedAt: ago(60 * 26) },
      { id: 'n_fx3', title: 'Trip packing', body: 'Charger, adapter, passport, the blue notebook.', tags: [], updatedAt: ago(60 * 24 * 4) },
    ];
    s.tasks = [
      { id: 't_fx1', title: 'Send review outline to Priya', done: false, due: day(0), createdAt: ago(200) },
      { id: 't_fx2', title: 'Book dentist appointment', done: false, due: day(2), createdAt: ago(900) },
      { id: 't_fx3', title: 'Renew library card', done: false, due: day(-1), createdAt: ago(3000) },
      { id: 't_fx4', title: 'Back up photo folder', done: false, createdAt: ago(4000) },
      { id: 't_fx5', title: 'Water the plants', done: true, createdAt: ago(5000) },
    ];
    s.capsules = [
      { id: 'c_fx1', name: 'Review prep', description: 'Outline, spreadsheet and the team wiki', scene: 'deep-space', createdAt: ago(3000), updatedAt: ago(120), items: [{ kind: 'url', target: 'https://example.com/wiki', label: 'Team wiki' }, { kind: 'folder', target: 'C:\\Users\\Demo\\Documents\\Review', label: 'Review folder' }] },
    ];
    s.chat = [];
    return s;
  };
  let state;
  try {
    const raw = cfg.persist ? localStorage.getItem(KEY) : null;
    state = raw ? JSON.parse(raw) : null;
  } catch {
    state = null;
  }
  if (!state) state = cfg.seed === 'populated' ? populated(base()) : base();
  const save = () => {
    if (cfg.persist) {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        /* memory only */
      }
    }
    return JSON.parse(JSON.stringify(state));
  };
  const keys = { anthropic: cfg.chat === 'ready', openai: false, openrouter: false };
  const caps = () => [
    { id: 'local-llm', name: 'Local model', available: false, reason: 'No local model is set up (fixture)' },
    keys[state.settings.cloudProvider || 'anthropic'] && state.settings.mode === 'online' ? { id: 'cloud', name: 'Cloud model', available: true } : { id: 'cloud', name: 'Cloud model', available: false, reason: state.settings.mode === 'online' ? 'No API key is saved' : 'Online mode is off' },
    cfg.tts ? { id: 'tts', name: 'Read aloud', available: true } : { id: 'tts', name: 'Read aloud', available: false, reason: 'Fixture backend has no speech engine' },
    cfg.stt ? { id: 'stt', name: 'Speech recognition', available: true } : { id: 'stt', name: 'Speech recognition', available: false, reason: 'Fixture backend has no speech recognizer' },
    { id: 'ui-automation', name: 'Windows desktop control', available: false, reason: 'Fixture backend cannot control a desktop' },
    { id: 'secure-storage', name: 'Secure key storage', available: true },
  ];
  const activity = (kind, summary) => state.activity.unshift({ id: id('a'), at: now(), kind, summary });
  const REPLY = 'Here is a short plan for the review. First, list the three wins with one number each. Second, name the one risk and the owner. Third, end with the ask for Thursday. This reply comes from the test fixture, not from a model.';
  const streams = new Map();
  let generation = 0;

  window.jarvis = {
    async getState() { return save(); },
    async saveSettings(patch) {
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'theme' && !['graphite', 'nebula', 'paper'].includes(v)) throw new Error('theme is not supported');
        state.settings[k] = v;
      }
      activity('settings', 'Settings saved');
      return save();
    },
    async getSystemInfo() {
      if (cfg.systemError) throw new Error(cfg.systemError);
      return { platform: 'win32', arch: 'x64', ramGB: 16, cpu: 'Fixture CPU', capabilities: caps() };
    },
    async saveCapsule(c) { const ex = state.capsules.find((x) => x.id === c.id); if (ex) Object.assign(ex, c, { updatedAt: now() }); else state.capsules.unshift({ id: id('c'), name: '', description: '', scene: 'deep-space', items: [], createdAt: now(), updatedAt: now(), ...c }); return save(); },
    async deleteCapsule(cid) { state.capsules = state.capsules.filter((c) => c.id !== cid); return save(); },
    async restoreCapsule() { return { opened: [], failed: [{ target: 'all', reason: 'Fixture backend cannot open files' }] }; },
    async saveNote(n) { const ex = state.notes.find((x) => x.id === n.id); if (ex) Object.assign(ex, n, { updatedAt: now() }); else state.notes.unshift({ id: id('n'), title: '', body: '', tags: [], ...n, updatedAt: now() }); activity('note', 'Note saved'); return save(); },
    async deleteNote(nid) { state.notes = state.notes.filter((n) => n.id !== nid); return save(); },
    async saveTask(t) { const ex = state.tasks.find((x) => x.id === t.id); if (ex) Object.assign(ex, t); else state.tasks.unshift({ id: id('t'), title: '', done: false, createdAt: now(), ...t }); activity('task', 'Task saved'); return save(); },
    async deleteTask(tid) { state.tasks = state.tasks.filter((t) => t.id !== tid); return save(); },
    async chat(text) {
      state.chat.push({ id: id('m'), role: 'user', text, createdAt: now(), source: 'cloud' });
      const ok = state.settings.mode === 'online' && keys.anthropic;
      const m = ok ? { id: id('m'), role: 'assistant', text: REPLY, createdAt: now(), source: 'cloud' } : { id: id('m'), role: 'assistant', text: 'Cloud model unavailable: No API key is saved. No reply was generated.', createdAt: now(), source: 'system' };
      state.chat.push(m);
      save();
      return m;
    },
    async clearChat() { state.chat = []; return save(); },
    async setCloudKey(k) { if (String(k).length < 8) throw new Error('Key too short'); keys.anthropic = true; return { configured: true }; },
    async cloudKeyStatus() { return { configured: keys.anthropic }; },
    async deleteCloudKey() { keys.anthropic = false; },
    async cloudProviderStatus() {
      return [
        { provider: 'anthropic', name: 'Anthropic', hasKey: keys.anthropic, origin: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5-5', keyChannel: 'per-provider' },
        { provider: 'openai', name: 'OpenAI', hasKey: keys.openai, origin: 'https://api.openai.com', defaultModel: 'gpt-fixture', keyChannel: 'per-provider' },
        { provider: 'openrouter', name: 'OpenRouter', hasKey: keys.openrouter, origin: 'https://openrouter.ai', defaultModel: 'openrouter/fixture', keyChannel: 'per-provider' },
      ];
    },
    async cloudModels(provider) {
      const checkedAt = now();
      if (state.settings.mode !== 'online') return { provider, available: false, models: [], reason: 'Online mode is off, so the provider was not contacted.', checkedAt };
      if (!keys[provider]) return { provider, available: false, models: [], reason: 'No API key is saved on this computer.', checkedAt };
      if (provider !== 'anthropic') return { provider, available: false, models: [], reason: 'Fixture backend lists models for Anthropic only.', checkedAt };
      // Clearly fake ids: the fixture never claims real model names.
      return { provider, available: true, checkedAt, models: [{ id: 'fixture-claude-model', name: 'Fixture model A (test data)' }, { id: 'fixture-claude-model-b', name: 'Fixture model B (test data)' }] };
    },
    async setProviderKey(provider, k) { if (String(k).length < 8) throw new Error('That does not look like a full API key.'); keys[provider] = true; return { provider, configured: true }; },
    async clearProviderKey(provider) { keys[provider] = false; return { provider, configured: false }; },
    async previewAction(a) { return { id: id('p'), summary: `Fixture preview: ${a.type}`, requiresApproval: a.type !== 'list-windows', allowed: false, reason: 'Fixture backend cannot control a desktop.' }; },
    async executeAction() { throw new Error('Fixture backend cannot run desktop actions'); },
    async speak(text) {
      if (cfg.speech !== 'scripted') return { ok: false, reason: 'Fixture backend has no speech engine' };
      voice.calls.push(['speak', text.length]);
      voice.stopSpeaking?.();
      // No audio plays: the "speech" lasts a fixed time unless speechStop ends it first.
      return new Promise((resolve) => {
        const t = setTimeout(() => { voice.stopSpeaking = null; resolve({ ok: true }); }, cfg.speakMs ?? 6000);
        voice.stopSpeaking = () => { clearTimeout(t); voice.stopSpeaking = null; resolve({ ok: false, reason: 'Speech was stopped' }); };
      });
    },
    async transcribe(wav) {
      if (cfg.speech !== 'scripted') return { text: '', reason: 'Fixture backend has no speech recognizer' };
      const riff = wav.length > 44 && String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE';
      const ms = riff ? Math.round(((wav.length - 44) / 2 / 16000) * 1000) : 0;
      voice.calls.push(['transcribe', wav.length, riff]);
      const n = ++voice.transcriptions;
      await new Promise((r) => setTimeout(r, cfg.transcribeMs ?? 1500));
      if (voice.cancelled.has(n)) { voice.calls.push(['transcribe-discarded', n]); return { text: '', cancelled: true, reason: 'Transcription was cancelled' }; }
      return riff ? { text: `[fixture transcript ${n}: a ${ms} ms WAV clip arrived; no recognizer ran]` } : { text: '', reason: 'Fixture backend received no WAV' };
    },
    async speechStop() { voice.calls.push(['speechStop']); const had = !!voice.stopSpeaking; voice.stopSpeaking?.(); return had; },
    async transcribeCancel() { voice.calls.push(['transcribeCancel']); voice.cancelled.add(voice.transcriptions); return true; },
    async exportData() { return { path: null }; },
    async importData() { return save(); },
    async pickPath() { return null; },
    onActivity() { return () => {}; },
    async getApiInfo() {
      const on = (fid) => ({ id: fid, available: true });
      return { apiVersion: 2, features: [{ id: 'chat-streaming', available: true }, { id: 'chat-cancel', available: true }, { id: 'intent-planner', available: false, reason: 'Fixture backend has no planner' }, { id: 'search', available: true }, on('routines'), on('integrations'), on('model-runtime'), on('usage-ledger'), on('clipboard-history'), on('resource-monitor'), on('productivity'), on('capsule-packs'), on('calendar'), on('approved-documents')] };
    },
    async chatStreamStart(text) {
      state.chat.push({ id: id('m'), role: 'user', text, createdAt: now(), source: 'cloud' });
      save();
      const start = { streamId: id('s'), generation: ++generation, route: 'cloud' };
      streams.set(start.streamId, { text: '', cancelled: false });
      return start;
    },
    async chatStreamCancel(sid) { const s = streams.get(sid); if (s) s.cancelled = true; return true; },
    onChatStream(start, handler) {
      const tag = (n) => ({ streamId: start.streamId, generation: start.generation, seq: n });
      let n = 0;
      let alive = true;
      const s = streams.get(start.streamId);
      const finish = (outcome, text, note) => {
        const reply = { id: id('m'), role: 'assistant', text, createdAt: now(), source: outcome === 'failed' ? 'system' : 'cloud' };
        if (text) state.chat.push(reply);
        if (note) state.chat.push({ id: id('m'), role: 'assistant', text: note, createdAt: now(), source: 'system' });
        save();
        handler({ ...tag(++n), type: 'done', outcome, reply, stored: state.chat.slice(-2) });
      };
      setTimeout(() => {
        if (!alive) return;
        handler({ ...tag(++n), type: 'status', status: 'connecting' });
        if (!(state.settings.mode === 'online' && keys.anthropic)) {
          setTimeout(() => finish('failed', '', 'Cloud model unavailable: No API key is saved. No reply was generated.'), 500);
          return;
        }
        const words = REPLY.split(' ');
        let i = 0;
        const tick = () => {
          if (!alive) return;
          if (s.cancelled) return finish('cancelled', s.text, 'Stopped by you. The part above was saved.');
          if (i >= words.length) return finish('complete', s.text);
          const piece = (i ? ' ' : '') + words[i++];
          s.text += piece;
          handler({ ...tag(++n), type: 'delta', text: piece });
          setTimeout(tick, cfg.wordMs ?? 70);
        };
        setTimeout(() => {
          handler({ ...tag(++n), type: 'status', status: 'streaming' });
          tick();
        }, 400);
      }, 30);
      return () => { alive = false; };
    },
  };

  /* ---------- Module families: routines, models, integrations, usage, clipboard, resources, productivity, calendar, documents ----------
   * Each family implements every method its adapter in src/ui/bridges.ts checks for, so those screens show real ready, empty
   * and populated states instead of "not connected". All data is labelled demo/fixture. Nothing here touches the desktop,
   * a file dialog, the clipboard or the network: such calls resolve the way a cancelled dialog does, return a labelled
   * fixture result, or reject with "Fixture backend: ...". Module state is kept beside the app state under MODS_KEY.
   */
  const MODS_KEY = 'fixture.backend.modules';
  const fxErr = (msg) => new Error(`Fixture backend: ${msg}`);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const plusSec = (iso, sec) => new Date(Date.parse(iso) + sec * 1000).toISOString();
  const atLocal = (offsetDays, h, m) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const localDay = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const emptyProductivity = () => ({ capsuleMeta: {}, checkpoints: [], focus: [], reminders: [], timeline: [], associations: [], shelf: [], recents: [], policy: { timelineEnabled: false, timelineTitles: false, retainDays: { focus: 365, timeline: 30, checkpoints: 0, reminders: 90 } } });
  const DEMO_PRICE = { provider: 'anthropic', model: 'fixture-claude-model', inputPerMillion: 1, outputPerMillion: 5 };
  const priceFor = (prices, provider, model) => prices.find((p) => p.provider === provider && p.model === model);
  const costOf = (p, e) => (p ? (e.inputTokens * p.inputPerMillion + e.outputTokens * p.outputPerMillion) / 1e6 : null);
  const usageEvent = (minsAgo, inputTokens, outputTokens, project) => {
    const e = { id: id('u'), at: ago(minsAgo), runtime: 'cloud', provider: 'anthropic', model: 'fixture-claude-model', project, worker: 'assistant', inputTokens, outputTokens, generationMs: null, promptMs: null };
    return { ...e, cost: costOf(DEMO_PRICE, e), costState: 'estimated' };
  };
  const step = (sid, label, request, extra = {}) => ({ id: sid, kind: 'action', label, request, retries: 0, retryDelaySeconds: 5, onFailure: 'stop', undoable: false, ...extra });
  const modsBase = () => ({
    routines: { paused: false, routines: [], runs: [], status: {} },
    usage: { events: [], prices: [], budget: null },
    clipboard: { enabled: false, entries: [] },
    calendar: [],
    integrations: { enabled: {}, githubKey: false, usage: [], previous: {} },
    models: { profile: 'default', serverUp: false, installed: [], loaded: [] },
    productivity: emptyProductivity(),
  });
  const populatedMods = (m) => {
    const runStart = atLocal(-1, 8, 45);
    const manualStart = ago(60 * 20);
    m.routines.routines = [
      { id: 'r_fx1', name: 'Morning review (demo)', enabled: true, schedule: { kind: 'daily', time: '08:45', days: [1, 2, 3, 4, 5] }, createdAt: ago(60 * 24 * 9), updatedAt: ago(60 * 24 * 2), steps: [
        step('s_fx1', 'Open the demo task board', { type: 'open-url', target: 'https://example.com/demo-board' }),
        { id: 's_fx2', kind: 'wait', label: 'Wait 5 s', seconds: 5 },
        step('s_fx3', 'Focus Notepad', { type: 'focus', target: 'Notepad' }, { retries: 1, onFailure: 'continue' }),
      ] },
      { id: 'r_fx2', name: 'Wrap up the day (demo)', enabled: true, schedule: { kind: 'manual' }, createdAt: ago(60 * 24 * 6), updatedAt: ago(60 * 24 * 6), steps: [
        step('s_fx4', 'Open the demo time sheet', { type: 'open-url', target: 'https://example.com/demo-timesheet' }),
        step('s_fx5', 'Move Notepad to the left half', { type: 'move-window', target: 'Notepad', x: 0, y: 0, width: 960, height: 1040 }, { undoable: true, condition: { kind: 'weekday', days: [1, 2, 3, 4, 5] } }),
      ] },
    ];
    m.routines.runs = [
      { id: 'run_fx2', routineId: 'r_fx2', routineName: 'Wrap up the day (demo)', trigger: 'manual', status: 'partial', startedAt: manualStart, endedAt: plusSec(manualStart, 14), reason: 'One step was declined (demo history).', steps: [
        { stepId: 's_fx4', label: 'Open the demo time sheet', status: 'succeeded', attempts: 1, summary: 'Opened https://example.com/demo-timesheet (demo)' },
        { stepId: 's_fx5', label: 'Move Notepad to the left half', status: 'declined', attempts: 1, reason: 'You declined this step (demo history)' },
      ] },
      { id: 'run_fx1', routineId: 'r_fx1', routineName: 'Morning review (demo)', trigger: 'schedule', slot: runStart, status: 'succeeded', startedAt: runStart, endedAt: plusSec(runStart, 9), steps: [
        { stepId: 's_fx1', label: 'Open the demo task board', status: 'succeeded', attempts: 1, summary: 'Opened https://example.com/demo-board (demo)' },
        { stepId: 's_fx2', label: 'Wait 5 s', status: 'succeeded', attempts: 1 },
        { stepId: 's_fx3', label: 'Focus Notepad', status: 'succeeded', attempts: 1, summary: 'Focused Notepad (demo)' },
      ] },
    ];
    m.routines.status = {
      r_fx1: { lastSlot: runStart, lastRunId: 'run_fx1', lastRunAt: runStart, lastResult: 'succeeded', missedCount: 0 },
      r_fx2: { lastRunId: 'run_fx2', lastRunAt: manualStart, lastResult: 'partial', missedCount: 0 },
    };
    m.usage.prices = [{ ...DEMO_PRICE }];
    m.usage.budget = { amount: 5, period: 'month', thresholds: [0.5, 0.8, 1] };
    m.usage.events = [
      usageEvent(60 * 24 * 3, 1500, 700, null),
      usageEvent(60 * 26, 3100, 1200, 'Reading list (demo)'),
      usageEvent(60 * 5, 960, 420, null),
      usageEvent(95, 2400, 910, 'Quarterly review (demo)'),
      usageEvent(30, 1820, 640, 'Quarterly review (demo)'),
    ];
    m.clipboard.enabled = true;
    m.clipboard.entries = [
      { id: 'clip_fx1', text: 'https://example.com/meet/demo-standup  Meeting link (demo)', capturedAt: Date.now() - 12 * 60000, copies: 2 },
      { id: 'clip_fx2', text: 'Wins: shipped offline search, cut onboarding to two steps. (demo snippet)', capturedAt: Date.now() - 55 * 60000, copies: 1 },
      { id: 'clip_fx3', text: 'Priya (demo contact) · priya@example.com', capturedAt: Date.now() - 3 * 3600000, copies: 1 },
      { id: 'clip_fx4', text: 'Order reference DEMO-1042 (demo)', capturedAt: Date.now() - 26 * 3600000, copies: 1 },
    ];
    const ev = (uid, title, start, end, extra = {}) => ({ id: `${uid}@demo.ics.invalid`, title, start, end, allDay: false, floating: false, location: '', description: 'Imported from demo.ics (fixture)', url: null, ...extra });
    m.calendar = [
      ev('design-review', 'Design review (demo)', atLocal(0, 10, 0), atLocal(0, 11, 0), { location: 'Room 2 (demo)' }),
      ev('one-on-one', '1:1 with Priya (demo)', atLocal(0, 15, 30), atLocal(0, 16, 0)),
      ev('offsite', 'Team offsite (demo)', localDay(1), localDay(2), { allDay: true, location: 'Demo venue' }),
      ev('dentist', 'Dentist appointment (demo)', atLocal(2, 9, 30), atLocal(2, 10, 15)),
      ev('quarterly', 'Quarterly review (demo)', atLocal(4, 14, 0), atLocal(4, 15, 0), { url: 'https://example.com/demo-agenda' }),
    ];
    m.integrations.enabled = { anthropic: true };
    m.integrations.previous = { anthropic: { ok: true, at: ago(60 * 20), status: 200 } };
    m.integrations.usage = [{ id: 'iu_fx1', at: ago(60 * 20), op: 'check', origin: 'https://api.anthropic.com', ok: true, status: 200 }];
    m.models.serverUp = true;
    m.models.installed = [
      { name: 'fixture-local-model:demo', sizeBytes: 2147483648, family: 'fixture', parameterSize: '3B (demo)', quantization: 'Q4_K_M', modifiedAt: ago(60 * 24 * 6) },
      { name: 'fixture-local-model:small-demo', sizeBytes: 805306368, family: 'fixture', parameterSize: '1B (demo)', quantization: 'Q4_0', modifiedAt: ago(60 * 24 * 20) },
    ];
    m.productivity.capsuleMeta = {
      c_fx1: { updatedAt: ago(120), goals: [{ id: 'g_fx1', text: 'Send the outline to Priya by Thursday', done: false }, { id: 'g_fx2', text: 'Pull the support numbers', done: true }], references: [{ id: 'ref_fx1', kind: 'note', target: 'n_fx1', label: 'Quarterly review outline' }, { id: 'ref_fx2', kind: 'url', target: 'https://example.com/wiki', label: 'Team wiki (demo)' }] },
    };
    m.productivity.checkpoints = [
      { id: 'cp_fx2', title: 'Reading list tidied (demo)', note: '', createdAt: ago(60 * 26), refs: [{ kind: 'note', id: 'n_fx2' }] },
      { id: 'cp_fx1', capsuleId: 'c_fx1', title: 'Outline drafted (demo)', note: 'Wins and risks are in; the ask still needs the support numbers.', createdAt: ago(40), refs: [{ kind: 'note', id: 'n_fx1' }, { kind: 'task', id: 't_fx1' }] },
    ];
    m.productivity.focus = [
      { id: 'f_fx2', startedAt: ago(60 * 25), endedAt: ago(60 * 25 - 12), plannedSec: 1500, actualSec: 720, outcome: 'stopped' },
      { id: 'f_fx1', startedAt: ago(90), endedAt: ago(65), plannedSec: 1500, actualSec: 1500, outcome: 'completed', taskId: 't_fx1', taskTitle: 'Send review outline to Priya', capsuleId: 'c_fx1' },
    ];
    m.productivity.shelf = [
      { id: 'sh_fx1', kind: 'folder', target: 'C:\\Users\\Demo\\Documents\\Review', label: 'Review folder (demo)', addedAt: ago(300), pinned: true },
      { id: 'sh_fx2', kind: 'url', target: 'https://example.com/wiki', label: 'Team wiki (demo)', addedAt: ago(800), pinned: false },
    ];
    m.productivity.recents = [{ id: 'rc_fx1', kind: 'url', target: 'https://example.com/wiki', label: 'Team wiki (demo)', openedAt: ago(130), count: 3 }];
    return m;
  };
  let mods;
  try {
    const raw = cfg.persist ? localStorage.getItem(MODS_KEY) : null;
    mods = raw ? JSON.parse(raw) : null;
  } catch {
    mods = null;
  }
  {
    const fresh = cfg.seed === 'populated' ? populatedMods(modsBase()) : modsBase();
    mods = mods && typeof mods === 'object' ? { ...fresh, ...mods } : fresh;
  }
  const saveMods = () => {
    if (cfg.persist) {
      try {
        localStorage.setItem(MODS_KEY, JSON.stringify(mods));
      } catch {
        /* memory only */
      }
    }
  };

  // ---- Routines (ROUTINE_METHODS). Runs never perform desktop steps: the first action step is recorded as blocked.
  const ROUTINE_GATES = [
    { id: 88, name: 'Selected file/browser action adapters', available: false, reason: 'Routines can launch approved apps/files and open links through the action service. Richer file and browser adapters wait for the input-injection gate (G4).' },
    { id: 89, name: 'Watch-once routine recording', available: false, reason: 'Not implemented: there is no keyboard or mouse recording. Requires the input-injection gate (G4) and a consented capture design.' },
    { id: 90, name: 'Cross-app semantic drag-to-action workflows', available: false, reason: 'Not implemented: no drag capture or semantic understanding of dragged content. Requires the input-injection gate (G4).' },
  ];
  const ACTION_TYPES = ['launch', 'focus', 'move-window', 'type-text', 'open-url', 'list-windows'];
  const nextDaily = (time, days) => {
    const [h, mi] = String(time).split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      d.setHours(h, mi, 0, 0);
      if (d.getTime() > Date.now() && days.includes(d.getDay())) return d.toISOString();
    }
    return null;
  };
  const routinesView = () => {
    const R = mods.routines;
    return clone({
      paused: R.paused, activeRunId: null, gates: ROUTINE_GATES, runs: R.runs,
      routines: R.routines.map((r) => {
        const s = r.schedule;
        const next = s.kind === 'daily' ? nextDaily(s.time, s.days) : s.kind === 'interval' ? new Date(Date.now() + s.minutes * 60000).toISOString() : s.kind === 'once' && Date.parse(s.at) > Date.now() ? s.at : null;
        const due = r.enabled && !R.paused ? next : null;
        const st = s.kind === 'manual' ? 'manual' : !r.enabled ? 'disabled' : R.paused ? 'paused' : next ? 'scheduled' : 'completed';
        return { ...r, nextDueAt: due, scheduleStatus: { missedCount: 0, ...(R.status[r.id] || {}), state: st, nextDueAt: due } };
      }),
    });
  };
  const normSchedule = (s) => {
    const o = s && typeof s === 'object' ? s : { kind: 'manual' };
    if (o.kind === 'manual') return { kind: 'manual' };
    if (o.kind === 'once') { if (!Number.isFinite(Date.parse(o.at))) throw new Error('schedule.at must be a date and time'); return { kind: 'once', at: new Date(Date.parse(o.at)).toISOString() }; }
    if (o.kind === 'daily') { if (!/^\d{2}:\d{2}$/.test(String(o.time)) || !Array.isArray(o.days) || !o.days.length) throw new Error('A daily schedule needs a time and at least one day'); return { kind: 'daily', time: o.time, days: [...new Set(o.days.map(Number))].sort() }; }
    if (o.kind === 'interval') { const minutes = Math.round(Number(o.minutes)); if (!(minutes >= 5 && minutes <= 1440)) throw new Error('schedule.minutes must be 5 to 1440'); return { kind: 'interval', minutes }; }
    throw new Error('schedule.kind must be manual, once, daily or interval');
  };
  const normStep = (raw, i) => {
    const what = `Step ${i + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`${what} is invalid`);
    const sid = typeof raw.id === 'string' && raw.id ? raw.id : id('s');
    const cond = raw.condition ? { condition: clone(raw.condition) } : {};
    if (raw.kind === 'wait') {
      const seconds = Math.round(Number(raw.seconds));
      if (!(seconds >= 1 && seconds <= 300)) throw new Error(`${what}: a wait must be 1–300 seconds`);
      return { id: sid, kind: 'wait', label: String(raw.label || '').trim() || `Wait ${seconds} s`, seconds, ...cond };
    }
    if (raw.kind !== 'action') throw new Error(`${what}: kind must be action or wait`);
    const req = raw.request && typeof raw.request === 'object' ? raw.request : {};
    if (req.type === 'click') throw new Error(`${what}: clicks cannot be saved in a routine`);
    if (!ACTION_TYPES.includes(req.type)) throw new Error(`${what}: the action type is not supported`);
    if (req.type !== 'list-windows' && !String(req.target || '').trim()) throw new Error(`${what}: choose a target`);
    if (req.type === 'open-url' && !/^https?:\/\/[^\s]+$/i.test(String(req.target))) throw new Error(`${what}: only http and https links can be opened`);
    const undoable = raw.undoable === true;
    if (undoable && req.type !== 'move-window') throw new Error(`${what}: only window moves can be undone; ${req.type} is not reversible`);
    const num = (v, d, max) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Math.min(max, Math.max(0, Math.round(Number(v)))) : d);
    return { id: sid, kind: 'action', label: String(raw.label || '').trim() || `${req.type} ${req.target || ''}`.trim().slice(0, 80), request: clone(req), retries: num(raw.retries, 0, 3), retryDelaySeconds: num(raw.retryDelaySeconds, 5, 60), onFailure: raw.onFailure === 'continue' ? 'continue' : 'stop', undoable, ...cond };
  };
  const candidate = (line) => {
    const l = line.replace(/[.]+$/, '').trim();
    let m;
    if ((m = /^wait\s+(\d+)\s*(s|secs?|seconds?)?$/i.exec(l))) { const n = Number(m[1]); return n >= 1 && n <= 300 ? { kind: 'wait', seconds: n, summary: `Wait ${n} second${n === 1 ? '' : 's'}` } : 'a wait must be 1–300 seconds'; }
    if ((m = /^open\s+(https?:\/\/\S+)$/i.exec(l))) return { kind: 'action', request: { type: 'open-url', target: m[1] }, summary: `Open ${m[1]}` };
    if ((m = /^(?:open|launch|start)\s+(.+)$/i.exec(l))) return { kind: 'action', request: { type: 'launch', target: m[1] }, summary: `Launch ${m[1]}` };
    if ((m = /^(?:focus|switch to)\s+(.+)$/i.exec(l))) return { kind: 'action', request: { type: 'focus', target: m[1] }, summary: `Focus ${m[1]}` };
    return 'the fixture planner understands "open <link or app>", "focus <window>" and "wait <seconds>"';
  };
  const planFrom = (source, items) => {
    if (!items.length) return { status: 'clarify', source, step: null, summary: 'Empty routine', reason: 'Write one command per line.' };
    const steps = [];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (typeof c === 'string') return { status: 'clarify', source, step: i + 1, summary: `Step ${i + 1}`, reason: `Step ${i + 1}: ${c}` };
      steps.push(c);
    }
    return { status: 'ready', source, steps, previewOnly: true };
  };
  const findRoutine = (rid) => {
    const r = mods.routines.routines.find((x) => x.id === rid);
    if (!r) throw new Error('Routine not found');
    return r;
  };

  // ---- Usage ledger (USAGE_METHODS). Recorded fixture requests to the fixture model; exports resolve as a cancelled save dialog.
  const USAGE_DISCLAIMER = 'Local estimates from token counts and the price table you entered. Not a provider invoice; provider billing snapshots are shown separately with their observation time.';
  const usageSummary = () => {
    const U = mods.usage;
    const t = Date.now();
    const events = U.events;
    const byModel = new Map();
    const attr = new Map();
    for (const e of events) {
      const k = `${e.runtime}|${e.provider}|${e.model}`;
      const row = byModel.get(k) || { provider: e.provider, model: e.model, runtime: e.runtime, events: 0, inputTokens: 0, outputTokens: 0, estimatedCost: e.runtime === 'cloud' ? 0 : null };
      row.events += 1;
      row.inputTokens += e.inputTokens;
      row.outputTokens += e.outputTokens;
      if (row.estimatedCost !== null) row.estimatedCost = e.cost === null ? null : row.estimatedCost + e.cost;
      byModel.set(k, row);
      const ak = `${e.project ?? ''}|${e.worker ?? ''}`;
      const a = attr.get(ak) || { project: e.project, worker: e.worker, events: 0, estimatedCost: 0 };
      a.events += 1;
      if (a.estimatedCost !== null) a.estimatedCost = e.costState === 'unpriced' ? null : a.estimatedCost + (e.cost ?? 0);
      attr.set(ak, a);
    }
    let budget = null;
    if (U.budget) {
      const n = new Date(t);
      const start = U.budget.period === 'day' ? Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) : Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1);
      const end = U.budget.period === 'day' ? start + 86400000 : Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
      const spent = events.filter((e) => Date.parse(e.at) >= start).reduce((s, e) => s + (e.cost ?? 0), 0);
      const elapsed = (t - start) / (end - start);
      const projected = elapsed >= 0.05 ? spent / elapsed : null;
      budget = {
        amount: U.budget.amount, period: U.budget.period, periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(), spent, reserved: 0, conservativeTotal: spent,
        remaining: U.budget.amount - spent, fractionUsed: U.budget.amount > 0 ? spent / U.budget.amount : 0, projected,
        pace: projected === null ? 'insufficient-data' : projected <= U.budget.amount ? 'on-track' : 'over-pace',
        alerts: U.budget.thresholds.map((th) => ({ threshold: th, reached: spent >= th * U.budget.amount })),
      };
    }
    const report = {
      generatedAt: new Date(t).toISOString(), disclaimer: USAGE_DISCLAIMER,
      estimatedSpend: events.reduce((s, e) => s + (e.cost ?? 0), 0), reservedSpend: 0, unpricedEvents: events.filter((e) => e.costState === 'unpriced').length,
      totals: { events: events.length, inputTokens: events.reduce((s, e) => s + e.inputTokens, 0), outputTokens: events.reduce((s, e) => s + e.outputTokens, 0) },
      byModel: [...byModel.values()], attribution: [...attr.values()],
      // No billing adapter is declared in the fixture, so providers with events are reported as unsupported, never as zero.
      billing: [...new Set(events.filter((e) => e.runtime === 'cloud').map((e) => e.provider))].map((provider) => ({ provider, status: 'unsupported', observedAt: null, ageMs: null, balance: null, spent: null, resetsAt: null, resetInMs: null, resetDue: false })),
      reservations: [], budget,
    };
    return clone({ report, performance: [] });
  };

  // ---- Clipboard history (CLIPBOARD_METHODS). Never reads the system clipboard: entries are seeded demo text.
  const clipStatus = () => ({ enabled: mods.clipboard.enabled, persisted: false, count: mods.clipboard.entries.length, maxEntries: 50, retentionMs: 86400000, maxChars: 5000 });

  // ---- Calendar (CALENDAR_METHODS). A small .ics reader for pasted/reviewed text; the file dialog resolves as cancelled.
  const parseIcsLite = (text) => {
    const src = String(text || '');
    if (src.length > 1000000) return { events: [], skipped: [], error: 'too-large' };
    if (!/BEGIN:VCALENDAR/i.test(src)) return { events: [], skipped: [], error: 'not-calendar' };
    const lines = [];
    for (const raw of src.split(/\r\n|\n|\r/)) {
      if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
      else lines.push(raw);
    }
    const events = [];
    const skipped = {};
    const skip = (code) => { skipped[code] = (skipped[code] || 0) + 1; };
    const unesc = (v) => v.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c)).slice(0, 1000);
    const time = (p) => {
      let m = /^(\d{4})(\d{2})(\d{2})$/.exec(p.value);
      if (m) return { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true, floating: false };
      m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value);
      if (!m) return { error: 'bad-date' };
      if (+m[1] < 1900 || +m[1] > 2100) return { error: 'date-out-of-range' };
      const tz = p.params.TZID;
      if (tz && !['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT'].includes(tz)) return { error: 'unsupported-timezone' };
      if (m[7] || tz) return { value: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString(), allDay: false, floating: false };
      return { value: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, allDay: false, floating: true };
    };
    let cur = null;
    for (const line of lines) {
      if (/^BEGIN:VEVENT$/i.test(line)) { cur = {}; continue; }
      if (/^END:VEVENT$/i.test(line)) {
        if (cur) {
          if (cur.RRULE) skip('unsupported-recurrence');
          else if (!cur.DTSTART) skip('missing-start');
          else {
            const s = time(cur.DTSTART);
            const e = cur.DTEND ? time(cur.DTEND) : null;
            if (s.error) skip(s.error);
            else {
              const title = cur.SUMMARY ? unesc(cur.SUMMARY.value) : '';
              events.push({ id: (cur.UID ? cur.UID.value : `${s.value}|${title}`).slice(0, 200), title, start: s.value, end: e && !e.error ? e.value : null, allDay: s.allDay, floating: s.floating, location: cur.LOCATION ? unesc(cur.LOCATION.value) : '', description: cur.DESCRIPTION ? unesc(cur.DESCRIPTION.value) : '', url: cur.URL && /^https?:\/\/\S+$/i.test(cur.URL.value) ? cur.URL.value : null });
            }
          }
        }
        cur = null;
        continue;
      }
      if (!cur) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const [name, ...ps] = line.slice(0, colon).split(';');
      const params = {};
      for (const p of ps) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); }
      cur[name.toUpperCase()] = { value: line.slice(colon + 1), params };
    }
    return { events, skipped: Object.entries(skipped).map(([code, count]) => ({ code, count })) };
  };

  // ---- Integrations (INTEGRATION_BRIDGE_METHODS). Mirrors the catalog's availability; a check never sends a request.
  const INTEG = [
    { id: 'ollama', name: 'Local model (Ollama)', provider: 'Ollama on this computer', availability: 'local', check: { origin: 'http://127.0.0.1:11434', path: '/api/tags', online: false, headers: [], purpose: 'ollama' }, dataLeaves: [] },
    { id: 'anthropic', name: 'Claude API (Anthropic)', provider: 'Anthropic', availability: 'byok', check: { origin: 'https://api.anthropic.com', path: '/v1/models', online: true, headers: ['anthropic-version'] }, key: { slot: 'anthropic', label: 'Anthropic API key', header: 'x-api-key' }, dataLeaves: ['Your API key, in the x-api-key header', 'Your IP address and request time (seen by Anthropic)'] },
    { id: 'openai', name: 'OpenAI API (ChatGPT models)', provider: 'OpenAI', availability: 'byok', check: { origin: 'https://api.openai.com', path: '/v1/models', online: true, headers: [] }, key: { slot: 'openai', label: 'OpenAI API key', header: 'authorization' }, dataLeaves: ['Your API key, in the Authorization header', 'Your IP address and request time (seen by OpenAI)'] },
    { id: 'claude-web', name: 'Claude website', provider: 'Anthropic', availability: 'handoff', handoff: 'https://claude.ai/', dataLeaves: ['Your browser contacts claude.ai directly; the app sends nothing'] },
    { id: 'chatgpt-web', name: 'ChatGPT website', provider: 'OpenAI', availability: 'handoff', handoff: 'https://chatgpt.com/', dataLeaves: ['Your browser contacts chatgpt.com directly; the app sends nothing'] },
    { id: 'spotify-web', name: 'Spotify', provider: 'Spotify', availability: 'handoff', handoff: 'https://open.spotify.com/', dataLeaves: ['Your browser contacts open.spotify.com directly; the app sends nothing'] },
    { id: 'spotify-api', name: 'Spotify playback control', provider: 'Spotify', availability: 'setup-required', dataLeaves: ['OAuth token and playback commands, sent to api.spotify.com'] },
    { id: 'browser', name: 'Default browser', provider: 'Your browser', availability: 'handoff', handoff: null, dataLeaves: ['Your browser fetches the page directly; the app sends nothing'] },
    { id: 'web-research', name: 'Web research with cited sources', provider: 'Not chosen', availability: 'not-built', dataLeaves: ['Search queries, sent to the chosen search provider'] },
    { id: 'calendar', name: 'Calendar accounts', provider: 'Google / Microsoft', availability: 'setup-required', dataLeaves: ['OAuth token, sent to the calendar provider', 'Event titles and times, received from the provider'] },
    { id: 'issue-draft', name: 'Issue draft export', provider: 'This device', availability: 'local', dataLeaves: [] },
    { id: 'issue-post', name: 'Issue posting (GitHub)', provider: 'GitHub', availability: 'byok', check: { origin: 'https://api.github.com', path: '/user', online: true, headers: ['accept', 'x-github-api-version'] }, key: { slot: 'github', label: 'GitHub fine-grained token', header: 'authorization' }, dataLeaves: ['Your token, in the Authorization header', 'Your IP address and request time (seen by GitHub)'] },
    { id: 'weather', name: 'Weather widget (Open-Meteo)', provider: 'Open-Meteo', availability: 'keyless', check: { origin: 'https://api.open-meteo.com', path: '/v1/forecast?latitude=0&longitude=0&current=temperature_2m', online: true, headers: [] }, dataLeaves: ['Your IP address and request time (seen by Open-Meteo)', 'The check sends fixed coordinates 0,0, not your location'] },
    { id: 'news', name: 'News feed widget', provider: 'Not chosen', availability: 'not-built', dataLeaves: ['Feed requests, sent to the chosen source'] },
    { id: 'downloads', name: 'Model and update downloads', provider: 'Not chosen', availability: 'not-built', dataLeaves: ['Download requests, sent to the chosen host'] },
    { id: 'data-preview', name: 'Data previews and usage history', provider: 'This device', availability: 'local', dataLeaves: [] },
    { id: 'sync', name: 'Encrypted cross-device sync', provider: 'Not chosen', availability: 'gated', dataLeaves: ['Encrypted copies of your data, stored by a sync host'] },
    { id: 'marketplace', name: 'Community scene/widget marketplace', provider: 'Not chosen', availability: 'gated', dataLeaves: ['Uploaded scenes, sent to a marketplace host'] },
  ];
  const BLOCKED = { gated: 'Experimental and turned off until its review passes', 'setup-required': 'Needs setup that does not exist yet', 'not-built': 'Not built yet', handoff: 'This opens a website; there is no API connection to check', local: 'Runs on this device; there is nothing to turn on' };
  const integLast = new Map();
  const integDef = (iid) => {
    const d = INTEG.find((x) => x.id === iid);
    if (!d) throw new Error('Unknown integration');
    return d;
  };
  const checkable = (d) => !!d.check && ['local', 'byok', 'keyless'].includes(d.availability);
  const optIn = (d) => checkable(d) && d.check.online;
  const hasKey = (d) => (!d.key ? false : d.key.slot === 'github' ? mods.integrations.githubKey === true : keys[d.key.slot] === true);
  const integState = (d) => {
    if (['gated', 'setup-required', 'not-built'].includes(d.availability)) return d.availability;
    if (d.availability === 'handoff') return 'handoff';
    if (!d.check) return 'local-ready';
    if (optIn(d) && mods.integrations.enabled[d.id] !== true) return 'turned-off';
    if (d.check.online && state.settings.mode !== 'online') return 'offline';
    if (d.key && !hasKey(d)) return 'needs-key';
    const lc = integLast.get(d.id);
    if (lc) return lc.ok ? 'connected' : 'check-failed';
    return 'ready-to-check';
  };
  const integView = (d) => {
    const lc = integLast.get(d.id);
    const prev = mods.integrations.previous[d.id];
    return clone({ id: d.id, state: integState(d), keyConfigured: hasKey(d), enabled: mods.integrations.enabled[d.id] === true, choiceStorage: 'saved', ...(lc ? { lastCheck: lc } : {}), ...(!lc && prev ? { previousCheck: { id: d.id, ...prev } } : {}) });
  };
  const integPreview = (d) => {
    const base = { id: d.id, dataLeaves: [...d.dataLeaves], bodyBytes: 0, keySent: false };
    if (d.availability === 'handoff') {
      return { ...base, allowed: true, destination: d.handoff ? new URL(d.handoff).origin : 'The link you enter', method: 'Open in browser', path: d.handoff ? new URL(d.handoff).pathname : '', headerNames: [], response: 'Your browser loads the page; the app reads nothing back', reason: 'Needs your approval in the Computer action flow' };
    }
    if (!checkable(d)) return { ...base, allowed: false, reason: d.check ? BLOCKED[d.availability] : 'Nothing is sent: this runs on this device', destination: 'None', method: '', path: '', headerNames: [], response: 'None' };
    const common = { ...base, method: 'GET', path: d.check.path.split('?')[0], headerNames: [...d.check.headers, ...(d.key ? [d.key.header] : [])], keySent: !!d.key, ...(d.key ? { keyHeader: d.key.header } : {}), response: d.check.purpose === 'ollama' ? 'Installed model count is shown; nothing leaves this device' : 'Only the HTTP status is used; the response body is discarded' };
    let reason;
    if (optIn(d) && mods.integrations.enabled[d.id] !== true) reason = `Turn on ${d.name} first`;
    else if (d.check.online && state.settings.mode !== 'online') reason = `Offline mode: switch to online mode to contact ${d.provider}`;
    else if (d.key && !hasKey(d)) reason = `Add your ${d.key.label} first`;
    return { ...common, allowed: !reason, ...(reason ? { reason } : {}), destination: d.check.origin };
  };

  // ---- Local model runtime (MODEL_METHODS). Fixture model names only; pulls and pack imports are refused with a reason.
  const PROFILES = [
    { id: 'default', label: 'Default', description: "Ollama's own context size; model stays loaded 2 minutes after a reply.", keepAlive: '2m', numCtx: null },
    { id: 'low-memory', label: 'Low memory', description: 'Small 2048-token context; model is released 30 seconds after a reply. Best for 8 GB computers.', keepAlive: '30s', numCtx: 2048 },
    { id: 'balanced', label: 'Balanced', description: '4096-token context; model stays loaded 5 minutes.', keepAlive: '5m', numCtx: 4096 },
    { id: 'performance', label: 'Performance', description: '8192-token context; model stays loaded 15 minutes. Needs plenty of free memory.', keepAlive: '15m', numCtx: 8192 },
  ];
  const sameModel = (a, b) => { const n = (x) => (String(x).includes(':') ? String(x) : `${x}:latest`).toLowerCase(); return n(a) === n(b); };
  const modelsOverview = () => {
    const M = mods.models;
    const configured = state.settings.localModel || '';
    const up = M.serverUp;
    return clone({
      health: {
        state: !up ? 'server-down' : configured && !M.installed.some((m) => sameModel(m.name, configured)) ? 'model-missing' : 'ready',
        endpoint: state.settings.localEndpoint || 'http://127.0.0.1:11434', version: up ? '0.0.0-fixture' : null, configuredModel: configured,
        configuredModelInstalled: up && configured ? M.installed.some((m) => sameModel(m.name, configured)) : null,
        installedCount: up ? M.installed.length : 0, loaded: up ? M.loaded : [], latencyMs: up ? 12 : null,
        ...(up ? {} : { reason: 'Fixture backend: no local model server is running (test data).' }),
        notes: up ? ['Fixture backend: these models are test data; nothing is running on this computer.'] : [],
      },
      installed: up ? M.installed : [], installedError: up ? null : 'The local model server did not answer (fixture backend).',
      profiles: PROFILES, activeProfile: M.profile, recommendedProfile: { id: 'performance', reason: '16 GB of memory leaves room for a larger context.' },
      jobs: [], capabilities: caps(), downloads: { allowed: false, reason: 'The fixture backend never downloads models.' },
    });
  };

  // ---- Productivity sidecar (PRODUCTIVITY_METHODS) and the nested window.jarvis.productivity namespace.
  const reminderKey = (taskId, due) => `${taskId}\u0000${due}`;
  const byAt = (list, at) => list.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  const dropDead = (d) => { const live = new Set([...d.timeline.map((t) => t.id), ...d.focus.map((f) => f.id)]); d.associations = d.associations.filter((a) => live.has(a.sessionId)); };
  const requireText = (v, name) => { const s = String(v ?? '').trim(); if (!s) throw new Error(`${name} is required`); return s; };
  const prodApply = (op) => {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') throw new Error('operation is invalid');
    const d = clone(mods.productivity);
    const at = now();
    switch (op.op) {
      case 'capsule.setMeta': {
        if (!state.capsules.some((c) => c.id === op.capsuleId)) throw new Error('Capsule not found');
        const cur = d.capsuleMeta[op.capsuleId];
        const goals = (op.goals ?? cur?.goals ?? []).map((g) => ({ id: g.id || id('g'), text: requireText(g.text, 'goal'), done: g.done === true }));
        const references = (op.references ?? cur?.references ?? []).map((r) => ({ id: r.id || id('ref'), kind: r.kind, target: requireText(r.target, 'reference target'), label: String(r.label ?? ''), ...(r.note ? { note: String(r.note) } : {}) }));
        d.capsuleMeta[op.capsuleId] = { goals, references, updatedAt: at };
        break;
      }
      case 'checkpoint.add': {
        const c = { id: id('cp'), title: requireText(op.title, 'title'), note: String(op.note ?? '').trim(), createdAt: op.createdAt ? new Date(Date.parse(op.createdAt)).toISOString() : at, refs: Array.isArray(op.refs) ? clone(op.refs) : [] };
        if (op.capsuleId !== undefined) c.capsuleId = op.capsuleId;
        d.checkpoints = byAt([...d.checkpoints, c], (x) => x.createdAt);
        break;
      }
      case 'checkpoint.update': {
        const c = d.checkpoints.find((x) => x.id === op.id);
        if (!c) throw new Error('Checkpoint not found');
        if (op.title !== undefined) c.title = requireText(op.title, 'title');
        if (op.note !== undefined) c.note = String(op.note).trim();
        if (op.refs !== undefined) c.refs = clone(op.refs);
        break;
      }
      case 'checkpoint.delete': d.checkpoints = d.checkpoints.filter((x) => x.id !== op.id); break;
      case 'focus.record': {
        if (d.focus.some((x) => Math.abs(Date.parse(x.startedAt) - Date.parse(op.startedAt)) < 30000)) break;
        const f = { id: id('f'), startedAt: op.startedAt, endedAt: op.endedAt, plannedSec: op.plannedSec, actualSec: op.actualSec, outcome: op.outcome === 'completed' ? 'completed' : 'stopped' };
        for (const k of ['taskId', 'taskTitle', 'capsuleId']) if (op[k] !== undefined) f[k] = op[k];
        d.focus = byAt([...d.focus, f], (x) => x.startedAt);
        break;
      }
      case 'focus.delete': d.focus = d.focus.filter((x) => x.id !== op.id); dropDead(d); break;
      case 'reminder.snooze': case 'reminder.dismiss': {
        const r = { key: reminderKey(op.taskId, op.due), taskId: op.taskId, due: op.due, state: op.op === 'reminder.snooze' ? 'snoozed' : 'dismissed', at };
        if (op.op === 'reminder.snooze') { if (!(Date.parse(op.until) > Date.now())) throw new Error('Snooze time must be in the future'); r.until = new Date(Date.parse(op.until)).toISOString(); }
        d.reminders = [...d.reminders.filter((x) => x.key !== r.key), r];
        break;
      }
      case 'reminder.clear': d.reminders = d.reminders.filter((x) => x.key !== reminderKey(op.taskId, op.due)); break;
      case 'timeline.record': {
        if (!d.policy.timelineEnabled) throw new Error('The application timeline is off; turn it on first');
        const e = { id: id('tl'), at: op.at, app: requireText(op.app, 'app') };
        if (op.endedAt !== undefined) e.endedAt = op.endedAt;
        if (op.title && d.policy.timelineTitles) e.title = String(op.title);
        d.timeline = byAt([...d.timeline, e], (x) => x.at);
        break;
      }
      case 'timeline.delete': d.timeline = d.timeline.filter((x) => x.id !== op.id); dropDead(d); break;
      case 'association.set': {
        if (!op.taskId && !op.capsuleId) throw new Error('Choose a task or a capsule to associate');
        if (!d.timeline.some((t) => t.id === op.sessionId) && !d.focus.some((f) => f.id === op.sessionId)) throw new Error('Session not found');
        const a = { sessionId: op.sessionId, at, ...(op.taskId ? { taskId: op.taskId } : {}), ...(op.capsuleId ? { capsuleId: op.capsuleId } : {}) };
        d.associations = [...d.associations.filter((x) => x.sessionId !== a.sessionId), a];
        break;
      }
      case 'association.clear': d.associations = d.associations.filter((x) => x.sessionId !== op.sessionId); break;
      case 'shelf.add': {
        if (!['file', 'folder', 'url'].includes(op.kind)) throw new Error('shelf kind is invalid');
        const target = requireText(op.target, 'target');
        if (d.shelf.some((x) => x.kind === op.kind && x.target.toLowerCase() === target.toLowerCase())) throw new Error('Already on the shelf');
        d.shelf.push({ id: id('sh'), kind: op.kind, target, label: String(op.label ?? ''), addedAt: at, pinned: false });
        break;
      }
      case 'shelf.pin': { const x = d.shelf.find((s) => s.id === op.id); if (!x) throw new Error('Shelf item not found'); x.pinned = op.pinned === true; break; }
      case 'shelf.remove': d.shelf = d.shelf.filter((x) => x.id !== op.id); break;
      case 'recent.record': {
        const target = requireText(op.target, 'target');
        const hit = d.recents.find((x) => x.kind === op.kind && x.target.toLowerCase() === target.toLowerCase());
        d.recents = [{ id: hit?.id ?? id('rc'), kind: op.kind, target, label: String(op.label ?? '') || hit?.label || '', openedAt: at, count: (hit?.count ?? 0) + 1 }, ...d.recents.filter((x) => x !== hit)].slice(0, 50);
        break;
      }
      case 'recent.remove': d.recents = d.recents.filter((x) => x.id !== op.id); break;
      case 'policy.set': {
        if (typeof op.timelineEnabled === 'boolean') d.policy.timelineEnabled = op.timelineEnabled;
        if (typeof op.timelineTitles === 'boolean') d.policy.timelineTitles = op.timelineTitles;
        if (op.retainDays && typeof op.retainDays === 'object') for (const k of Object.keys(d.policy.retainDays)) if (Number.isFinite(op.retainDays[k])) d.policy.retainDays[k] = Math.round(op.retainDays[k]);
        if (!d.policy.timelineEnabled) d.policy.timelineTitles = false;
        break;
      }
      case 'forget': {
        const scopes = ['checkpoints', 'focus', 'timeline', 'reminders', 'associations', 'shelf', 'recents', 'all'];
        if (!scopes.includes(op.scope)) throw new Error('forget scope is invalid');
        const before = op.before === undefined ? undefined : new Date(Date.parse(op.before)).toISOString();
        const keep = (x) => before !== undefined && x >= before;
        const all = op.scope === 'all';
        if (all || op.scope === 'checkpoints') d.checkpoints = d.checkpoints.filter((x) => keep(x.createdAt));
        if (all || op.scope === 'focus') d.focus = d.focus.filter((x) => keep(x.endedAt));
        if (all || op.scope === 'timeline') d.timeline = d.timeline.filter((x) => keep(x.at));
        if (all || op.scope === 'reminders') d.reminders = d.reminders.filter((x) => keep(x.at));
        if (all || op.scope === 'shelf') d.shelf = d.shelf.filter((x) => keep(x.addedAt));
        if (all || op.scope === 'recents') d.recents = d.recents.filter((x) => keep(x.openedAt));
        if (op.scope === 'associations') d.associations = d.associations.filter((x) => keep(x.at));
        else dropDead(d);
        if (all && before === undefined) d.capsuleMeta = {};
        break;
      }
      default: throw new Error(`unknown operation "${String(op.op).slice(0, 40)}"`);
    }
    mods.productivity = d;
    saveMods();
    return clone(d);
  };
  const calendarSignals = () => {
    const from = Date.now() - 86400000;
    const to = Date.now() + 14 * 86400000;
    return mods.calendar
      .filter((e) => { const t = Date.parse(e.allDay ? `${e.start.slice(0, 10)}T00:00:00` : e.start); return t >= from && t <= to; })
      .slice(0, 200)
      .map((e) => ({ source: 'calendar', id: `${e.id}@${e.start}`.slice(0, 200), title: e.title || '(untitled event)', text: [e.location, e.description].filter(Boolean).join(' · ').slice(0, 300), at: e.allDay ? `${e.start.slice(0, 10)}T00:00:00` : e.start }));
  };

  // ---- Approved documents (DOCUMENT_METHODS). "Choosing" a file returns one labelled demo document; no dialog opens.
  const DEMO_DOC = '# Meeting notes (demo)\n\nThis is fixture text, not a file from this computer.\n\n- Agree the review outline\n- Priya to send support numbers\n- Next check-in on Thursday\n';
  const docTokens = new Map();

  const modules = {
    // Routines
    async routinesList() { return routinesView(); },
    async routinesSave(draft) {
      if (!draft || typeof draft !== 'object') throw new Error('routine is invalid');
      const name = String(draft.name ?? '').trim();
      if (!name) throw new Error('Name is required');
      if (!Array.isArray(draft.steps) || !draft.steps.length) throw new Error('A routine needs at least one step');
      if (draft.steps.length > 20) throw new Error('A routine can have at most 20 steps');
      const steps = draft.steps.map(normStep);
      if (steps[0].condition?.kind === 'previous') throw new Error('Step 1 cannot depend on a previous step');
      const existing = draft.id ? mods.routines.routines.find((r) => r.id === draft.id) : undefined;
      const r = { id: existing?.id ?? id('r'), name: name.slice(0, 80), enabled: draft.enabled !== false, schedule: normSchedule(draft.schedule), steps, createdAt: existing?.createdAt ?? now(), updatedAt: now() };
      if (existing) mods.routines.routines[mods.routines.routines.indexOf(existing)] = r;
      else mods.routines.routines.push(r);
      saveMods();
      activity('routine', `Routine saved: ${r.name}`);
      save();
      return routinesView();
    },
    async routinesRemove(rid) {
      findRoutine(rid);
      mods.routines.routines = mods.routines.routines.filter((r) => r.id !== rid);
      delete mods.routines.status[rid];
      saveMods();
      return routinesView();
    },
    async routinesStart(rid) {
      const r = findRoutine(rid);
      if (mods.routines.paused) throw new Error('Routines are paused. Resume all to run one.');
      const startedAt = now();
      let stopped = false;
      const steps = r.steps.map((s) => {
        if (stopped) return { stepId: s.id, label: s.label, status: 'skipped', attempts: 0, reason: 'Stopped after an earlier step did not run' };
        if (s.kind === 'wait') return { stepId: s.id, label: s.label, status: 'succeeded', attempts: 1 };
        stopped = true;
        return { stepId: s.id, label: s.label, status: 'blocked', attempts: 1, reason: 'Fixture backend cannot run desktop actions' };
      });
      const run = { id: id('run'), routineId: r.id, routineName: r.name, trigger: 'manual', status: 'failed', startedAt, endedAt: plusSec(startedAt, 1), reason: 'Fixture backend: desktop steps were not run (test data).', steps };
      mods.routines.runs = [run, ...mods.routines.runs].slice(0, 50);
      mods.routines.status[r.id] = { ...(mods.routines.status[r.id] || { missedCount: 0 }), lastRunId: run.id, lastRunAt: startedAt, lastResult: run.status };
      saveMods();
      return { runId: run.id };
    },
    async routinesCancel(runId) {
      if (!mods.routines.runs.some((x) => x.id === runId)) throw new Error('Run not found');
      return routinesView();
    },
    async routinesPauseAll() { mods.routines.paused = true; saveMods(); return routinesView(); },
    async routinesResumeAll() { mods.routines.paused = false; saveMods(); return routinesView(); },
    async routinesUndo(runId) {
      const run = mods.routines.runs.find((x) => x.id === runId);
      if (!run) throw new Error('Run not found');
      const pending = run.steps.filter((s) => s.status === 'succeeded' && s.undo && !s.undo.undone).length;
      return { run: clone(run), undone: 0, failed: pending, reason: 'Fixture backend cannot move windows, so nothing was reversed.' };
    },
    async routinesPlanText(text) { return planFrom('rules', String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(candidate)); },
    async routinesPlanModel(json) {
      let o;
      try { o = JSON.parse(String(json)); } catch { return { status: 'blocked', source: 'model', step: null, summary: 'Blocked routine', reason: 'The proposal is not valid JSON.' }; }
      if (!o || !Array.isArray(o.steps)) return { status: 'blocked', source: 'model', step: null, summary: 'Blocked routine', reason: 'The proposal needs a "steps" list.' };
      const plan = planFrom('model', o.steps.map((s) => (s && s.type === 'wait' ? candidate(`wait ${s.seconds}`) : s && s.type === 'open-url' ? candidate(`open ${s.target}`) : s && s.type === 'focus' ? candidate(`focus ${s.target}`) : s && s.type === 'launch' ? candidate(`launch ${s.target}`) : 'only open-url, launch, focus and wait steps are understood by the fixture')));
      return plan.status === 'ready' && typeof o.name === 'string' ? { ...plan, name: o.name.slice(0, 80) } : plan;
    },

    // Local model runtime
    async modelsOverview() { return modelsOverview(); },
    async modelsSelect(name) {
      const M = mods.models;
      const hit = M.serverUp && M.installed.find((m) => sameModel(m.name, name));
      if (!hit) return { ok: false, reason: `${String(name).slice(0, 80)} is not installed (fixture backend).` };
      return { ok: true, patch: { localModel: hit.name }, warmed: false };
    },
    async modelsUnload(name) {
      const M = mods.models;
      const gone = M.loaded.filter((m) => name === undefined || sameModel(m.name, name)).map((m) => m.name);
      M.loaded = M.loaded.filter((m) => !gone.includes(m.name));
      saveMods();
      return { ok: true, unloaded: gone };
    },
    async modelsSetProfile(pid) {
      if (!PROFILES.some((p) => p.id === pid)) throw new Error('Unknown resource profile');
      mods.models.profile = pid;
      saveMods();
      return pid;
    },
    async modelsValidatePack() { return { ok: false, errors: ['Fixture backend cannot read folders on this computer, so no model pack was checked.'], totalBytes: 0 }; },
    async modelsStartImport() { return { ok: false, reason: 'Fixture backend: model packs are never imported (test data).' }; },
    async modelsStartPull() { return { ok: false, reason: 'Fixture backend: models are never downloaded.' }; },
    async modelsCancelJob() { return false; },
    async modelsPickPackFolder() { return null; },

    // Integrations
    async integrationsList() { return INTEG.map(integView); },
    async integrationsPreview(iid) { return clone(integPreview(integDef(iid))); },
    async integrationsCheck(iid) {
      const d = integDef(iid);
      const p = integPreview(d);
      const at = now();
      if (!p.allowed || !checkable(d)) return { id: d.id, ok: false, at, reason: p.reason ?? 'Nothing to check' };
      const r = { id: d.id, ok: false, at, reason: 'Fixture backend: no request was sent (test data).', hint: 'Run the connection check in the desktop app to contact the provider.' };
      integLast.set(d.id, r);
      return clone(r);
    },
    async integrationsSetKey(iid, k) {
      const d = integDef(iid);
      if (!d.key) throw new Error(`${d.name} does not use a key`);
      if (String(k ?? '').trim().length < 8) throw new Error('That does not look like a full key.');
      if (d.key.slot === 'github') mods.integrations.githubKey = true;
      else keys[d.key.slot] = true;
      integLast.delete(d.id);
      saveMods();
      return { configured: true };
    },
    async integrationsRemoveKey(iid) {
      const d = integDef(iid);
      if (!d.key) throw new Error(`${d.name} does not use a key`);
      if (d.key.slot === 'github') mods.integrations.githubKey = false;
      else keys[d.key.slot] = false;
      integLast.delete(d.id);
      saveMods();
      return { configured: false };
    },
    async integrationsSetEnabled(iid, on) {
      const d = integDef(iid);
      if (typeof on !== 'boolean') throw new Error('Enabled must be true or false');
      if (!optIn(d)) throw new Error(`${d.name} has nothing to turn on`);
      mods.integrations.enabled[d.id] = on;
      if (!on) integLast.delete(d.id);
      saveMods();
      return integView(d);
    },
    async integrationsUsage() { return clone(mods.integrations.usage); },
    async integrationsClearUsage() { mods.integrations.usage = []; saveMods(); },

    // Usage ledger
    async usageReport() { return usageSummary(); },
    async usageExport(format) {
      if (format !== 'csv' && format !== 'json') throw new Error('format must be csv or json');
      // No save dialog in the fixture: resolves as a cancelled export, like exportData.
      return { path: null, rows: mods.usage.events.length, truncated: false };
    },
    async usageSetPrices(input) {
      const list = input && typeof input === 'object' ? input.prices : undefined;
      if (!Array.isArray(list) || list.length > 200) throw new Error('prices must be a list');
      const prices = list.map((p) => {
        if (!p || typeof p !== 'object' || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(p.provider)) || !String(p.model ?? '').trim()) throw new Error('price must name a provider and a model');
        const n = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw new Error(`${name} must be a number from 0 to 1000`); return v; };
        return { provider: p.provider, model: String(p.model).trim(), inputPerMillion: n(p.inputPerMillion, 'inputPerMillion'), outputPerMillion: n(p.outputPerMillion, 'outputPerMillion') };
      });
      mods.usage.prices = prices;
      mods.usage.events = mods.usage.events.map((e) => { if (e.runtime !== 'cloud') return e; const p = priceFor(prices, e.provider, e.model); return { ...e, cost: costOf(p, e), costState: p ? 'estimated' : 'unpriced' }; });
      saveMods();
      return clone(prices);
    },
    async usageSetBudget(input) {
      const b = input && typeof input === 'object' ? input.budget : undefined;
      if (b === null || b === undefined) { mods.usage.budget = null; saveMods(); return null; }
      if (typeof b !== 'object' || (b.period !== 'day' && b.period !== 'month')) throw new Error('period must be day or month');
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount < 0 || b.amount > 1000000) throw new Error('amount must be a number from 0 to 1000000');
      const thresholds = b.thresholds === undefined ? [0.5, 0.8, 1] : b.thresholds;
      if (!Array.isArray(thresholds) || thresholds.length > 10 || !thresholds.every((x) => typeof x === 'number' && x > 0 && x <= 10)) throw new Error('each threshold must be a fraction above 0 and at most 10');
      mods.usage.budget = { amount: b.amount, period: b.period, thresholds: [...new Set(thresholds)].sort((x, y) => x - y) };
      saveMods();
      return clone(mods.usage.budget);
    },

    // Clipboard history
    async clipboardStatus() { return clipStatus(); },
    async clipboardSetEnabled(on) {
      if (typeof on !== 'boolean') throw new Error('Enabled must be true or false');
      // Stands in for the native confirmation being accepted. The fixture never reads the system clipboard.
      mods.clipboard.enabled = on;
      if (!on) mods.clipboard.entries = [];
      activity('clipboard', on ? 'Clipboard history turned on (fixture)' : 'Clipboard history turned off and cleared');
      save();
      saveMods();
      return clipStatus();
    },
    async clipboardList() { return [...mods.clipboard.entries].sort((a, b) => b.capturedAt - a.capturedAt).map((e) => ({ id: e.id, preview: e.text.replace(/\s+/g, ' ').slice(0, 120), capturedAt: e.capturedAt, copies: e.copies })); },
    async clipboardGet(cid) { return mods.clipboard.entries.find((e) => e.id === cid)?.text ?? null; },
    async clipboardRemove(cid) {
      const before = mods.clipboard.entries.length;
      mods.clipboard.entries = mods.clipboard.entries.filter((e) => e.id !== cid);
      saveMods();
      return mods.clipboard.entries.length < before;
    },
    async clipboardPurge() { mods.clipboard.entries = []; saveMods(); return clipStatus(); },

    // Measured resources (fixture numbers, labelled as unmeasured where the fixture has nothing to measure).
    async systemResources() {
      const total = 16 * 1024 ** 3;
      const free = 7 * 1024 ** 3;
      return { at: now(), memory: { totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercent: Math.round(((total - free) / total) * 1000) / 10 }, processMemory: { rssBytes: 180 * 1024 ** 2, heapUsedBytes: 60 * 1024 ** 2, heapTotalBytes: 90 * 1024 ** 2, externalBytes: 8 * 1024 ** 2 }, cpuBusyPercent: null, processCpuPercent: null, logicalCores: 8, osUptimeSeconds: 2 * 86400, processUptimeSeconds: 600, appProcesses: [], battery: null, unavailable: [{ id: 'cpu', reason: 'Fixture backend does not sample the processor' }, { id: 'battery', reason: 'Fixture backend has no battery reader' }] };
    },

    // Productivity sidecar, capsule tools
    async productivityGet() { return clone(mods.productivity); },
    async productivityApply(op) { return prodApply(op); },
    async productivityForgetHistory(opts) {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (!o.chat && !o.activity) throw new Error('Choose chat and/or activity history to forget');
      const before = o.before ? new Date(Date.parse(o.before)).toISOString() : undefined;
      const gone = (at) => before === undefined || at < before;
      const removed = { chat: 0, activity: 0 };
      if (o.chat) { const n = state.chat.length; state.chat = state.chat.filter((m) => !gone(m.createdAt)); removed.chat = n - state.chat.length; }
      if (o.activity) { const n = state.activity.length; state.activity = state.activity.filter((a) => !gone(a.at)); removed.activity = n - state.activity.length; }
      save();
      return { removed };
    },
    async productivitySignals() { return calendarSignals(); },
    async capsulePreviewRestore(cid) {
      const c = state.capsules.find((x) => x.id === cid);
      if (!c) throw new Error('Capsule not found');
      return { capsule: c.name, items: c.items.map((i) => ({ kind: i.kind, target: i.target, label: i.label, ok: i.kind === 'url', detail: i.kind === 'url' ? 'Would open in your browser after you confirm (fixture preview)' : 'Fixture backend cannot open files, folders or apps' })), windows: [], windowsError: 'Fixture backend cannot read open windows' };
    },
    async capsuleListWindows() { throw fxErr('open windows cannot be read here.'); },
    async capsuleCaptureGeometry() { throw fxErr('window positions cannot be captured here.'); },
    async capsuleExportPack() { return { saved: false, unmapped: [] }; },
    async capsuleReadPack() { return null; },
    async capsuleParsePack() { throw fxErr('capsule packs are not parsed here.'); },

    // Local .ics calendar
    async calendarList() { return clone(mods.calendar); },
    async calendarImportText(text) {
      if (typeof text !== 'string' || !text) throw new Error('Calendar data must be text');
      const r = parseIcsLite(text.replace(/^\uFEFF/, ''));
      if (r.error) return { added: 0, dropped: 0, total: mods.calendar.length, skipped: r.skipped, error: r.error };
      let added = 0;
      for (const e of r.events) {
        const i = mods.calendar.findIndex((x) => x.id === e.id);
        if (i >= 0) mods.calendar[i] = e;
        else { mods.calendar.push(e); added++; }
      }
      const dropped = Math.max(0, mods.calendar.length - 2000);
      if (dropped) mods.calendar = mods.calendar.slice(0, 2000);
      saveMods();
      activity('calendar', `Imported ${added} calendar event(s)`);
      save();
      return { added, dropped, total: mods.calendar.length, skipped: r.skipped };
    },
    // No file dialogs in the fixture: these resolve the way a cancelled dialog does.
    async calendarImportFile() { return { imported: false, added: 0, dropped: 0, total: mods.calendar.length, skipped: [] }; },
    async calendarExport() { return { saved: false, events: mods.calendar.length }; },
    async calendarClear() { const removed = mods.calendar.length; mods.calendar = []; saveMods(); return { removed }; },

    // Approved documents
    async documentsChoose() {
      const token = id('doc');
      docTokens.set(token, DEMO_DOC);
      return { status: 'ready', token, name: 'meeting-notes-demo.md', format: 'markdown', bytes: DEMO_DOC.length, chars: DEMO_DOC.length, lines: DEMO_DOC.split('\n').length - 1, text: DEMO_DOC, suggestedTitle: 'Meeting notes (demo)' };
    },
    async documentsSave(token, options) {
      const text = docTokens.get(token);
      if (text === undefined) throw new Error('This preview has expired. Choose the file again.');
      docTokens.delete(token);
      const title = String(options?.title ?? '').trim() || 'Meeting notes (demo)';
      const tags = Array.isArray(options?.tags) && options.tags.length ? options.tags.map(String) : ['imported'];
      state.notes.unshift({ id: id('n'), title, body: text, tags, updatedAt: now() });
      activity('note', 'Document imported as a note (fixture)');
      save();
      return { saved: true, title };
    },
    async documentsDiscard(token) { return docTokens.delete(token); },
  };
  Object.assign(window.jarvis, modules);
  const j = window.jarvis;
  window.jarvis.productivity = {
    get: () => j.productivityGet(),
    apply: (op) => j.productivityApply(op),
    forgetHistory: (opts) => j.productivityForgetHistory(opts),
    capsule: {
      previewRestore: (cid) => j.capsulePreviewRestore(cid),
      listWindows: () => j.capsuleListWindows(),
      captureGeometry: (cid, hwnds) => j.capsuleCaptureGeometry(cid, hwnds),
      exportPack: (cid, roots) => j.capsuleExportPack(cid, roots),
      readPack: () => j.capsuleReadPack(),
      parsePack: (raw, mappings) => j.capsuleParsePack(raw, mappings),
    },
    signals: () => j.productivitySignals(),
  };
})();
