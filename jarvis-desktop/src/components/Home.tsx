import { useMemo } from 'react';
import { ArrowRight, ChatCircleDots, Cube, Note as NoteIcon, Plus, WarningCircle } from '@phosphor-icons/react';
import { Avatar } from './Avatar';
import { Badge, Button, Empty, Notice, PageHeader, Panel } from '../ui/primitives';
import { useCompanion } from '../ui/companion';
import { useReady } from '../ui/store';
import type { ViewId } from '../ui/nav';
import { dueBucket, dueKey, fmtDueKey, relTime, truncate } from '../ui/util';
import { sceneName } from '../ui/scenes';

export function Home({ go }: { go: (v: ViewId) => void }) {
  const { state, settings, system, systemError, cloudConfigured, api, mutate } = useReady();
  const { state: avatarState } = useCompanion();

  const open = useMemo(() => state.tasks.filter((t) => !t.done), [state.tasks]);
  const urgent = useMemo(
    () =>
      open
        .filter((t) => ['overdue', 'today'].includes(dueBucket(t)))
        .sort((a, b) => (dueKey(a) ?? '').localeCompare(dueKey(b) ?? ''))
        .slice(0, 6),
    [open],
  );
  const overdue = open.filter((t) => dueBucket(t) === 'overdue').length;
  const capsules = useMemo(() => [...state.capsules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4), [state.capsules]);
  const notes = useMemo(() => [...state.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4), [state.notes]);
  const activity = useMemo(() => [...state.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8), [state.activity]);
  const lastChat = state.chat[state.chat.length - 1];
  const unavailable = system?.capabilities.filter((c) => !c.available) ?? [];
  const online = settings.mode === 'online';
  const modelReady = online ? Boolean(settings.cloudModel) && cloudConfigured === true : Boolean(settings.localModel && settings.localEndpoint);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Cockpit"
        title="Home"
        subtitle="What is saved on this computer right now."
        actions={
          <>
            <Button icon={ChatCircleDots} variant="primary" onClick={() => go('assistant')}>
              Ask the assistant
            </Button>
            <Button icon={Plus} onClick={() => go('notes')}>
              New note
            </Button>
          </>
        }
      />

      <section className="stat-row" aria-label="Totals">
        <button className="stat" onClick={() => go('capsules')}>
          <span className="stat-n">{state.capsules.length}</span>
          <span className="stat-l">Capsules</span>
        </button>
        <button className="stat" onClick={() => go('notes')}>
          <span className="stat-n">{state.notes.length}</span>
          <span className="stat-l">Notes</span>
        </button>
        <button className={`stat ${overdue ? 'warn' : ''}`} onClick={() => go('tasks')}>
          <span className="stat-n">{open.length}</span>
          <span className="stat-l">Open tasks{overdue ? ` · ${overdue} overdue` : ''}</span>
        </button>
        <button className="stat" onClick={() => go('assistant')}>
          <span className="stat-n">{state.chat.length}</span>
          <span className="stat-l">Chat messages</span>
        </button>
      </section>

      {!modelReady && (
        <Notice tone="warn" title={online ? 'Online mode is not fully configured' : 'No local model configured'} action={<Button size="sm" onClick={() => go('settings')}>Open Settings</Button>}>
          {online
            ? cloudConfigured === false
              ? 'Add your cloud API key and model name. Chat will not fall back to a local model.'
              : 'Set a cloud model name and confirm the key status in Settings.'
            : 'Set the model endpoint and name in Settings. Chat will report an error until a local model is reachable.'}
        </Notice>
      )}

      <div className="home-grid">
        <div className="stack">
          <Panel title="Due now" eyebrow="Tasks" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('tasks')}>All tasks</Button>}>
            {urgent.length === 0 ? (
              <Empty title={open.length ? 'Nothing due today' : 'No open tasks'}>{open.length ? `${open.length} open task${open.length === 1 ? '' : 's'} without an earlier date.` : 'Add tasks with due dates and they will show up here.'}</Empty>
            ) : (
              <ul className="list">
                {urgent.map((t) => {
                  const b = dueBucket(t);
                  return (
                    <li key={t.id} className="list-row">
                      <input type="checkbox" className="check" aria-label={`Mark “${t.title}” done`} checked={t.done} onChange={() => void mutate(() => api.saveTask({ id: t.id, done: true }))} />
                      <span className="grow">{t.title}</span>
                      <Badge tone={b === 'overdue' ? 'danger' : 'warn'}>{b === 'overdue' ? `Overdue ${fmtDueKey(dueKey(t) ?? '')}` : 'Today'}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Recent capsules" eyebrow="Workspaces" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('capsules')}>Open</Button>}>
            {capsules.length === 0 ? (
              <Empty icon={Cube} title="No capsules yet">A capsule bundles files, folders, apps and URLs for one project so you can reopen them together.</Empty>
            ) : (
              <ul className="list">
                {capsules.map((c) => (
                  <li key={c.id} className="list-row">
                    <Cube size={16} aria-hidden />
                    <span className="grow">
                      <strong>{c.name}</strong>
                      <span className="sub">
                        {c.items.length} item{c.items.length === 1 ? '' : 's'} · {sceneName(c.scene)} · {relTime(c.updatedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Recent notes" eyebrow="Memory" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('notes')}>Open</Button>}>
            {notes.length === 0 ? (
              <Empty icon={NoteIcon} title="No notes yet">Notes are stored on this computer and searchable by text and tag.</Empty>
            ) : (
              <ul className="list">
                {notes.map((n) => (
                  <li key={n.id} className="list-row">
                    <span className="grow">
                      <strong>{n.title || 'Untitled'}</strong>
                      <span className="sub">{truncate(n.body.replace(/\s+/g, ' '), 90) || 'Empty note'}</span>
                    </span>
                    <span className="sub">{relTime(n.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Companion" eyebrow="Live state" className="panel-companion">
            <div className="companion-mini">
              <Avatar state={avatarState} size={120} />
              <div className="stack tight">
                <Badge tone={online ? 'warn' : 'ok'}>{online ? 'Online mode' : 'Offline mode'}</Badge>
                <p className="field-hint">
                  {online ? `Cloud model: ${settings.cloudModel || 'not set'}. Key ${cloudConfigured ? 'saved' : cloudConfigured === false ? 'missing' : 'status unknown'}.` : `Local model: ${settings.localModel || 'not set'}.`}
                </p>
                {lastChat && (
                  <p className="quote">
                    <span className="sub">Last message · {lastChat.role} · {relTime(lastChat.createdAt)}</span>
                    {truncate(lastChat.text, 140)}
                  </p>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Capabilities" eyebrow="Reported by backend" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('status')}>Details</Button>}>
            {systemError && <Notice tone="warn" title="Unavailable">{systemError}</Notice>}
            {system && (
              <>
                <p className="big-line">
                  {system.capabilities.filter((c) => c.available).length}
                  <span> of {system.capabilities.length} available</span>
                </p>
                {unavailable.length > 0 && (
                  <ul className="list compact">
                    {unavailable.slice(0, 4).map((c) => (
                      <li key={c.id} className="list-row">
                        <WarningCircle size={15} aria-hidden />
                        <span className="grow">
                          {c.name}
                          {c.reason && <span className="sub">{truncate(c.reason, 90)}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Panel>

          <Panel title="Recent activity" eyebrow="Audit trail">
            {activity.length === 0 ? (
              <Empty title="No activity recorded">Writes and approved actions appear here as they happen.</Empty>
            ) : (
              <ol className="timeline">
                {activity.map((a) => (
                  <li key={a.id}>
                    <span className="tl-kind">{a.kind}</span>
                    <span>{truncate(a.summary, 120)}</span>
                    <time dateTime={a.at}>{relTime(a.at)}</time>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
