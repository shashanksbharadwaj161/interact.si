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
   - Sensitive or restricted scopes (`gmail.send` is restricted) need Google verification before public release. Plan for the review time.
3. Create an **OAuth client ID** of type **Desktop app**. Put its client id in the file.
4. Scopes used:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.events`
5. **Decision needed: Google client secret.**
   - Google issues a client secret even for Desktop-app clients, and its token endpoint may expect it.
   - This app's rule is **no embedded client secret**, so the exchange is sent without one.
   - Before a live test, the owner should check Google's current documentation for installed apps using PKCE, then choose one of:
     - (a) confirm that Google accepts the exchange without a secret;
     - (b) decide explicitly whether a non-confidential desktop secret is acceptable. That needs a code change and a security note;
     - (c) use a different client type.
   - Until then, Google stays "registration required" in practice.

### Spotify

1. In Spotify for Developers, create an app and add the redirect URI **exactly**: `http://127.0.0.1:43821/oauth/callback`.
2. Use the **Authorization Code with PKCE** flow (no client secret).
3. Scopes: `user-read-playback-state` and `user-modify-playback-state`.
4. Development mode allows only listed users; extended quota needs Spotify's review.

## Still to build after registration

- **Hub IPC and UI.** This touches the shared contracts (Codex) and needs these methods:
  - `accountsStatus(provider)`;
  - `accountsConnect(provider)`, which shows the native confirmation;
  - `accountsCancel()`;
  - `accountsDisconnect(provider)`.
- **Token refresh.** A refresh-token grant on expiry. Same purpose, no secret.
- **Gmail send and Calendar changes.** Each must:
  - show the preview in the trusted confirmation;
  - make one API call through a new allow-listed purpose for `gmail.googleapis.com` and `www.googleapis.com/calendar/v3`;
  - read back or check the provider's response before a verified receipt;
  - offer no undo for sent email.
- **A live acceptance run** with the owner's own test account. That is outside this cloud session.
