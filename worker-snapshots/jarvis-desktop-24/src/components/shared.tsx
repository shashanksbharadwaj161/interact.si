import { useState } from 'react';
import { AppWindow, FolderOpen, Plus, Trash } from '@phosphor-icons/react';
import type { Capability, SystemInfo } from '../shared/contracts';
import { Badge, Button, Field, IconButton, KV, LoadingBlock, Notice } from '../ui/primitives';
import { fmtBytesGB } from '../ui/util';
import { useStore } from '../ui/store';

const ABS_WINDOWS = /^([A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/;

/** Editable list of folder roots or approved apps. Nothing is granted until the user adds it and saves. */
export function PathListEditor({ kind, items, onChange, max = 50 }: { kind: 'folder' | 'app'; items: string[]; onChange: (next: string[]) => void; max?: number }) {
  const { api, toast, isPreview } = useStore();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = kind === 'folder' ? 'Allowed folder' : 'Approved app';

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return setError(`Enter or browse for ${kind === 'folder' ? 'a folder path' : 'an application name or path'}.`);
    if (v.length > 260) return setError('That path is too long (260 characters maximum).');
    if (kind === 'folder' && !ABS_WINDOWS.test(v)) return setError('Use a full path such as C:\\Users\\you\\Projects.');
    if (items.some((x) => x.toLowerCase() === v.toLowerCase())) return setError('That entry is already in the list.');
    if (items.length >= max) return setError(`At most ${max} entries are supported.`);
    setError(null);
    onChange([...items, v]);
    setDraft('');
  };

  const browse = async () => {
    try {
      const p = await api.pickPath(kind === 'folder' ? 'folder' : 'file');
      if (p) add(p);
      else if (isPreview) toast('info', 'File pickers are unavailable in browser preview. Type a path instead.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not open the picker.');
    }
  };

  return (
    <div className="pathlist">
      {items.length === 0 ? (
        <p className="field-hint">None added. {kind === 'folder' ? 'No folder is allowed yet.' : 'No app is approved yet.'}</p>
      ) : (
        <ul className="chips-col" aria-label={`${label} list`}>
          {items.map((it) => (
            <li key={it} className="path-item">
              {kind === 'folder' ? <FolderOpen size={16} aria-hidden /> : <AppWindow size={16} aria-hidden />}
              <code title={it}>{it}</code>
              <IconButton icon={Trash} label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
      >
        <Field label={`Add ${label.toLowerCase()}`} error={error} className="grow">
          {(id, d) => (
            <input id={id} aria-describedby={d} className="input" value={draft} maxLength={260} placeholder={kind === 'folder' ? 'C:\\Users\\you\\Projects' : 'notepad.exe or full path'} onChange={(e) => { setDraft(e.target.value); setError(null); }} />
          )}
        </Field>
        <div className="row align-end">
          <Button type="submit" icon={Plus}>
            Add
          </Button>
          <Button icon={FolderOpen} onClick={browse}>
            Browse…
          </Button>
        </div>
      </form>
    </div>
  );
}

export function CapabilityRow({ c }: { c: Capability }) {
  return (
    <li className="cap-row">
      <Badge tone={c.available ? 'ok' : 'warn'}>{c.available ? 'Available' : 'Unavailable'}</Badge>
      <div>
        <strong>{c.name}</strong>
        {c.reason && <p className="field-hint">{c.reason}</p>}
      </div>
    </li>
  );
}

export function SystemFacts({ system }: { system: SystemInfo }) {
  return (
    <dl className="kv-list">
      <KV k="Platform">{system.platform}</KV>
      <KV k="Architecture">{system.arch}</KV>
      <KV k="Memory">{fmtBytesGB(system.ramGB)}</KV>
      <KV k="Processor">{system.cpu || 'unknown'}</KV>
    </dl>
  );
}

export function SystemBlock({ compact = false }: { compact?: boolean }) {
  const { system, systemError, systemLoading, refreshSystem } = useStore();
  if (!system) {
    if (systemLoading) return <LoadingBlock label="Reading system information…" />;
    return (
      <Notice tone="warn" title="System information is unavailable" action={<Button size="sm" onClick={() => void refreshSystem()}>Retry</Button>}>
        {systemError ?? 'The backend did not return system information.'}
      </Notice>
    );
  }
  const avail = system.capabilities.filter((c) => c.available).length;
  return (
    <div className="stack">
      <SystemFacts system={system} />
      <p className="field-hint">
        {avail} of {system.capabilities.length} capabilities reported available by the backend.
      </p>
      {!compact && system.capabilities.length > 0 && <ul className="cap-list">{system.capabilities.map((c) => <CapabilityRow key={c.id} c={c} />)}</ul>}
    </div>
  );
}
