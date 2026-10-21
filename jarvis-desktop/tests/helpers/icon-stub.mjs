// Test helper: an esbuild plugin that replaces @phosphor-icons/react with inert components. The exported names are
// collected from the real imports in src/, so the stub cannot drift from the source when a screen adopts a new icon.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function phosphorIconNames(root) {
  const names = new Set();
  for (const dir of ['src/components', 'src/ui']) {
    for (const f of await readdir(path.join(root, dir))) {
      if (!/\.tsx?$/.test(f)) continue;
      const text = await readFile(path.join(root, dir, f), 'utf8');
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
          if (name) names.add(name);
        }
      }
      for (const m of text.matchAll(/\bPhosphor\.([A-Z]\w*)/g)) names.add(m[1]);
    }
  }
  return [...names];
}

/** esbuild plugin. `extra` adds names a test needs beyond the source imports. */
export async function iconStubPlugin(root, extra = []) {
  const names = [...new Set([...(await phosphorIconNames(root)), ...extra])];
  return {
    name: 'icon-stub',
    setup(b) {
      b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: names.map((n) => `export const ${n} = () => null;`).join('\n'), loader: 'js' }));
    },
  };
}
