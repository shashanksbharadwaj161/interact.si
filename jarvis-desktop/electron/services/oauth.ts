// Per-user account connections (OAuth 2.0 authorization code + PKCE, RFC 7636 / RFC 8252), main process only.
//
// Each person connects their own account. The app holds no account of its own: a provider can be used only after the
// app owner registers a public (PKCE) client with that provider and supplies its client id through configuration
// (OAuthRegistration). Without it the provider reports `blocked` with the exact registration step that is missing.
// Nothing here invents a client id, embeds a client secret or reports a connection that did not happen.
//
// Flow (OAuthConnector.connect):
// 1. Trusted native confirmation listing the provider, the account access (scopes in plain words) and where the token
//    is kept. Cancel is the default.
// 2. PKCE verifier/challenge and a random state; a one-shot loopback listener on exactly the registered 127.0.0.1 port
//    and path; the authorization link opens in the person's browser.
// 3. The callback must hit that exact path with the exact state; anything else is refused. The attempt expires after
//    five minutes; Cancel, expiry or a second attempt closes the listener.
// 4. The code is exchanged (code_verifier, no secret) through the injected guarded POST. The refresh token goes to the
//    protected vault (DPAPI); the access token stays in memory. Granted scopes are what the provider returned.
// Disconnect revokes at the provider when it offers revocation, then deletes the stored token, and says which happened.
// Codes, verifiers, tokens and state are never logged (redactOAuthText for any error text).
import {createPkce, createOAuthState, stateMatches, redactOAuthText, type PkcePair} from './integrations';
import type {KeyAdapter} from './integrations';

export type OAuthProviderId = 'google-gmail' | 'google-calendar' | 'spotify';

export type OAuthProviderDef = {
  id: OAuthProviderId;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  /** Scopes requested and what each allows, in plain words for the confirmation. */
  scopes: {scope: string; meaning: string}[];
  /** Where the owner registers the client (shown in the blocked reason and the checklist). */
  console: string;
};

export const OAUTH_PROVIDERS: readonly OAuthProviderDef[] = [
  {
    id: 'google-gmail', name: 'Gmail', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: [{scope: 'https://www.googleapis.com/auth/gmail.send', meaning: 'Send email as you (only messages you review and confirm)'}],
    console: 'Google Cloud console › APIs & Services › Credentials',
  },
  {
    id: 'google-calendar', name: 'Google Calendar', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: [{scope: 'https://www.googleapis.com/auth/calendar.events', meaning: 'See, add and change events in your calendars (changes only after you confirm each one)'}],
    console: 'Google Cloud console › APIs & Services › Credentials',
  },
  {
    id: 'spotify', name: 'Spotify', authorizeUrl: 'https://accounts.spotify.com/authorize', tokenUrl: 'https://accounts.spotify.com/api/token', revokeUrl: null,
    scopes: [{scope: 'user-read-playback-state', meaning: 'See what is playing'}, {scope: 'user-modify-playback-state', meaning: 'Play, pause and skip on your devices'}],
    console: 'Spotify for Developers › Dashboard',
  },
];

/** What the owner supplies per provider after registering a public client. No secret field exists by design. */
export type OAuthRegistration = {clientId: string; redirectPort: number; redirectPath: string};

export const OAUTH_ATTEMPT_MS = 5 * 60_000;
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{8,200}$/;
const PATH_RE = /^\/[A-Za-z0-9/_-]{1,60}$/;

/** Strict: unknown providers or keys, a secret, a non-loopback-safe port or path are refused. */
export function parseRegistrations(raw: unknown): {ok: Partial<Record<OAuthProviderId, OAuthRegistration>>; problems: string[]} {
  const ok: Partial<Record<OAuthProviderId, OAuthRegistration>> = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return {ok, problems};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {ok, problems: ['The account registration file must be a JSON object']};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!OAUTH_PROVIDERS.some((p) => p.id === id)) { problems.push(`Unknown provider "${id.slice(0, 30)}"`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`${id}: must be an object`); continue; }
    const o = v as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['clientId', 'redirectPort', 'redirectPath'].includes(k));
    if (extra.some((k) => /secret/i.test(k))) { problems.push(`${id}: a client secret must never be configured; register a public (PKCE) client`); continue; }
    if (extra.length) { problems.push(`${id}: unknown fields ${extra.slice(0, 3).join(', ')}`); continue; }
    if (typeof o.clientId !== 'string' || !CLIENT_ID_RE.test(o.clientId)) { problems.push(`${id}: clientId is not valid`); continue; }
    if (typeof o.redirectPort !== 'number' || !Number.isInteger(o.redirectPort) || o.redirectPort < 1024 || o.redirectPort > 65535) { problems.push(`${id}: redirectPort must be 1024 to 65535`); continue; }
    if (typeof o.redirectPath !== 'string' || !PATH_RE.test(o.redirectPath)) { problems.push(`${id}: redirectPath must look like /oauth/callback`); continue; }
    ok[id as OAuthProviderId] = {clientId: o.clientId, redirectPort: o.redirectPort, redirectPath: o.redirectPath};
  }
  return {ok, problems};
}

