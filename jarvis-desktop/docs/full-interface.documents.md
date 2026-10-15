# Approved documents interface (captain, API v2.4) — 15 October 2026

Owner: captain (`electron/services/approvedDocuments.ts`, central API/glue). Consumer: writing workspace UI (`WritingWorkbench`, owned by the workspace worker).

## Bridge

```ts
import { documentsBridge, type DocumentsBridge } from '../ui/bridges';
const docs = documentsBridge(api); // null when the backend/browser preview lacks the methods -> show "Document import is not connected".
docs.choose(): Promise<ApprovedDocumentPreview>
docs.saveAsNote(token, { title?, tags? }): Promise<{ saved: true; title }>   // default tag ['imported']
docs.discard(token): Promise<boolean>
```

`ApprovedDocumentPreview` (src/shared/contracts.ts):

- `{status:'cancelled'}` — dialog closed; say nothing or "No document chosen".
- `{status:'unsupported', name, format, reason}` — PDF/Word/RTF/ODT/Pages/HTML. Show `reason` verbatim; nothing was read.
- `{status:'ready', token, name, format:'text'|'markdown', bytes, chars, lines, text, suggestedTitle}`.

Errors (rejected promise, show `message`): invalid/UNC/stream path, link or junction, not a file, larger than 100 KB, invalid UTF-8, binary, empty, preview expired.

## Rules for the UI

1. The main process opens the dialog; the renderer never passes or receives a path. `name` is the file name only.
2. `text` is untrusted: render inside a `<pre>`/read-only `<textarea>` as plain text. Never `dangerouslySetInnerHTML`, never Markdown-to-HTML, never feed it to actions.
3. Nothing is stored until the user reviews and presses Save. Let them edit the title (prefill `suggestedTitle`, max 200 chars). The body saved is exactly the previewed text.
4. Offer Discard (calls `discard`). Previews expire after 10 minutes; at most 4 are held.
5. After save, `reload()`/refresh notes and open the new note in the editor.
