import {build} from 'esbuild';
await build({entryPoints:['electron/main.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist-electron/main.cjs',external:['electron'],target:'node22'});
await build({entryPoints:['electron/preload.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist-electron/preload.cjs',external:['electron'],target:'node22'});
