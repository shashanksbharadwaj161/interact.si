/*
 * TEST FIXTURE ONLY. Injected by scripts/ui-review.mjs and scripts/ui-journeys.mjs into a plain browser page before the
 * app loads. It implements the window.jarvis contract with labelled in-memory data so screenshots and journeys can show
 * real UI states (ready, unavailable, error, streaming) without Electron, a model, a key or the network.
 * It is never bundled with the app, never calls a provider and stores only booleans for keys (never the key text).
 *
 * Configure with window.__FIXTURE__ = { chat: 'ready' | 'unavailable', systemError: string | null, onboarded, seed: 'empty' | 'populated', stt, tts }.
 */
(function install() {
  const cfg = Object.assign({ chat: 'ready', systemError: null, onboarded: true, seed: 'empty', stt: false, tts: false, mode: 'offline', persist: true }, window.__FIXTURE__ || {});
  const KEY = 'fixture.backend.state';
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
    settings: { onboarded: cfg.onboarded, mode: cfg.mode, theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'llama3.2:3b', localEndpoint: 'http://127.0.0.1:11434', cloudModel: '', cloudProvider: 'anthropic', voice: '', allowedRoots: [], approvedApps: [], retainDays: 90 },
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
  const keys = { anthropic: false, openai: false, openrouter: false };
  const caps = () => [
    cfg.chat === 'ready' ? { id: 'local-llm', name: 'Local model', available: true } : { id: 'local-llm', name: 'Local model', available: false, reason: 'Ollama did not respond at http://127.0.0.1:11434' },
    keys.anthropic || keys.openai || keys.openrouter ? { id: 'cloud', name: 'Cloud model', available: state.settings.mode === 'online' } : { id: 'cloud', name: 'Cloud model', available: false, reason: 'No API key is saved' },
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
      state.chat.push({ id: id('m'), role: 'user', text, createdAt: now(), source: 'local' });
      const m = cfg.chat === 'ready' ? { id: id('m'), role: 'assistant', text: REPLY, createdAt: now(), source: 'local' } : { id: id('m'), role: 'assistant', text: 'Local model unavailable: Ollama did not respond. No reply was generated.', createdAt: now(), source: 'system' };
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
    async setProviderKey(provider, k) { if (String(k).length < 8) throw new Error('That does not look like a full API key.'); keys[provider] = true; return { provider, configured: true }; },
    async clearProviderKey(provider) { keys[provider] = false; return { provider, configured: false }; },
    async previewAction(a) { return { id: id('p'), summary: `Fixture preview: ${a.type}`, requiresApproval: a.type !== 'list-windows', allowed: false, reason: 'Fixture backend cannot control a desktop.' }; },
    async executeAction() { throw new Error('Fixture backend cannot run desktop actions'); },
    async speak() { return { ok: false, reason: 'Fixture backend has no speech engine' }; },
    async transcribe() { return { text: '', reason: 'Fixture backend has no speech recognizer' }; },
    async exportData() { return { path: null }; },
    async importData() { return save(); },
    async pickPath() { return null; },
    onActivity() { return () => {}; },
    async getApiInfo() {
      return { apiVersion: 2, features: [{ id: 'chat-streaming', available: true }, { id: 'chat-cancel', available: true }, { id: 'intent-planner', available: false, reason: 'Fixture backend has no planner' }, { id: 'search', available: true }] };
    },
    async chatStreamStart(text) {
      if (cfg.chat !== 'ready') {
        state.chat.push({ id: id('m'), role: 'user', text, createdAt: now(), source: 'local' });
        save();
      } else state.chat.push({ id: id('m'), role: 'user', text, createdAt: now(), source: 'local' });
      save();
      const start = { streamId: id('s'), generation: ++generation, route: 'local' };
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
        const reply = { id: id('m'), role: 'assistant', text, createdAt: now(), source: outcome === 'failed' ? 'system' : 'local' };
        if (text) state.chat.push(reply);
        if (note) state.chat.push({ id: id('m'), role: 'assistant', text: note, createdAt: now(), source: 'system' });
        save();
        handler({ ...tag(++n), type: 'done', outcome, reply, stored: state.chat.slice(-2) });
      };
      setTimeout(() => {
        if (!alive) return;
        handler({ ...tag(++n), type: 'status', status: 'connecting' });
        if (cfg.chat !== 'ready') {
          setTimeout(() => finish('failed', '', 'Local model unavailable: Ollama did not respond at http://127.0.0.1:11434. No reply was generated. Start Ollama, then try again.'), 500);
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
})();
