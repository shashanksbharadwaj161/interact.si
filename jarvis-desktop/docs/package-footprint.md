# Packaged application footprint — 14 October 2026

Unused production node_modules are excluded by explicit build file patterns. The renderer is bundled by Vite; Electron main/preload are bundled by esbuild. Current actual archive imports only Electron and Node builtins. No runtime app dependency was removed from source dependencies or development tooling.

Before: app.asar 26,845,586 bytes, 4,645 files, 4,627 dependency files. After: 1,406,357 bytes, 47 files, zero node_modules files, 30 JavaScript files and 31 renderer assets. Most removed files were the unused Phosphor source distribution. This measures the ASAR code/archive footprint; Electron binaries remain in the installer.

Read-only artifact audit: `node scripts/verify-package-footprint.mjs`. It rejects external or computed runtime requires requiring review, validates index assets, checks all 11 unpacked PowerShell helper hashes against the shipped manifest, and asserts dependencies are absent. Any future unbundled runtime dependency requires revisiting this policy.

Packaged-code Electron smoke: `npm run smoke -- --packaged`. It loads main/preload/renderer from the actual new ASAR using the repo-local Electron runtime and isolated temporary user data. All 20 routes mounted, zero renderer errors, zero external requests. Offline CRUD, native availability and security checks passed. Approximate working set 393 MB during this run, not a startup or idle benchmark. This is not an installation/uninstallation or packaged-executable lifecycle test.

The full suite passes 955 tests, no failures/skips/TODOs; TypeScript/build pass. Installer remains unsigned. Screen-reader and second-laptop acceptance, signing and upgrade/install recovery remain open.
