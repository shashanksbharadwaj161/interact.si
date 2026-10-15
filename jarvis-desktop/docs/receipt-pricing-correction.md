# Receipt pricing correction — 14 October 2026

Live console observed $145.59 month-to-date spend and $354.42 credits (newer than the pasted $137.03/$362.98). Provider billing is authoritative; console scope and local request estimates are separate.

The Control Room previously estimated every completed cache write at the conservative one-hour rate and every Haiku request at the long-prompt tier. Reported usage receipts contain cache TTL counts. All 2,688 settled receipts examined reported five-minute writes, no one-hour writes; 491 Haiku receipts were at or below 100,000 total prompt tokens.

Official source: https://platform.claude.com/docs/en/about-claude/pricing. Five-minute writes are 1.25x base input, one-hour writes 2x; Haiku's threshold includes uncached input, cache writes and cache reads.

Audited, idempotent migration retained every request and original charge, and all 167 unresolved reservations. Completed receipt estimates changed from $172.5415161 to $143.64303636; unresolved charges remain $80.8961305. Total conservative commitment became $224.53916686. A private pre-migration backup and aggregate audit record are retained; no secrets included in this document.

Protection increased to $32 to retain the requested $30 buffer plus headroom for the difference between observed organization spending and local receipt estimates. $300 limit unchanged. Available conservative allowance before the new batch: $43.46083314; new four-Fable/two-Opus batch has fixed $42 total task ceilings.

Reserve-before-inference remains worst-case. Unknown/interrupted requests are not forgiven or assumed free. Missing/invalid usage or unknown modifiers retain conservative handling. New receipt settlement uses verified TTL/tier rates. Public task costs derive from settled ledger receipts, so history reflects the correction. Control Room suite: 46/46 pass.

Current personal installer remains the baseline verified in docs/installer-verification.json. New OCR UI, live voice/avatar, procedural 3D and project-memory work require integration and fresh runtime verification before inclusion in the next installer.
