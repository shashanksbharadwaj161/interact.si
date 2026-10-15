// Coding-session adapter (goal 38): turns PASTED git history text into checkpoint drafts for the existing memory store.
// Pure and DOM-free. It never runs git, never reads files or repositories and never touches the network; the only input is
// the text the user pasted. Drafts are written by the caller through the store's existing `checkpoint.add` operation.

export const ADAPTER_LIMITS = { inputChars: 200_000, commits: 2000, sessions: 200, gapMinutes: 120, maxGapMinutes: 43_200 } as const;

/** Store limits for checkpoint records (mirrors PRODUCTIVITY_LIMITS in electron/services/portable.ts). */
const CHECKPOINT_TITLE = 120;
const CHECKPOINT_NOTE = 4000;
const TITLE_CAP = 120;
const SUMMARY_CAP = 2000;
const PID = /^[A-Za-z0-9_-]{1,64}$/;

export type GitLayout = 'default' | 'oneline' | 'tsv';
export type GitCommit = { sha: string; author?: string; at?: string; subject: string; body?: string };
export type ParsedGitLog = { commits: GitCommit[]; layout: GitLayout; skippedLines: number; truncated: boolean };
export type CodingSession = {
  id: string; undated: boolean; startedAt?: string; endedAt?: string; commitCount: number; commits: GitCommit[]; title: string; summary: string;
};
export type GroupedSessions = { sessions: CodingSession[]; truncated: boolean; totalSessions: number };
/** Evidence refs accepted by the store; kinds are restricted there, so git evidence travels as `gitRefs` and in the note. */
export type DraftRef = { kind: 'capsule'; id: string };
/** Field names match the store's Checkpoint record (title, note, createdAt, capsuleId, refs) plus traceability extras. */
export type CheckpointDraft = { sessionId: string; title: string; note: string; createdAt?: string; capsuleId?: string; refs: DraftRef[]; gitRefs: string[] };
export type CheckpointAddOp = { op: 'checkpoint.add'; title: string; note: string; refs: DraftRef[]; capsuleId?: string; createdAt?: string };

const RE_DEFAULT = /^commit ([0-9a-f]{7,64})\b/;
const RE_ONELINE = /^([0-9a-f]{7,64}) (.+)$/;
const RE_TSV = /^([0-9a-f]{7,64})\t([^\t]*)\t([^\t]*)\t(.*)$/;
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const subj = (s: string) => cap(clean(s), 200) || '(no subject)';

/** Parses git's default, `--date=iso` and `--date=iso-strict` / `%aI` date forms. Returns an ISO string or undefined. */
export function parseGitDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2}):(\d{2}) (\d{4}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]];
    if (mon === undefined) return undefined;
    const off = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
    const t = Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - off * 60_000;
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(s);
  const iso = m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : s;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function detectLayout(lines: string[]): GitLayout | null {
  let def = 0, one = 0, tsv = 0;
  for (const l of lines) {
    if (RE_DEFAULT.test(l)) def++;
    else if (RE_TSV.test(l)) tsv++;
    else if (RE_ONELINE.test(l)) one++;
  }
  if (def > 0) return 'default';
  if (tsv === 0 && one === 0) return null;
  return tsv >= one ? 'tsv' : 'oneline';
}

/**
 * Parses pasted `git log` text. Supported layouts (auto-detected): default `git log`, `git log --oneline` and
 * `git log --format=%H%x09%an%x09%aI%x09%s`. Unrecognized non-blank lines are counted in skippedLines, never guessed.
 */
