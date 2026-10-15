import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = await build({entryPoints: [path.join(root, 'electron/services/models.ts')], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'});
const {validateModelPack, createNodeModelPackIO, ModelRuntime} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'model-pack-path-security-'));
test.after(async () => { await fs.rm(scratch, {recursive: true, force: true}); });
const bytes = Buffer.from('GGUF-test-only');
const manifest = (file) => JSON.stringify({format: 'desktop-companion-modelpack', version: 1, name: 'test:tiny', files: [{path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}]});
async function pack(name, file = 'm.gguf') {
  const dir = path.join(scratch, name);
  await fs.mkdir(path.dirname(path.join(dir, file)), {recursive: true});
  await fs.writeFile(path.join(dir, file), bytes);
  await fs.writeFile(path.join(dir, 'modelpack.json'), manifest(file));
  return dir;
}
function observedIO() {
  const io = createNodeModelPackIO(), calls = [];
  return {calls, io: Object.fromEntries(Object.entries(io).map(([key, fn]) => [key, (...args) => {calls.push([key, args[0]]); return fn(...args); }]))};
}
const windows = {skip: process.platform !== 'win32'};

test('unsafe model-pack folder syntax is rejected before any pack I/O', async () => {
  for (const dir of ['\\\\server\\share', '\\\\?\\C:\\pack', 'C:\\pack:stream', 'C:\\NUL\\pack', 'C:\\pack.\\x', 'C:\\a\\..\\pack']) {
    const {io, calls} = observedIO();
    assert.equal((await validateModelPack(io, dir)).ok, false, dir);
    assert.deepEqual(calls, []);
  }
});

test('pack folder junction is refused before manifest lstat or read', windows, async () => {
  const target = await pack('root-target'), linked = path.join(scratch, 'root-link');
  await fs.symlink(target, linked, 'junction');
  const {io, calls} = observedIO();
  const result = await validateModelPack(io, linked);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /junction/);
  assert.deepEqual(calls, []);
});

test('junction in an ancestor of the pack is refused before manifest access', windows, async () => {
  const target = await pack('ancestor-target/pack'), linked = path.join(scratch, 'ancestor-link');
  await fs.symlink(path.dirname(target), linked, 'junction');
  const {io, calls} = observedIO();
  assert.equal((await validateModelPack(io, path.join(linked, 'pack'))).ok, false);
  assert.deepEqual(calls, []);
});

test('nested model junction is refused before file lstat, hashing or streaming', windows, async () => {
  const dir = await pack('nested-pack', 'sub/m.gguf'), target = await pack('nested-target');
  await fs.rm(path.join(dir, 'sub'), {recursive: true});
  await fs.symlink(target, path.join(dir, 'sub'), 'junction');
  const {io, calls} = observedIO();
  const result = await validateModelPack(io, dir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /junction/);
  assert.ok(calls.every(([, p]) => !p.toLowerCase().includes('\\sub\\')));
  assert.ok(calls.every(([op]) => op !== 'sha256' && op !== 'openStream'));
});

test('import rechecks folders after confirmation and never streams replaced junction', windows, async () => {
  const dir = await pack('import-pack', 'sub/m.gguf'), target = await pack('import-target');
  const {io, calls} = observedIO();
  const requests = [];
  const runtime = new ModelRuntime({io, newId: () => 'security-test', settings: () => ({mode: 'offline', localEndpoint: 'http://127.0.0.1:11434'}), fetch: async (url) => {requests.push(url); return new Response(null, {status: 404});}, guard: async () => {
    await fs.rm(path.join(dir, 'sub'), {recursive: true});
    await fs.symlink(target, path.join(dir, 'sub'), 'junction');
    return {allowed: true};
  }});
  const result = await runtime.startImport(dir);
  assert.equal(result.ok, true);
  for (let i = 0; i < 100 && runtime.jobs()[0].state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(runtime.jobs()[0].state, 'failed');
  assert.match(runtime.jobs()[0].error, /junction/);
  assert.deepEqual(requests, []);
  assert.ok(calls.every(([op]) => op !== 'openStream'));
});
