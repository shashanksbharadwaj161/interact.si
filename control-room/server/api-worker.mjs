import path from 'node:path';
import { constants } from 'node:fs';
import { readFile, writeFile, rename, mkdir, realpath, lstat, readdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOTS = new Set(['src', 'electron', 'native', 'tests', 'docs', 'scripts']);
const ROOT_FILES = /^(?:package\.json|(?:tsconfig(?:\.[\w-]+)?\.json)|(?:vite|vitest|eslint|postcss|tailwind)\.config\.(?:[cm]?[jt]s)|AGENTS\.md|CLAUDE\.md|README\.md|GOAL\.md|index\.html)$/i;
const BLOCKED = /(?:^\. |^\.|^(?:node_modules|vendor|dist|build|coverage|private|logs?|keys?|secrets?|credentials?)$|(?:^|[._-])(?:env|secret|credential|token|password|key)(?:$|[._-])|\.(?:pem|pfx|p12|key|log)$)/i;
const MAX_FILE = 128 * 1024;
const MAX_RESULT = 24 * 1024;
const MAX_CONTEXT = 700 * 1024;
const TOOLS = [
  { name: 'list_files', description: 'List readable source files; optional source directory.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'read_file', description: 'Read a source file, at most 128 KiB. Optional offset and limit are character counts (limit defaults to 24000, maximum 24000). Use repeated offsets for large files.', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Replace an exactly assigned file with UTF-8 content.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'run_check', description: 'Run one fixed verification: test, typecheck, or build. No commands or arguments accepted.', input_schema: { type: 'object', properties: { check: { enum: ['test', 'typecheck', 'build'] } }, required: ['check'], additionalProperties: false } },
];

function inside(root, file) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function relativeFile(value, directory = false) {
  if (typeof value !== 'string' || !value || value.length > 400 || /[\\:\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)) throw new Error('Unsafe source path');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '..' || BLOCKED.test(p) || /[<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe source path');
  if (!(ROOTS.has(parts[0]) && (directory || parts.length > 1)) && !(parts.length === 1 && ROOT_FILES.test(value))) throw new Error('Path is outside readable source roots');
  return value;
}

/** Deliberately allowlist the child environment; NODE_OPTIONS and provider credentials never propagate. */
export function safeCheckEnvironment(env = process.env) {
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'lang', 'lc_all', 'number_of_processors']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())).concat([['CI', '1'], ['NO_COLOR', '1']]));
}