export function parseGitLog(text: unknown): ParsedGitLog {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste some git log text first; the input is empty.');
  if (text.length > ADAPTER_LIMITS.inputChars) throw new Error(`The pasted text is too long (${text.length} characters; max ${ADAPTER_LIMITS.inputChars}).`);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const layout = detectLayout(lines);
  if (!layout) throw new Error('No recognizable commit lines were found. Paste output of `git log`, `git log --oneline` or `git log --format=%H%x09%an%x09%aI%x09%s`.');
  const commits: GitCommit[] = [];
  let skippedLines = 0, truncated = false;

  if (layout === 'default') {
    let cur: { c: GitCommit; msg: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const msg = cur.msg;
      while (msg.length && !msg[0].trim()) msg.shift();
      while (msg.length && !msg[msg.length - 1].trim()) msg.pop();
      cur.c.subject = subj(msg[0] ?? '');
      const body = msg.slice(1).join('\n').trim();
      if (body) cur.c.body = body.slice(0, 2000);
      commits.push(cur.c);
      cur = null;
    };
    for (const line of lines) {
      const head = RE_DEFAULT.exec(line);
      if (head) {
        flush();
        if (commits.length >= ADAPTER_LIMITS.commits) { truncated = true; break; }
        cur = { c: { sha: head[1], subject: '' }, msg: [] };
        continue;
      }
      if (!cur) { if (line.trim()) skippedLines++; continue; }
      const c: { c: GitCommit; msg: string[] } = cur;
      const author = /^Author:\s*(.*)$/.exec(line);
      const date = /^(?:Date|AuthorDate):\s*(.*)$/.exec(line);
      if (author && !c.msg.length) { const name = clean(author[1].replace(/<[^>]*>/g, '')); if (name) c.c.author = cap(name, 120); }
      else if (date && !c.msg.length) { const at = parseGitDate(date[1]); if (at) c.c.at = at; else skippedLines++; }
      else if (/^(Merge|Commit|CommitDate):/.test(line) && !c.msg.length) { /* known header, not used */ }
      else if (/^( {4}|\t)/.test(line)) c.msg.push(line.replace(/^( {4}|\t)/, ''));
      else if (!line.trim()) { if (c.msg.length) c.msg.push(''); }
      else skippedLines++;
    }
    flush();
  } else {
    for (const line of lines) {
      if (!line.trim()) continue;
      if (layout === 'tsv') {
        const m = RE_TSV.exec(line);
        if (!m) { skippedLines++; continue; }
        if (commits.length >= ADAPTER_LIMITS.commits) { truncated = true; break; }
        const c: GitCommit = { sha: m[1], subject: subj(m[4]) };
        const author = clean(m[2]);
        if (author) c.author = cap(author, 120);
        const at = parseGitDate(m[3]);
        if (at) c.at = at;
        commits.push(c);
      } else {
        const m = RE_ONELINE.exec(line);
        if (!m) { skippedLines++; continue; }
        if (commits.length >= ADAPTER_LIMITS.commits) { truncated = true; break; }
        commits.push({ sha: m[1], subject: subj(m[2].replace(/^\([^)]*\)\s+/, '')) });
      }
    }
  }
  if (!commits.length) throw new Error('No recognizable commit lines were found in the pasted text.');
  return { commits, layout, skippedLines, truncated };
}

function checkGap(gapMinutes: unknown): number {
  if (gapMinutes === undefined) return ADAPTER_LIMITS.gapMinutes;
  if (typeof gapMinutes !== 'number' || !Number.isFinite(gapMinutes) || gapMinutes <= 0 || gapMinutes > ADAPTER_LIMITS.maxGapMinutes) {
    throw new Error(`gapMinutes must be a number greater than 0 and at most ${ADAPTER_LIMITS.maxGapMinutes}.`);
  }
  return gapMinutes;
}

function summarize(commits: GitCommit[]): string {
  const out: string[] = [];
  let len = 0;
  for (let i = 0; i < commits.length; i++) {
    const line = `- ${commits[i].subject} (${commits[i].sha.slice(0, 7)})`;
    const rest = commits.length - i;
    const more = `- … and ${rest} more`;
    const need = (out.length ? 1 : 0) + line.length;
    const reserve = rest > 1 ? 1 + `- … and ${rest - 1} more`.length : 0;
    if (len + need + reserve > SUMMARY_CAP) { out.push(more); break; }
    out.push(line);
    len += need;
  }
  return out.join('\n').slice(0, SUMMARY_CAP);
}

function makeSession(index: number, commits: GitCommit[], undated: boolean): CodingSession {
  const s: CodingSession = { id: `s-${index}`, undated, commitCount: commits.length, commits, title: cap(commits[0].subject, TITLE_CAP), summary: summarize(commits) };
  if (!undated) { s.startedAt = commits[0].at; s.endedAt = commits[commits.length - 1].at; }
  return s;
}

/**
 * Groups commits into sessions. Dated commits are sorted ascending (ties keep git's newest-first input reversed, so the
 * older commit comes first); a new session starts when the gap to the previous commit is strictly greater than
 * gapMinutes. Undated commits form one final session. At most ADAPTER_LIMITS.sessions sessions are returned.
 */
