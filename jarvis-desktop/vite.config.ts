import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
// Two pages: the hub (index.html) and the desktop companion island with its selection overlay (companion.html).
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({base:'./',server:{host:'127.0.0.1',port:4319},preview:{host:'127.0.0.1',port:4319},build:{rollupOptions:{input:{main:r('./index.html'),companion:r('./companion.html')}}}});