export async function runApiWorker(config, { fetchProvider = globalThis.fetch, signal } = {}) {
  let gateway;
  try { gateway = new URL(config.gateway); } catch { throw new Error('Invalid scoped loopback gateway'); }
  if (gateway.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(gateway.hostname) || gateway.username || gateway.password || gateway.search || gateway.hash || !/^\/anthropic\/[a-f0-9]{64}$/i.test(gateway.pathname)) throw new Error('Invalid scoped loopback gateway');
  if (!/^claude-[a-z0-9-]+$/.test(config.model || '') || typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.length > 64000 || !Array.isArray(config.files) || !config.files.length || config.files.length > 100) throw new Error('Invalid worker assignment');
  const workspace = await realpath(path.resolve(config.workspace));
  const canonical = await realpath(path.resolve(config.canonicalRepo));
  if (!path.isAbsolute(config.stateFile || '')) throw new Error('State file must be absolute');
  const stateFile = path.resolve(config.stateFile);
  if (inside(workspace, stateFile)) throw new Error('State file must be outside the worker workspace');
  const owned = new Set(config.files.map(p => relativeFile(p)));
  const planner = config.files.length === 1 && config.files[0] === 'docs/loop/decision.json';
  const maxTurns = planner ? 12 : 100;
  let inspections = 0;
  const secrets = [config.gateway, gateway.pathname, gateway.pathname.split('/').at(-1), config.prompt, ...Object.entries(process.env).filter(([key, value]) => /(?:token|secret|password|credential|api.?key|grant)/i.test(key) && value?.length >= 6).map(([, value]) => value)];
  function clean(value, max = MAX_RESULT) {
    let result = String(value);
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    result = result.replace(/(?:sk-ant-|sk-|ghp_|github_pat_)[\w-]{8,}/g, '[redacted]').replace(/\b(?:Bearer\s+)[^\s"']+/gi, '[redacted]').replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
    return result.slice(0, max);
  }
  let state = { state: 'active', summary: 'Working on assigned files.', events: [], pid: process.pid };
  async function persist(patch = {}) {
    state = { ...state, ...patch, events: state.events.slice(-100) };
    await mkdir(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    for(let attempt=0;;attempt++){
      try{await rename(tmp,stateFile);break;}
      catch(error){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
    }
  }
  async function retryDelay(milliseconds) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', cancelled); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(new Error('Worker cancelled')); };
      signal?.addEventListener('abort', cancelled, { once: true });
    });
  }
  async function checkedPath(rel, writing = false) {
    relativeFile(rel);
    if (writing && !owned.has(rel)) throw new Error('File is not assigned to this worker');
    const file = path.resolve(workspace, ...rel.split('/'));
    if (!inside(workspace, file)) throw new Error('Source path escaped workspace');
    let cursor = workspace;
    for (const component of rel.split('/')) {
      cursor = path.join(cursor, component);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || !inside(workspace, await realpath(cursor))) throw new Error('Symlinks and junctions are excluded');
        if (writing && cursor === file && (!info.isFile() || info.nlink > 1)) throw new Error('Write target must be a regular unlinked source file');
      } catch (error) { if (!(writing && error.code === 'ENOENT')) throw error; }
    }
    return file;
  }
  async function listFiles(start = '') {
    const results = [];
    let visits = 0;
    if (start) { relativeFile(start, true); await validateDirectory(start); }
    async function validateDirectory(rel) {
      let cursor = workspace;
      for (const part of rel.split('/')) {
        cursor = path.join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink() || !inside(workspace, await realpath(cursor))) throw new Error('Symlinks and junctions are excluded');
      }
      return cursor;
    }
    // Directory checks must not probe a nonexistent child.
    async function safeWalk(rel, depth = 0) {
      if (++visits > 3000 || results.length >= 1000 || depth > 16) return;
      const absolute = rel ? await validateDirectory(rel) : workspace;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        try { relativeFile(child, entry.isDirectory()); } catch { continue; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await safeWalk(child, depth + 1);
        else if (entry.isFile()) results.push(child);
        if (results.length >= 1000) break;
      }
    }
    await safeWalk(start);
    return results.sort();
  }
  async function executeNode(args) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: workspace, env: safeCheckEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', timedOut = false;
      const capture = chunk => { if (output.length < MAX_RESULT) output += chunk.toString().slice(0, MAX_RESULT - output.length); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const stop = () => child.kill();
      const timeout = setTimeout(() => { timedOut = true; stop(); }, 120000);
      signal?.addEventListener('abort', stop, { once: true });
      child.on('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', stop); reject(new Error('Verification process could not start')); });
      child.on('close', code => { clearTimeout(timeout); signal?.removeEventListener('abort', stop); resolve({ exit: code ?? -1, timedOut, output: clean(output) }); });
    });
  }
  async function trustedTool(tool) {
    const file = path.join(canonical, 'node_modules', ...tool.split('/'));
    const resolved = await realpath(file);
    if (!inside(path.join(canonical, 'node_modules'), resolved)) throw new Error('Verification dependency escapes canonical dependencies');
    return resolved;
  }
  async function perform(tool) {
    const input = tool.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tool input');
    if (planner && tool.name === 'run_check') throw new Error('Planning limit: planners cannot run checks. Dispatch three substantial disjoint tasks using the goal and observations.');
    if (planner && ['list_files', 'read_file'].includes(tool.name) && inspections >= 6) throw new Error('Planning limit: six successful source inspections used. Write docs/loop/decision.json now; use the supplied goal and observations without a full repository audit.');
    if (tool.name === 'list_files') { const result = (await listFiles(input.path ?? '')).join('\n'); inspections++; return result; }
    if (tool.name === 'read_file') {
      const offset = input.offset ?? 0, limit = input.limit ?? 24000;
      if (!Number.isInteger(offset) || offset < 0 || offset > MAX_FILE || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid read window');
      const file = await checkedPath(input.path);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_FILE) throw new Error('Source file exceeds read limit'); const result = clean((await handle.readFile('utf8')).slice(offset, offset + limit)); inspections++; return result; } finally { await handle.close(); }
    }
    if (tool.name === 'write_file') {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_FILE) throw new Error('Content exceeds write limit');
      const file = await checkedPath(input.path, true);
      await mkdir(path.dirname(file), { recursive: true });
      await checkedPath(input.path, true);
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o644);
      try { await handle.writeFile(input.content); } finally { await handle.close(); }
      return 'Assigned file written.';
    }
    if (tool.name === 'run_check') {
      if (Object.keys(input).some(k => k !== 'check') || !['test', 'typecheck', 'build'].includes(input.check)) throw new Error('Unknown fixed check');
      let result;
      if (input.check === 'test') {
        const tests = (await listFiles('tests')).filter(f => /\.(?:test|spec)\.[cm]?js$/.test(f));
        if (!tests.length || tests.length > 200) throw new Error('No bounded test set found');
        result = await executeNode(['--test', ...tests]);
      } else {
        result = await executeNode([await trustedTool('typescript/bin/tsc'), '--noEmit']);
        if (input.check === 'build' && result.exit === 0) result = await executeNode([await trustedTool('vite/bin/vite.js'), 'build']);
        if (input.check === 'build' && result.exit === 0) {
          const script = path.join(canonical, 'scripts', 'build-main.mjs');
          let baseline;
          try { baseline = await readFile(script); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (baseline) {
            const local = await checkedPath('scripts/build-main.mjs');
            const digest = data => createHash('sha256').update(data).digest('hex');
            if (digest(baseline) !== digest(await readFile(local))) throw new Error('Protected build script differs from canonical source');
            result = await executeNode([local]);
          }
        }
      }
      return result;
    }
    throw new Error('Unknown worker tool');
  }
  await persist();
  const messages = [{ role: 'user', content: config.prompt }];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      signal?.throwIfAborted();
      if (JSON.stringify(messages).length > MAX_CONTEXT) { await persist({ state: 'blocked', reason: 'context_limit', summary: 'Context limit reached; review the completed file changes.' }); return state; }
      const request = {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.model, max_tokens: 16384, stream: false, cache_control: { type: 'ephemeral' }, system: `You are a coding worker. Complete the assignment using the tools. Edit only these exact files: ${[...owned].join(', ')}. Read only allowed project sources. Never request secrets, private runtime data, external services, payment changes, or shell commands. ${planner ? 'You are the planner: inspect sources at most six times, then dispatch three substantial tasks with disjoint file ownership in docs/loop/decision.json (version 1). Use the supplied goal and observations; do not perform a full repository audit. You cannot run checks. Write the decision promptly; the runtime stops after a valid checkpoint.' : 'Use fixed checks to verify changes. The runtime stops after an owned docs/loop/result.<role>.json completion checkpoint with done:true and a checks array.'} Give a concise factual completion summary.`, tools: planner ? TOOLS.filter(t => ['write_file', 'read_file', 'list_files'].includes(t.name)) : TOOLS, messages }),
      };
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        try {
          response = await fetchProvider(`${gateway.origin}${gateway.pathname}/v1/messages`, { ...request, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
        } catch {
          signal?.throwIfAborted();
          response = undefined;
        }
        const transient = !response || [429, 500, 502, 503, 504].includes(response.status);
        if (!transient || attempt === 2) break;
        state.events.push({ tool: 'provider_retry', attempt: attempt + 2, status: response ? response.status : 0 });
        await persist();
        // Re-enter the scoped gateway on every attempt so each reservation is
        // independent; an uncertain earlier charge remains held by the gateway.
        await retryDelay(250 * (attempt + 1));
      }
      if (!response) throw new Error('Provider transport retries exhausted');
      if (!response.ok) { await persist({ state: 'failed', reason: `provider_http_${Number(response.status) || 0}`, summary: 'Provider rejected the request; worker stopped.' }); return state; }
      const raw = await response.text();
      if (raw.length > 2 * MAX_CONTEXT) throw new Error('Provider response exceeds limit');
      const body = JSON.parse(raw);
      if (!Array.isArray(body.content) || body.content.length > 64) throw new Error('Invalid provider response');
      // Thinking/signature blocks are carried back verbatim only in memory.
      messages.push({ role: 'assistant', content: body.content });
      const text = body.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) await persist({ summary: clean(text, 1600) });
      const calls = body.content.filter(b => b.type === 'tool_use');
      if (calls.length) {
        if (body.stop_reason !== 'tool_use') throw new Error('Inconsistent provider tool response');
        const results = [];
        const checkpointWrites = new Set();
        for (const call of calls) {
          signal?.throwIfAborted();
          let value, is_error = false;
          try { value = await perform(call); } catch (error) { value = 'Tool rejected: ' + clean(error.code ? `filesystem ${error.code}` : error.message, 300); is_error = true; }
          if (!is_error && call.name === 'write_file' && owned.has(call.input.path) && (call.input.path === 'docs/loop/decision.json' || /^docs\/loop\/result\.[a-z0-9_-]+\.json$/i.test(call.input.path))) checkpointWrites.add(call.input.path);
          const event = { tool: TOOLS.some(t => t.name === call.name) ? call.name : 'unknown', ...(typeof call.input?.path === 'string' && (() => { try { relativeFile(call.input.path, true); return true; } catch { return false; } })() ? { path: call.input.path } : {}), ...(call.name === 'run_check' && ['test', 'typecheck', 'build'].includes(call.input?.check) ? { check: call.input.check, ...(typeof value?.exit === 'number' ? { exit: value.exit } : {}) } : {}) };
          state.events.push(event); await persist();
          results.push({ type: 'tool_result', tool_use_id: call.id, content: clean(typeof value === 'string' ? value : JSON.stringify(value)), ...(is_error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        // Finish the entire settled tool batch before acknowledging a checkpoint.
        // Re-read final file contents so a later overwrite cannot validate stale JSON.
        for (const file of checkpointWrites) {
          let checkpoint;
          try { checkpoint = JSON.parse(await readFile(await checkedPath(file), 'utf8')); } catch { continue; }
          if (checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) && (file === 'docs/loop/decision.json' ? checkpoint.version === 1 : checkpoint.done === true && Array.isArray(checkpoint.checks))) {
            await persist({ state: 'idle', summary: 'Checkpoint written.' });
            return state;
          }
        }
      } else if (body.stop_reason === 'end_turn') { await persist({ state: 'idle', summary: text ? clean(text, 1600) : 'Assignment completed.' }); return state; }
      else { await persist({ state: 'blocked', reason: 'incomplete_response', summary: 'Provider stopped before completing the assignment.' }); return state; }
    }
    await persist({ state: 'blocked', reason: 'turn_limit', summary: `Worker reached the ${maxTurns}-turn safety limit.` });
  } catch {
    await persist({ state: 'failed', reason: signal?.aborted ? 'cancelled' : 'worker_error', summary: signal?.aborted ? 'Worker cancelled.' : 'Worker stopped after a provider or runtime failure.' });
  }
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
  try {
    const configPath = process.argv[2];
    if (!configPath || !path.isAbsolute(configPath)) throw new Error('Missing worker configuration');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (inside(path.resolve(config.workspace), path.resolve(configPath))) throw new Error('Worker configuration must be outside workspace');
    const result = await runApiWorker(config, { signal: abort.signal });
    process.exitCode = result.state === 'failed' ? 1 : 0;
  } catch { console.error('Worker configuration or initialization failed.'); process.exitCode = 1; }
}
