import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  const code = bundle.outputFiles[0].text;
  return {code, m: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)};
}
const {m} = await load('src/ui/browser-refs.ts');
const {BROWSER_REFS_LIMITS, BROWSER_REF_REASONS, parseBrowserRefs, splitAgainstCapsule, toCapsuleItems, normalizeBrowserUrl} = m;

const NETSCAPE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">Work</H3>
    <DL><p>
        <DT><A HREF="https://example.com/docs?a=1&amp;b=2" ADD_DATE="1700000000">Docs &amp; Guides &#8212; &quot;v2&quot;</A>
        <DT><H3>Research &lt;AI&gt;</H3>
        <DL><p>
            <DT><A HREF="https://arxiv.org/abs/1234" ADD_DATE="1700000100">Paper</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="http://top.example.org/">Top level</A>
    <DT><A HREF="https://noname.example.net/path/">   </A>
</DL><p>`;

test('limits are exact', () => {
  assert.deepEqual({...BROWSER_REFS_LIMITS}, {inputChars:400000, items:500, labelChars:160});
});

test('Netscape HTML: nested folders, entities, add dates, label fallback and skip line numbers', () => {
  const r = parseBrowserRefs(NETSCAPE);
  assert.equal(r.detected, 'netscape-html');
  assert.equal(r.truncated, false);
  assert.equal(r.items.length, 4);
  const [docs, paper, top, noname] = r.items;
  assert.equal(docs.target, 'https://example.com/docs?a=1&b=2');
  assert.equal(docs.label, 'Docs & Guides \u2014 "v2"');
  assert.equal(docs.folder, 'Work');
  assert.equal(docs.addedAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(paper.folder, 'Work/Research <AI>');
  assert.equal(top.folder, undefined);
  assert.equal(top.label, 'Top level');
  assert.equal(noname.label, 'noname.example.net/path');
  assert.deepEqual(r.folders, ['Work', 'Work/Research <AI>']);
  assert.deepEqual(r.skipped, [{line: 12, reason: BROWSER_REF_REASONS.javascript}]);
  for (const it of r.items) assert.equal(it.kind, 'url');
});

test('JSON array of {title,url} and {name,url}; bad entries skipped by index', () => {
  const r = parseBrowserRefs(JSON.stringify([
    {title: 'One', url: 'https://one.example/'},
    {name: 'Two', url: 'https://two.example/x'},
    {title: 'No url'},
    'nope',
    {url: 'https://three.example/a/b/'},
  ]));
  assert.equal(r.detected, 'json');
  assert.deepEqual(r.items.map((i) => [i.label, i.target]), [['One', 'https://one.example/'], ['Two', 'https://two.example/x'], ['three.example/a/b', 'https://three.example/a/b/']]);
  assert.deepEqual(r.skipped, [{line: 3, reason: BROWSER_REF_REASONS.jsonEntry}, {line: 4, reason: BROWSER_REF_REASONS.jsonEntry}]);
  assert.throws(() => parseBrowserRefs('[{"title": broken'), /looks like JSON but could not be parsed/);
});

test('Markdown links, including several per line and blocked schemes', () => {
  const r = parseBrowserRefs('# Reading\n- [Alpha](https://alpha.example/a) and [Beta](http://beta.example)\n\nplain text\n- [Local](file:///C:/x.txt)\n- [Titled](https://gamma.example/g "hover")');
  assert.equal(r.detected, 'markdown');
  assert.deepEqual(r.items.map((i) => i.label), ['Alpha', 'Beta', 'Titled']);
  assert.equal(r.items[1].target, 'http://beta.example/');
  assert.deepEqual(r.skipped, [{line: 5, reason: BROWSER_REF_REASONS.file}]);
});

test('plain lines: title<TAB>url, bare url, title - url, and unrecognized lines', () => {
  const r = parseBrowserRefs('Tab title\thttps://a.example/1\nhttps://b.example/2\nDash title - https://c.example/3\njust some words here\nexample.com');
  assert.equal(r.detected, 'lines');
  assert.deepEqual(r.items.map((i) => [i.label, i.target]), [['Tab title', 'https://a.example/1'], ['b.example/2', 'https://b.example/2'], ['Dash title', 'https://c.example/3']]);
  assert.deepEqual(r.skipped, [{line: 4, reason: BROWSER_REF_REASONS.unrecognizedLine}, {line: 5, reason: BROWSER_REF_REASONS.notAbsolute}]);
});

test('scheme and credential rejection with exact reasons', () => {
  const r = parseBrowserRefs(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings', 'https://user:pw@evil.example/', 'https://user@evil.example/', 'ftp://x.example/', 'ok\thttps://fine.example/'].join('\n'));
  assert.deepEqual(r.items.map((i) => i.target), ['https://fine.example/']);
  assert.deepEqual(r.skipped, [
    {line: 1, reason: 'Blocked scheme javascript: (scripts are never imported)'},
    {line: 2, reason: 'Blocked scheme data: (inline data is never imported)'},
    {line: 3, reason: 'Blocked scheme file: (local files are not imported as links)'},
    {line: 4, reason: 'Blocked scheme chrome: (browser-internal pages cannot be opened as links)'},
    {line: 5, reason: 'URL contains embedded credentials (user:password@); not imported'},
    {line: 6, reason: 'URL contains embedded credentials (user:password@); not imported'},
    {line: 7, reason: 'Unsupported scheme ftp: (only http and https are kept)'},
  ]);
});

test('dedupe by normalized URL (scheme/host case, trailing slash, fragment)', () => {
  assert.equal(normalizeBrowserUrl('HTTPS://Example.COM/Path/#frag'), 'https://example.com/Path');
  const r = parseBrowserRefs('https://example.com/a\nHTTPS://EXAMPLE.com/a/\nhttps://example.com/a#section\nhttps://example.com/A');
  assert.equal(r.items.length, 2, 'path case is significant');
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reason]), [[2, BROWSER_REF_REASONS.duplicate], [3, BROWSER_REF_REASONS.duplicate]]);
});

test('cap at 500 with truncated flag, label cap, and throws for empty/oversize/unrecognizable', () => {
  const many = Array.from({length: 520}, (_, i) => `https://site${i}.example/`).join('\n');
  const r = parseBrowserRefs(many);
  assert.equal(r.items.length, 500);
  assert.equal(r.truncated, true);
  const long = parseBrowserRefs(`${'x'.repeat(400)}\thttps://long.example/`);
  assert.equal(long.items[0].label.length, 160);
  assert.throws(() => parseBrowserRefs(''), /Nothing to import/);
  assert.throws(() => parseBrowserRefs('   \n  '), /Nothing to import/);
  assert.throws(() => parseBrowserRefs('a'.repeat(400001)), /too large/);
  assert.throws(() => parseBrowserRefs('hello there friend\nanother sentence here'), /No links were recognized/);
});

