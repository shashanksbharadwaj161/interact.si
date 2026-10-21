# Account connections: owner registration checklist

**Status on 21 Oct 2026:**
- **Blocked for every provider.** No developer registration exists (owner confirmed).
- The code seam is implemented and tested with a fake provider: `electron/services/oauth.ts` and `electron/services/loopback.ts`.
- The app never shows a connected account that did not really connect. Until a registration exists, each provider reports `blocked` with the missing step.

## How a person connects (once a provider is registered)

1. **Confirm.** A trusted Windows confirmation names the provider and each permission in plain words. Cancel is the default.
2. **Sign in.** The app listens on `127.0.0.1:<registered port><registered path>`, and nowhere else. The person's browser opens the provider's sign-in page with:
   - PKCE S256;
   - a random state;
   - **no client secret**.
3. **Callback.** The return must hit exactly that path with exactly that state. The attempt expires after 5 minutes, and Cancel ends it. Anything else is refused and nothing is saved.
4. **Token exchange.** The code goes through the network guard's `oauth` purpose: only the listed token URL, POST only, online mode only, no credential header.
5. **Storage.**
   - The refresh token goes to the Windows-protected vault, in slot `oauth-<provider>`.
   - The access token stays in memory.
   - The granted scopes shown are the ones the provider returned.
6. **Disconnect.**
   - Revokes at the provider where it offers revocation (Google).
   - Always deletes the local token.
   - Says plainly when revocation was not possible (Spotify offers none; also offline mode, or a provider error).
7. **Gmail send and calendar changes.**
   - Only exact previews exist so far (`previewGmailSend`, `previewCalendarChange`). They are for the trusted confirmation.
   - **No send or change call is implemented.** Nothing is sent during development.

## What the owner registers

Write `<userData>/account-registrations.json`. It contains public data only, and a field containing "secret" is refused:

```json
{
  "google-calendar": {"clientId": "<from the console>", "redirectPort": 43821, "redirectPath": "/oauth/callback"},
  "google-gmail":    {"clientId": "<from the console>", "redirectPort": 43821, "redirectPath": "/oauth/callback"},
  "spotify":         {"clientId": "<from the dashboard>", "redirectPort": 43821, "redirectPath": "/oauth/callback"}
}
```

Problems in the file are listed in `backend.accountRegistrationProblems`. Those providers stay blocked.

### Google (Gmail send, Calendar events)

1. In Google Cloud console:
   - create a project;
   - enable the **Gmail API** and the **Google Calendar API**;
   - configure the **OAuth consent screen**: app name, support email and the scopes below.
2. Add test users while the app is in "Testing".
   - **`gmail.send` is a Sensitive scope** (not Restricted). It is listed under "Sensitive scopes" ("Send email on your behalf"), and sensitive scopes "require additional OAuth App Verification" before public release. Source: developers.google.com/workspace/gmail/api/auth/scopes, checked 21 Oct 2026.
   - The Calendar scope page (developers.google.com/workspace/calendar/api/auth) does not state a classification for `calendar.events`. It says only that public apps using such scopes "must complete a verification process". Check the verification centre in the console.
3. Create an **OAuth client ID** of type **Desktop app**. Put its client id in the file.
4. Scopes used:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.events`
5. **Client secret: not used.** This matches Google's documentation (developers.google.com/identity/protocols/oauth2/native-app, checked 21 Oct 2026):
   - `client_secret` is marked **Optional** in both the code exchange and the refresh request, and the sample refresh request omits it.
   - The page says desktop apps "are public clients and cannot keep secrets confidential. Always use PKCE".
   - The app therefore sends no secret, which matches the documentation; a live sign-in with the owner's test account has still not been run.
6. **Loopback port.**
   - The page says to start a listener "on a random available port", and also that the redirect URI "must exactly match one of the authorized redirect URIs" configured for the client.
   - The app uses the fixed port from the registration file, which satisfies both readings.
   - Whether a Desktop client accepts other ports without registering them is not stated, so keep the configured port.
7. **Revocation:** `https://oauth2.googleapis.com/revoke`, using the token as a parameter. HTTP 200 means success. This is what the app does.

### Spotify

1. In Spotify for Developers, create an app and add the redirect URI **exactly**: `http://127.0.0.1:43821/oauth/callback`.
2. Use the **Authorization Code with PKCE** flow (no client secret).
3. Scopes: `user-read-playback-state` and `user-modify-playback-state`.
4. Development mode allows only listed users; extended quota needs Spotify's review.

## Token refresh (implemented)

`OAuthConnector.accessToken(provider)` works as follows:
- It reuses the cached access token while more than a minute is left.
- Otherwise it sends a `refresh_token` grant with `client_id` and no secret, through the guarded `oauth` purpose.
- Concurrent callers share one refresh.
- A rotated refresh token replaces the stored one.
- HTTP 400 or 401 (for example `invalid_grant`) removes the stored sign-in and returns `reconnect: true`.
- Network failures keep it, with the error text redacted.
- Offline mode sends nothing.

## Hub IPC (implemented on the Electron side; shared types by Codex)

```ts
type AccountProvider = 'google-gmail' | 'google-calendar' | 'spotify';
accountsStatus(provider: AccountProvider): Promise<AccountStatus>;            // AccountStatus = OAuthStatus in oauth.ts
accountsConnect(provider: AccountProvider): Promise<AccountConnectResult>;    // = OAuthConnector.connect result
accountsCancel(): Promise<boolean>;
accountsDisconnect(provider: AccountProvider): Promise<{removedLocally: boolean; revokedAtProvider: boolean | 'not-offered'; reason?: string}>;
```

## Still to build after registration

- **Account setup UI** (Codex), over the IPC above.
- **Gmail send and Calendar changes.** Each must:
  - show the preview in the trusted confirmation;
  - make one API call through a new allow-listed purpose for `gmail.googleapis.com` and `www.googleapis.com/calendar/v3`;
  - read back or check the provider's response before a verified receipt;
  - offer no undo for sent email.
- **A live acceptance run** with the owner's own test account. That is outside this cloud session.