export function groupSessionsDetailed(commits: GitCommit[], opts: { gapMinutes?: number } = {}): GroupedSessions {
  const gap = checkGap(opts?.gapMinutes);
  if (!Array.isArray(commits)) throw new Error('commits must be a list.');
  const dated = commits.map((c, i) => ({ c, i, t: c.at ? Date.parse(c.at) : NaN })).filter((x) => Number.isFinite(x.t));
  const undated = commits.filter((c) => !c.at || !Number.isFinite(Date.parse(c.at)));
  dated.sort((a, b) => a.t - b.t || b.i - a.i);
  const groups: GitCommit[][] = [];
  let prev = NaN;
  for (const x of dated) {
    if (!groups.length || x.t - prev > gap * 60_000) groups.push([]);
    groups[groups.length - 1].push(x.c);
    prev = x.t;
  }
  const all: { commits: GitCommit[]; undated: boolean }[] = groups.map((g) => ({ commits: g, undated: false }));
  if (undated.length) all.push({ commits: undated, undated: true });
  const kept = all.slice(0, ADAPTER_LIMITS.sessions);
  return { sessions: kept.map((g, i) => makeSession(i, g.commits, g.undated)), truncated: all.length > kept.length, totalSessions: all.length };
}

export function groupSessions(commits: GitCommit[], opts: { gapMinutes?: number } = {}): CodingSession[] {
  return groupSessionsDetailed(commits, opts).sessions;
}

/**
 * Builds drafts shaped like the store's Checkpoint (title, note, createdAt, capsuleId, refs). The store only accepts
 * known evidence kinds, so every commit is kept as a `git:<sha>` string in gitRefs and listed in the note's Evidence line.
 * createdAt is the session's last commit time, clamped to `now` when given (the store rejects future times).
 */
export function buildCheckpointDrafts(sessions: CodingSession[], opts: { capsuleId?: unknown; repoLabel?: unknown; now?: string } = {}): CheckpointDraft[] {
  if (!Array.isArray(sessions)) throw new Error('sessions must be a list.');
  const { capsuleId, repoLabel, now } = opts ?? {};
  if (capsuleId !== undefined && capsuleId !== '' && (typeof capsuleId !== 'string' || !PID.test(capsuleId))) throw new Error('capsuleId must be a capsule id string (letters, digits, _ or -).');
  if (repoLabel !== undefined && typeof repoLabel !== 'string') throw new Error('repoLabel must be a string.');
  const label = typeof repoLabel === 'string' ? cap(clean(repoLabel), 60) : '';
  const nowMs = now === undefined ? NaN : Date.parse(now);
  return sessions.map((s) => {
    const gitRefs = s.commits.map((c) => `git:${c.sha}`);
    const head = s.undated
      ? `Coding session (undated) · ${s.commitCount} commit(s)`
      : `Coding session ${s.startedAt} – ${s.endedAt} · ${s.commitCount} commit(s)`;
    let evidence = 'Evidence:';
    let listed = 0;
    const room = CHECKPOINT_NOTE - head.length - s.summary.length - 4 - 40;
    for (const r of gitRefs) { if (evidence.length + r.length + 1 > room) break; evidence += ` ${r}`; listed++; }
    if (listed < gitRefs.length) evidence += ` … and ${gitRefs.length - listed} more`;
    const note = `${head}\n${s.summary}\n\n${evidence}`.slice(0, CHECKPOINT_NOTE);
    const d: CheckpointDraft = { sessionId: s.id, title: cap(label ? `${label}: ${s.title}` : s.title, CHECKPOINT_TITLE), note, refs: [], gitRefs };
    if (!s.undated && s.endedAt) {
      let t = Date.parse(s.endedAt);
      if (Number.isFinite(nowMs) && t > nowMs) t = nowMs;
      d.createdAt = new Date(t).toISOString();
    }
    if (typeof capsuleId === 'string' && capsuleId) { d.capsuleId = capsuleId; d.refs = [{ kind: 'capsule', id: capsuleId }]; }
    return d;
  });
}

/** The exact `checkpoint.add` operation for one draft; extras such as gitRefs and sessionId are not sent. */
export function toCheckpointOp(d: CheckpointDraft): CheckpointAddOp {
  const op: CheckpointAddOp = { op: 'checkpoint.add', title: d.title, note: d.note, refs: d.refs.map((r) => ({ ...r })) };
  if (d.capsuleId) op.capsuleId = d.capsuleId;
  if (d.createdAt) op.createdAt = d.createdAt;
  return op;
}
