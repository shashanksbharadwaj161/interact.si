import { useState } from 'react';
import { ArrowSquareOut, Copy } from '@phosphor-icons/react';
import { VIEWS } from '../ui/nav';
import { Button, Empty, Field, KV, Notice, PageHeader, Panel } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { fmtDateTime, isLoopbackHost, parseHttpUrl, truncate } from '../ui/util';

export function Developer() {
  const { state, settings, system, isPreview, toast, cloudConfigured } = useReady();
  const [saved, setSaved] = usePref('controlRoomUrl', '');
  const [url, setUrl] = useState(saved);
  const parsed = parseHttpUrl(url);
  const error = !url.trim() ? null : !parsed ? 'Enter a full http:// address.' : !isLoopbackHost(parsed.hostname) ? 'Only addresses on this computer (localhost or 127.0.0.1) are accepted.' : null;
  const valid = parsed !== null && error === null;
  const activity = [...state.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);

  const copy = async () => {
    const report = {
      app: 'Desktop Companion UI',
      runtime: isPreview ? 'browser preview (no backend)' : 'electron',
      platform: system?.platform ?? 'unknown',
      arch: system?.arch ?? 'unknown',
      ramGB: system?.ramGB ?? 0,
      mode: settings.mode,
      theme: settings.theme,
      reduceMotion: settings.reduceMotion,
      cloudKeyConfigured: cloudConfigured,
      counts: { capsules: state.capsules.length, notes: state.notes.length, tasks: state.tasks.length, chat: state.chat.length },
      allowedRoots: settings.allowedRoots.length,
      approvedApps: settings.approvedApps.length,
      capabilities: system?.capabilities.map((c) => ({ id: c.id, available: c.available, reason: c.reason })) ?? [],
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('ok', 'Diagnostics copied. They contain no paths, notes or keys.');
    } catch {
      toast('error', 'Clipboard access was blocked.');
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="System" title="Developer" subtitle="Diagnostics, shortcuts and a link out to the local Control Room." />

      <div className="two-col">
        <div className="stack">
          <Panel title="Control Room" eyebrow="External link">
            <p className="field-hint">
              Control Room is a separate local tool. This app does not start it, embed it or send it any data. Enter the address it serves on this computer, and the link below opens it in your default browser when you click it.
            </p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) {
                  setSaved(url.trim());
                  toast('ok', 'Address remembered in this app’s display preferences.');
                }
              }}
            >
              <Field label="Control Room address" error={error} hint="Remembered locally as a display preference. Must be localhost or 127.0.0.1.">
                {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={url} spellCheck={false} maxLength={200} placeholder="http://127.0.0.1:PORT" onChange={(e) => setUrl(e.target.value)} />}
              </Field>
              <div className="row">
                <Button type="submit" disabled={!valid || url.trim() === saved}>Remember address</Button>
                {valid && parsed ? (
                  <a className="btn btn-primary" href={parsed.href} target="_blank" rel="noopener noreferrer">
                    <ArrowSquareOut size={16} aria-hidden />
                    <span>Open Control Room</span>
                  </a>
                ) : (
                  <span className="sub">Enter a valid local address to enable the link.</span>
                )}
              </div>
            </form>
          </Panel>

          <Panel title="Runtime" eyebrow="This window">
            <dl className="kv-list">
              <KV k="Backend">{isPreview ? 'None (browser preview bridge)' : 'Electron preload API (window.jarvis)'}</KV>
              <KV k="Platform">{system ? `${system.platform} ${system.arch}` : 'unknown'}</KV>
              <KV k="Theme">{settings.theme}</KV>
              <KV k="Records">{state.capsules.length} capsules · {state.notes.length} notes · {state.tasks.length} tasks · {state.chat.length} messages</KV>
            </dl>
            <Button icon={Copy} onClick={() => void copy()}>Copy diagnostics</Button>
          </Panel>

          <Panel title="Keyboard" eyebrow="Shortcuts">
            <dl className="kv-list">
              {VIEWS.slice(0, 10).map((v, i) => (
                <div key={v.id} className="kv">
                  <dt>{v.label}</dt>
                  <dd><kbd>Alt</kbd> + <kbd>{i === 9 ? 0 : i + 1}</kbd></dd>
                </div>
              ))}
              <div className="kv"><dt>Save note</dt><dd><kbd>Ctrl</kbd> + <kbd>S</kbd></dd></div>
              <div className="kv"><dt>Cancel recording</dt><dd><kbd>Esc</kbd></dd></div>
            </dl>
          </Panel>
        </div>

        <Panel title="Activity log" eyebrow={`Latest ${activity.length}`}>
          {activity.length === 0 ? (
            <Empty title="No activity recorded">Entries arrive from the backend as things happen.</Empty>
          ) : (
            <ol className="timeline">
              {activity.map((a) => (
                <li key={a.id} title={a.details}>
                  <span className="tl-kind">{a.kind}</span>
                  <span>
                    {truncate(a.summary, 140)}
                    {a.details && <span className="sub">{truncate(a.details, 200)}</span>}
                  </span>
                  <time dateTime={a.at}>{fmtDateTime(a.at)}</time>
                </li>
              ))}
            </ol>
          )}
          <Notice>Logs come from the backend and are shown as received.</Notice>
        </Panel>
      </div>
    </div>
  );
}