export const redirectUri = (r: OAuthRegistration) => `http://127.0.0.1:${r.redirectPort}${r.redirectPath}`;

/** One callback request received by the loopback listener (path and query only). */
export type LoopbackHit = {path: string; query: URLSearchParams};
export interface LoopbackListener {
  /** Resolves with the first request to `path`; other paths get 404 and are ignored. Rejects on close. */
  next(): Promise<LoopbackHit>;
  /** Responds to the request that `next` returned, then stops listening. */
  finish(ok: boolean, message: string): void;
  close(): void;
}

export type OAuthStatus = {
  provider: OAuthProviderId; name: string;
  state: 'blocked' | 'not-connected' | 'connecting' | 'connected';
  reason?: string;
  grantedScopes?: string[];
  connectedAt?: string;
};

export type OAuthDeps = {
  registrations: Partial<Record<OAuthProviderId, OAuthRegistration>>;
  vault: KeyAdapter;
  confirm: (summary: string, detail: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  listen: (port: number, path: string) => Promise<LoopbackListener>;
  /** Form POST through the guarded network path (online mode, exact provider token/revoke URL). */
  post: (url: string, form: URLSearchParams, signal: AbortSignal) => Promise<{status: number; json: unknown}>;
  online: () => boolean;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  activity?: (summary: string) => Promise<void> | void;
};

const slot = (id: OAuthProviderId) => `oauth-${id}`;

export class OAuthConnector {
  private attempt: {provider: OAuthProviderId; abort: AbortController; listener: LoopbackListener | null} | null = null;
  private access = new Map<OAuthProviderId, {token: string; expiresAt: number; scopes: string[]; connectedAt: string}>();
  private readonly now: () => number;
  constructor(private readonly d: OAuthDeps) { this.now = d.now ?? (() => Date.now()); }

  private def(id: unknown): OAuthProviderDef {
    const p = OAUTH_PROVIDERS.find((x) => x.id === id);
    if (!p) throw new Error('Unknown account provider');
    return p;
  }

  blockedReason(id: OAuthProviderId): string | null {
    const p = this.def(id);
    if (!this.d.registrations[id]) return `Not available yet: no ${p.name} client is registered for this app (${p.console}). See the account setup checklist.`;
    return null;
  }

  async status(id: OAuthProviderId): Promise<OAuthStatus> {
    const p = this.def(id);
    const blocked = this.blockedReason(id);
    if (blocked) return {provider: id, name: p.name, state: 'blocked', reason: blocked};
    if (this.attempt?.provider === id) return {provider: id, name: p.name, state: 'connecting'};
    const a = this.access.get(id);
    if (a) return {provider: id, name: p.name, state: 'connected', grantedScopes: a.scopes, connectedAt: a.connectedAt};
    if (await this.d.vault.has(slot(id))) return {provider: id, name: p.name, state: 'connected', reason: 'A saved sign-in exists; it is checked the next time it is used.'};
    return {provider: id, name: p.name, state: 'not-connected'};
  }

  cancel(): boolean {
    const a = this.attempt;
    if (!a) return false;
    a.abort.abort();
    a.listener?.close();
    this.attempt = null;
    return true;
  }

  async connect(id: OAuthProviderId): Promise<{ok: true; status: OAuthStatus} | {ok: false; reason: string; cancelled?: boolean}> {
    const p = this.def(id);
    const blocked = this.blockedReason(id);
    if (blocked) return {ok: false, reason: blocked};
    if (!this.d.online()) return {ok: false, reason: 'Online mode is off. Turn it on to connect an account.'};
    const reg = this.d.registrations[id]!;
    const detail = [
      `${p.name} will ask you to sign in in your browser and to allow:`,
      ...p.scopes.map((s) => `• ${s.meaning}`),
      '',
      'The sign-in is saved protected on this computer (Windows data protection). You can disconnect at any time.',
      `The browser returns to ${redirectUri(reg)} on this computer only.`,
    ].join('\n');
    if (!(await this.d.confirm(`Connect your ${p.name} account?`, detail).catch(() => false))) return {ok: false, reason: 'Not connected: you chose Cancel.', cancelled: true};
    this.cancel();
    const abort = new AbortController();
    const attempt: {provider: OAuthProviderId; abort: AbortController; listener: LoopbackListener | null} = {provider: id, abort, listener: null};
    this.attempt = attempt;
    const timer = setTimeout(() => { abort.abort(); attempt.listener?.close(); }, OAUTH_ATTEMPT_MS);
    (timer as {unref?: () => void}).unref?.();
    const pkce: PkcePair = createPkce(this.d.random);
    const state = createOAuthState(this.d.random);
    try {
      let listener: LoopbackListener;
      try { listener = await this.d.listen(reg.redirectPort, reg.redirectPath); } catch { return {ok: false, reason: `Port ${reg.redirectPort} on this computer is in use, so the sign-in cannot return here. Close what uses it and try again.`}; }
      attempt.listener = listener;
      if (abort.signal.aborted) { listener.close(); return {ok: false, reason: 'Stopped.', cancelled: true}; }
      const u = new URL(p.authorizeUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', reg.clientId);
      u.searchParams.set('redirect_uri', redirectUri(reg));
      u.searchParams.set('scope', p.scopes.map((s) => s.scope).join(' '));
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('code_challenge', pkce.challenge);
      u.searchParams.set('state', state);
      if (id.startsWith('google')) { u.searchParams.set('access_type', 'offline'); u.searchParams.set('prompt', 'consent'); }
      await this.d.openExternal(u.href);
      let hit: LoopbackHit;
      try { hit = await listener.next(); } catch { return {ok: false, reason: abort.signal.aborted ? 'The sign-in was cancelled or took longer than five minutes. Nothing was saved.' : 'The sign-in did not return.', cancelled: abort.signal.aborted}; }
      if (!stateMatches(state, hit.query.get('state'))) { listener.finish(false, 'This sign-in response did not match. Nothing was saved; you can close this tab.'); return {ok: false, reason: 'The sign-in response did not match this attempt, so it was ignored. Nothing was saved.'}; }
      const err = hit.query.get('error');
      if (err) { listener.finish(false, 'The sign-in was not completed. You can close this tab.'); return {ok: false, reason: err === 'access_denied' ? 'You did not allow access. Nothing was saved.' : `${p.name} reported "${err.replace(/[^a-z_]/gi, '').slice(0, 40)}". Nothing was saved.`}; }
      const code = hit.query.get('code');
      if (!code || code.length > 2048) { listener.finish(false, 'The sign-in response was incomplete. You can close this tab.'); return {ok: false, reason: 'The sign-in response had no usable code. Nothing was saved.'}; }
      listener.finish(true, `Your ${p.name} sign-in reached the app. You can close this tab.`);
      if (abort.signal.aborted) return {ok: false, reason: 'Stopped. Nothing was saved.', cancelled: true};
      const form = new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: redirectUri(reg), client_id: reg.clientId, code_verifier: pkce.verifier});
      let res: {status: number; json: unknown};
      try { res = await this.d.post(p.tokenUrl, form, abort.signal); } catch (e) {
        return {ok: false, reason: abort.signal.aborted ? 'Stopped. Nothing was saved.' : `The sign-in could not be completed (${redactOAuthText(e instanceof Error ? e.message : 'network error').slice(0, 120)}). Nothing was saved.`};
      }
      const t = res.json as Record<string, unknown> | null;
      if (res.status !== 200 || !t || typeof t.access_token !== 'string') return {ok: false, reason: `${p.name} did not issue a sign-in (HTTP ${res.status}). Nothing was saved.`};
      // Granted scopes are what the provider says it granted; when it says nothing, the requested set is not assumed.
      const granted = typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean).slice(0, 20) : [];
      if (typeof t.refresh_token === 'string' && t.refresh_token) await this.d.vault.store(slot(id), t.refresh_token);
      const expiresIn = typeof t.expires_in === 'number' && t.expires_in > 0 ? Math.min(t.expires_in, 86_400) : 3600;
      const connectedAt = new Date(this.now()).toISOString();
      this.access.set(id, {token: t.access_token, expiresAt: this.now() + expiresIn * 1000, scopes: granted, connectedAt});
      await this.d.activity?.(`${p.name} account connected${typeof t.refresh_token === 'string' ? '' : ' for this session only (no refresh token was issued)'}`);
      return {ok: true, status: {provider: id, name: p.name, state: 'connected', grantedScopes: granted, connectedAt, ...(granted.length ? {} : {reason: `${p.name} did not list the granted access.`})}};
    } finally {
      clearTimeout(timer);
      attempt.listener?.close();
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  async disconnect(id: OAuthProviderId, signal: AbortSignal = new AbortController().signal): Promise<{removedLocally: boolean; revokedAtProvider: boolean | 'not-offered'; reason?: string}> {
    const p = this.def(id);
    const access = this.access.get(id);
    this.access.delete(id);
    let revoked: boolean | 'not-offered' = 'not-offered';
    let reason: string | undefined;
    if (p.revokeUrl) {
      const token = (await this.d.vault.use(slot(id), async (k) => k)) ?? access?.token ?? null;
      if (token && this.d.online()) {
        try { revoked = (await this.d.post(p.revokeUrl, new URLSearchParams({token}), signal)).status === 200; } catch { revoked = false; }
        if (!revoked) reason = `${p.name} did not confirm the revocation. Remove the app's access in your ${p.name} account settings as well.`;
      } else {
        revoked = false;
        reason = token ? 'Online mode is off, so access was not revoked at the provider. Remove it in your account settings as well.' : undefined;
      }
    } else {
      reason = `${p.name} offers no revocation to apps. Remove the app's access in your ${p.name} account settings.`;
    }
    await this.d.vault.remove(slot(id));
    const removedLocally = !(await this.d.vault.has(slot(id)));
    await this.d.activity?.(`${p.name} account disconnected${revoked === true ? ' and access revoked' : ''}`);
    return {removedLocally, revokedAtProvider: revoked, ...(reason ? {reason} : {})};
  }
}

/* ---------- Operation previews (nothing is sent from here) ---------- */

export type EmailDraft = {to: string[]; subject: string; body: string};
const EMAIL_RE = /^[^\s@<>(),;:"\[\]]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** The exact message a Gmail send would carry, for the trusted confirmation. Refuses anything it cannot show exactly. */
export function previewGmailSend(d: EmailDraft): {ok: true; summary: string; detail: string; raw: string} | {ok: false; reason: string} {
  if (!Array.isArray(d.to) || !d.to.length || d.to.length > 10 || !d.to.every((x) => typeof x === 'string' && EMAIL_RE.test(x))) return {ok: false, reason: 'Give 1 to 10 valid recipient addresses'};
  if (typeof d.subject !== 'string' || /[\r\n]/.test(d.subject) || d.subject.length > 200) return {ok: false, reason: 'The subject must be one line of at most 200 characters'};
  if (typeof d.body !== 'string' || d.body.length > 20_000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(d.body)) return {ok: false, reason: 'The message must be plain text of at most 20,000 characters'};
  // RFC 5322 message with an encoded subject; the person sees the same values unencoded.
  const subject = `=?UTF-8?B?${Buffer.from(d.subject, 'utf8').toString('base64')}?=`;
  const raw = [`To: ${d.to.join(', ')}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', d.body.replace(/\r?\n/g, '\r\n')].join('\r\n');
  return {ok: true, summary: `Send this email to ${d.to.join(', ').slice(0, 80)}?`, detail: `To: ${d.to.join(', ')}\nSubject: ${d.subject}\n\n${d.body}`, raw: Buffer.from(raw, 'utf8').toString('base64url')};
}

export type EventChange = {action: 'create' | 'update' | 'delete'; calendarId: string; eventId?: string; title?: string; start?: string; end?: string};

/** The exact calendar change, for the trusted confirmation. */
export function previewCalendarChange(c: EventChange): {ok: true; summary: string; detail: string} | {ok: false; reason: string} {
  if (!['create', 'update', 'delete'].includes(c.action)) return {ok: false, reason: 'Unknown calendar change'};
  if (typeof c.calendarId !== 'string' || !/^[A-Za-z0-9._@#-]{1,200}$/.test(c.calendarId)) return {ok: false, reason: 'Calendar is not valid'};
  if (c.action !== 'create' && (typeof c.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(c.eventId))) return {ok: false, reason: 'Event is not valid'};
  const iso = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
  if (c.action !== 'delete' && (!iso(c.start) || !iso(c.end) || Date.parse(c.end!) <= Date.parse(c.start!))) return {ok: false, reason: 'Give a start and a later end as date and time'};
  if (c.action !== 'delete' && (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 200 || /[\r\n]/.test(c.title))) return {ok: false, reason: 'Give a one-line title'};
  const verb = c.action === 'create' ? 'Add' : c.action === 'update' ? 'Change' : 'Delete';
  return {ok: true, summary: `${verb} this calendar event?`, detail: `${verb} in calendar ${c.calendarId}${c.eventId ? ` (event ${c.eventId})` : ''}${c.title ? `\nTitle: ${c.title}` : ''}${c.start ? `\nStart: ${c.start}\nEnd: ${c.end}` : ''}`};
}