test('splitAgainstCapsule uses the same normalization and ignores non-url items', () => {
  const r = parseBrowserRefs('https://keep.example/x\nhttps://have.example/y\nhttps://path.example/z');
  const capsuleItems = [
    {kind: 'url', target: 'HTTPS://HAVE.example/y/#top', label: 'Have'},
    {kind: 'file', target: 'https://path.example/z', label: 'not a url item'},
  ];
  const {fresh, alreadyPresent} = splitAgainstCapsule(r.items, capsuleItems);
  assert.deepEqual(fresh.map((i) => i.target), ['https://keep.example/x', 'https://path.example/z']);
  assert.deepEqual(alreadyPresent.map((i) => i.target), ['https://have.example/y']);
});

test('toCapsuleItems maps to the exact capsule item shape', () => {
  const r = parseBrowserRefs(NETSCAPE);
  const out = toCapsuleItems(r.items);
  assert.equal(out.length, 4);
  for (const it of out) assert.deepEqual(Object.keys(it).sort(), ['kind', 'label', 'target']);
  assert.deepEqual(out[0], {kind: 'url', target: 'https://example.com/docs?a=1&b=2', label: 'Docs & Guides \u2014 "v2"'});
});

test('browser-refs.ts is offline and DOM-free; Capsules panel shows the required note and saves via saveCapsule', async () => {
  const src = await readFile(path.join(root, 'src/ui/browser-refs.ts'), 'utf8');
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|require\(\s*['"](node:)?fs['"]\s*\)|from\s+['"](node:)?fs/.test(src), false);
  assert.equal(/\bdocument\.|\bwindow\.|localStorage/.test(src), false);
  for (const line of src.split('\n').filter((l) => /^\s*import\b/.test(l))) assert.match(line, /^import type /);
  const ui = await readFile(path.join(root, 'src/components/Capsules.tsx'), 'utf8');
  assert.ok(ui.includes('This build reads only text you paste. It does not read browser profiles or live tabs; no browser extension is included.'));
  assert.ok(ui.includes('Import browser bookmarks or tabs (paste, offline)'));
  assert.match(ui, /api\.saveCapsule\(\{ id: capsule\.id, items: \[\.\.\.capsule\.items, \.\.\.toCapsuleItems\(selectedItems\)\] \}\)/);
});
