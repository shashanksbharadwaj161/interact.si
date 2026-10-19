import {forwardRef, useEffect, useRef, type CSSProperties, type ReactNode} from 'react';
import type {AgentEvent, Appearance, CompanionStatus, Dock, DockTarget, RegionEvent, TypingTarget} from './api';

/*
 * The companion bubble's surfaces: command, working, answer and error. Shared by the desktop companion window and the
 * direction board, so the board shows the exact production components. Pure presentation: every value shown comes
 * from props the caller received from the main process (or, on the board, from clearly labelled sample data).
 * Styles: src/styles/companion-bubble.css (everything under `.cd`).
 */

export type ToolStep = Extract<AgentEvent, {type: 'tool'}>;
export type Answer = Extract<AgentEvent, {type: 'answer'}>;
export type Failure = Extract<AgentEvent, {type: 'error'}>;
export type HubView = 'home' | 'assistant' | 'notes' | 'tasks' | 'capsules' | 'search' | 'companion' | 'settings';

export type BubbleEdge = 'idle' | 'working' | 'waiting' | 'done' | 'error';
export type BubbleSide = 'left' | 'right' | 'above' | 'below' | 'none';

/**
 * The speech bubble shell: smoked glass, a tail pointing at the character (`side` is where the bubble sits relative to
 * it) and one perimeter light whose state must come from real events (`edge`). `edgeKey` restarts the one-shot sweep.
 */
export const Bubble = forwardRef<HTMLElement, {surface: string; side: BubbleSide; edge: BubbleEdge; edgeKey?: string | number; label: string; style?: CSSProperties; measuring?: boolean; leaving?: boolean; children: ReactNode}>(function Bubble(p, ref) {
  return (
    <section ref={ref} className="bubble cd" data-surface={p.surface} data-side={p.side} data-edge={p.edge} data-measuring={p.measuring || undefined} data-leaving={p.leaving || undefined} style={p.style} aria-label={p.label}>
      <span className="cd-edge" aria-hidden key={p.edge === 'done' ? `done-${p.edgeKey ?? ''}` : p.edge} />
      <div className="bubble-body">{p.children}</div>
    </section>
  );
});

export function Head({title, meta, children}: {title: string; meta?: ReactNode; children?: ReactNode}) {
  return (
    <header className="b-head">
      <div className="b-title">
        <strong>{title}</strong>
        {meta && <span className="b-meta">{meta}</span>}
      </div>
      {children && <div className="b-tools">{children}</div>}
    </header>
  );
}

export function Foot({children}: {children: ReactNode}) {
  return <footer className="b-foot">{children}</footer>;
}

const DOCKS: {id: DockTarget; label: string}[] = [
  {id: 'bottom-left', label: 'Bottom left'},
  {id: 'bottom-right', label: 'Bottom right'},
  {id: 'left', label: 'Left'},
  {id: 'right', label: 'Right'},
  {id: 'top', label: 'Top'},
];
const SIZES: {id: 'S' | 'M' | 'L'; px: number}[] = [{id: 'S', px: 64}, {id: 'M', px: 96}, {id: 'L', px: 128}];

/** Keyboard-reachable alternatives to dragging: where the character stands, how big it is, and how it looks. */
export function PlacementOptions(p: {size: number; dock: Dock; appearance: Appearance; onDock: (d: DockTarget) => void; onResize: (s: 'S' | 'M' | 'L') => void; onAppearance: (a: Appearance) => void}) {
  return (
    <div className="opts" role="group" aria-label="Position, size and look">
      <div className="opts-row">
        <span>Move to</span>
        {DOCKS.map((d) => (
          <button key={d.id} type="button" className="chipbtn" onClick={() => p.onDock(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="opts-row">
        <span>Size</span>
        <span className="seg">
          {SIZES.map((s) => (
            <button key={s.id} type="button" aria-pressed={p.size === s.px} onClick={() => p.onResize(s.id)} title={`${s.px} px tall`}>
              {s.id}
            </button>
          ))}
        </span>
        <span>Ctrl + scroll over the character for finer steps</span>
      </div>
      <div className="opts-row">
        <span>Look</span>
        <span className="seg">
          <button type="button" aria-pressed={p.appearance === 'pet'} onClick={() => p.onAppearance('pet')}>
            Character
          </button>
          <button type="button" aria-pressed={p.appearance === 'legacy-orb'} onClick={() => p.onAppearance('legacy-orb')}>
            Legacy orb
          </button>
        </span>
      </div>
    </div>
  );
}

export function Command(p: {
  status: CompanionStatus | null;
  text: string;
  setText: (t: string) => void;
  region: RegionEvent | null;
  note: string | null;
  options: ReactNode;
  showOptions: boolean;
  onToggleOptions: () => void;
  onAsk: () => void;
  /** Explicit reviewed input without a model call. Available offline when an app is attached. */
  onInsert?: () => void;
  inputBusy?: boolean;
  onRegion: () => void;
  onRemoveRegion: () => void;
  onHub: (view: HubView) => void;
  onClose: () => void;
  /** The app window the person was using, remembered when they opened the bubble; typing may go only there. */
  target?: TypingTarget | null;
  onClearTarget?: () => void;
  autoFocus?: boolean;
  /** Live voice state (src/voice VoiceBar, compact) shown above the message field while listening or transcribing. */
  voice?: ReactNode;
  /** The Talk button (src/voice TalkButton), placed next to Ask. */
  talk?: ReactNode;
  /** Opens the utility tray. Shown as a labelled button; `utilitiesShortcut` is announced and handled by the caller. */
  onUtilities?: () => void;
  utilitiesShortcut?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p.autoFocus !== false) input.current?.focus();
  }, [p.autoFocus]);
  const readiness = p.status?.readiness;
  const ready = readiness?.ready === true;
  return (
    <div className="cmd">
      <Head title="What can I do for you?" meta={ready ? `Claude · ${readiness.model}` : 'Claude is not connected yet'}>
        {p.onUtilities && (
          <button type="button" className="chipbtn" onClick={p.onUtilities} aria-keyshortcuts={p.utilitiesShortcut} title={p.utilitiesShortcut ? `Tasks, notes, routines and apps (${p.utilitiesShortcut})` : 'Tasks, notes, routines and apps'}>
            Utilities
          </button>
        )}
        <button type="button" className="ibtn" onClick={p.onToggleOptions} aria-expanded={p.showOptions} aria-label="Position, size and look" title="Position, size and look">
          <span aria-hidden>⋯</span>
        </button>
        <button type="button" className="ibtn" onClick={() => p.onHub('home')} aria-label="Open the full hub" title="Open the full hub">
          <span aria-hidden>⤢</span>
        </button>
        <button type="button" className="ibtn" onClick={p.onClose} aria-label="Close (Esc)" title="Close (Esc)">
          <span aria-hidden>✕</span>
        </button>
      </Head>
      {p.showOptions && p.options}
      {readiness && !readiness.ready && (
        <div className="cmd-setup" role="status">
          <p>{readiness.reason}</p>
          <button type="button" className="btn btn-sm" onClick={() => p.onHub('settings')}>
            Open Settings
          </button>
        </div>
      )}
      {p.voice}
      <form
        className="cmd-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !p.inputBusy && p.text.trim()) p.onAsk();
        }}
      >
        <label htmlFor="cmp-input" className="sr-only">
          Ask or tell the companion
        </label>
        <textarea
          id="cmp-input"
          ref={input}
          className="cmd-input"
          rows={1}
          maxLength={2000}
          value={p.text}
          onChange={(e) => p.setText(e.target.value)}
          onKeyDown={(e) => {
            if (ready && !p.inputBusy && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              p.onAsk();
            }
          }}
          placeholder={p.region ? 'Ask about the area you picked' : 'Ask, or tell me what to do'}
          disabled={p.inputBusy}
        />
        {p.talk}
        <button type="submit" className="btn btn-primary" disabled={!ready || !p.text.trim()}>
          Ask
        </button>
      </form>
      {p.target && p.onInsert && <div className="cmd-direct">
        <button type="button" className="chipbtn" disabled={!p.text.trim() || p.inputBusy} onClick={p.onInsert}>Type into {p.target.process.replace(/\.exe$/i, '')}</button>
        <span className="b-meta">Review the exact text in Windows first. No AI request.</span>
      </div>}
      {p.note && (
        <p className="cmd-note" role="status">
          {p.note}
        </p>
      )}
      <div className="ctx">
        {p.region ? (
          <div className="ctx-chip">
            <img className="ctx-img" src={p.region.preview} alt="The screen area you picked" />
            <span className="grow">
              <strong>Screen area attached</strong>
              <span>
                {p.region.width}×{p.region.height} px. Sent with this request only, then forgotten.
              </span>
            </span>
            <button type="button" className="linkbtn" onClick={p.onRemoveRegion}>
              Remove
            </button>
          </div>
        ) : (
          <div className="ctx-empty">
            <span>Nothing from your screen is attached.</span>
            <button type="button" className="chipbtn" onClick={p.onRegion} disabled={!ready}>
              Pick an area
            </button>
          </div>
        )}
        {p.target && (
          <div className="ctx-chip">
            <span className="grow">
              <strong>Typing goes to {p.target.process.replace(/\.exe$/i, '')}</strong>
              <span>“{p.target.title || 'Untitled window'}”: its name is sent with your request, and nothing is typed without your Windows confirmation.</span>
            </span>
            {p.onClearTarget && (
              <button type="button" className="linkbtn" onClick={p.onClearTarget}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      <Foot>
        <span className="b-meta">
          {ready ? `Sends your request${p.region ? ', the picked area' : ''}${p.target ? ', the window name' : ''} to Anthropic with your key.` : 'Notes, tasks and search work in the hub without a key.'}{' '}
          {p.status?.shortcut && (
            <>
              <kbd>{p.status.shortcut.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ')}</kbd> opens and closes me.
            </>
          )}
        </span>
      </Foot>
    </div>
  );
}

const PHASE_WORD: Record<ToolStep['phase'], string> = {running: 'Working', 'awaiting-confirm': 'Needs your answer', done: 'Done', declined: 'Not done', failed: 'Did not work'};
const stepWord = (s: ToolStep) => (s.phase === 'running' && s.stage === 'verifying' ? 'Checking' : PHASE_WORD[s.phase]);

export function StepList({steps}: {steps: ToolStep[]}) {
  if (!steps.length) return null;
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.callId} className={`is-${s.phase}`}>
          <span className="step-word">{stepWord(s)}</span> {s.summary}
          {s.phase === 'done' && s.verified && <span className="tag-ok">checked</span>}
        </li>
      ))}
    </ol>
  );
}

export function Working({pending, steps, hasRun, onStop, autoFocus}: {pending: 'sending' | 'thinking' | null; steps: ToolStep[]; hasRun: boolean; onStop: () => void; autoFocus?: boolean}) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus !== false) stop.current?.focus();
  }, [autoFocus]);
  const waiting = steps.some((s) => s.phase === 'awaiting-confirm');
  return (
    <div className="work">
      <Head
        title={waiting ? 'Waiting for your answer' : 'On it'}
        meta={waiting ? 'Answer the Windows confirmation. Cancel is the default.' : pending === 'sending' ? 'Sending your request to Claude' : pending === 'thinking' ? 'Claude is working out the next step' : 'Running a step'}
      />
      <StepList steps={steps} />
      <Foot>
        <span className="b-meta">Esc stops. Anything already confirmed stays done.</span>
        <button type="button" className="stop" ref={stop} onClick={onStop} disabled={!hasRun && !pending}>
          Stop
        </button>
      </Foot>
    </div>
  );
}

/**
 * The island's working view: the real named operation (sending, waiting for Claude's next step, a named tool, checking a
 * result) from src/companion/island/state.ts workLine, the steps so far, and Stop. No percentages, no reasoning text.
 */
export function WorkView({line, steps, onStop, autoFocus}: {line: {title: string; detail: string}; steps: ToolStep[]; onStop: () => void; autoFocus?: boolean}) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus !== false) stop.current?.focus();
  }, [autoFocus]);
  return (
    <div className="work" aria-busy="true">
      <Head title={line.title} meta={line.detail} />
      <StepList steps={steps} />
      <Foot>
        <span className="b-meta">Esc or Stop ends the request. Anything already confirmed stays done.</span>
        <button type="button" className="stop" ref={stop} onClick={onStop}>
          Stop
        </button>
      </Foot>
    </div>
  );
}

/**
 * While a Windows confirmation is open: what exactly is being asked, for which window. This panel cannot approve
 * anything; only the native dialog can, and Cancel is its default. Stop ends the request and closes that dialog.
 */
export function ConfirmView({step, target, steps, onStop, autoFocus}: {step: ToolStep | null; target?: TypingTarget | null; steps: ToolStep[]; onStop: () => void; autoFocus?: boolean}) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus !== false) stop.current?.focus();
  }, [autoFocus]);
  return (
    <div className="work conf">
      <Head title="Answer in the Windows confirmation" meta="Approve or cancel there. Cancel is the default; this panel cannot approve it." />
      <div className="conf-what" role="status">
        <span className="conf-label">{step?.label ?? 'A step'}</span>
        <span>{step?.summary ?? 'Waiting for your answer.'}</span>
        {target && <span className="b-meta">Window: {target.process.replace(/\.exe$/i, '')} · “{target.title || 'Untitled window'}”</span>}
      </div>
      <StepList steps={steps.filter((s) => s !== step && s.phase !== 'awaiting-confirm')} />
      <Foot>
        <span className="b-meta">Stop ends the request and closes the confirmation as Cancel.</span>
        <button type="button" className="stop" ref={stop} onClick={onStop}>
          Stop
        </button>
      </Foot>
    </div>
  );
}

const CITE_RE = /\[(note|task|capsule):([A-Za-z0-9_-]{1,64})\]/g;
const KIND_WORD = {note: 'Note', task: 'Task', capsule: 'Capsule'} as const;

/**
 * What the companion changed. A change it could check comes with Undo; one it could not check (typing into another
 * app: Windows accepted the keys, the app was not read back) says so and offers no undo it cannot keep.
 */
export function Receipts({steps, undone, onUndo}: {steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void}) {
  const changes = steps.filter((s) => s.undo || (s.phase === 'done' && s.verified === false));
  if (!changes.length) return null;
  return (
    <ul className="receipts" aria-label="What changed">
      {changes.map((s) => (
        <li key={s.callId} className={s.undo ? undefined : 'is-unverified'}>
          <span className="grow">{s.summary}</span>
          {!s.undo ? (
            <span className="tag-warn">no undo</span>
          ) : undone[s.undo.id] === 'done' ? (
            <span className="tag-ok">undone</span>
          ) : undone[s.undo.id] === 'failed' ? (
            <span className="tag-warn">could not undo</span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => onUndo(s.undo!.id)}>
              Undo
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AnswerView(p: {answer: Answer; steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void; onOpen: (kind: 'note' | 'task' | 'capsule', id: string) => void; onFollow: () => void; onDone: () => void; autoFocus?: boolean}) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.autoFocus !== false) done.current?.focus();
  }, [p.autoFocus]);
  const plain = p.answer.text.replace(CITE_RE, '').replace(/[ \t]+([.,;:!?])/g, '$1').trim();
  return (
    <div className="ans">
      <Head title={p.answer.steps === 0 ? 'Action result' : 'Answer'} meta={p.answer.steps === 0 ? 'On this computer · no AI request' : `Claude · ${p.answer.steps} step${p.answer.steps === 1 ? '' : 's'}`} />
      <p className="ans-text">{plain}</p>
      {p.answer.citations.length > 0 && (
        <div className="cites" aria-label="Saved items used">
          {p.answer.citations.map((c) => (
            <button key={`${c.kind}:${c.id}`} type="button" className="cite" onClick={() => p.onOpen(c.kind, c.id)}>
              <span className="cite-kind">{KIND_WORD[c.kind]}</span> · {c.title.slice(0, 48)}
            </button>
          ))}
        </div>
      )}
      {/* What did not happen is shown as plainly as what did. */}
      <StepList steps={p.steps.filter((s) => s.phase === 'declined' || s.phase === 'failed')} />
      <Receipts steps={p.steps} undone={p.undone} onUndo={p.onUndo} />
      <Foot>
        <button type="button" className="btn" onClick={p.onFollow}>
          Follow up
        </button>
        <button type="button" className="btn btn-primary" ref={done} onClick={p.onDone}>
          Done
        </button>
      </Foot>
    </div>
  );
}

const FAILURE_TITLE: Record<Failure['reason'], string> = {
  setup: 'Not set up yet',
  cancelled: 'Stopped',
  refused: 'Claude declined this',
  truncated: 'The reply was cut off',
  steps: 'Stopped after too many steps',
  provider: 'Claude could not answer',
  network: 'Could not reach Claude',
};

const KIND_TITLE: Record<NonNullable<Failure['kind']>, string> = {
  offline: 'Online mode is off',
  limit: 'Claude is busy or rate limited',
  key: 'Your API key was not accepted',
};

/** What went wrong, in plain words, with the request kept for Try again. Offline, limits and an unreachable network differ. */
export function ErrorView(p: {failure: Failure; steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void; onRetry: () => void; onSettings: () => void; onDone: () => void; draft?: string | null; onBack?: () => void; autoFocus?: boolean}) {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.autoFocus) retry.current?.focus();
  }, [p.autoFocus]);
  return (
    <div className="ans is-error">
      <Head title={p.failure.kind ? KIND_TITLE[p.failure.kind] : FAILURE_TITLE[p.failure.reason]} />
      <p className="ans-text" role="alert">
        {p.failure.message}
      </p>
      {p.draft && <p className="b-meta err-draft">Your request is kept: “{p.draft.length > 120 ? `${p.draft.slice(0, 120)}…` : p.draft}”</p>}
      <StepList steps={p.steps} />
      <Receipts steps={p.steps} undone={p.undone} onUndo={p.onUndo} />
      <Foot>
        {p.onBack && (
          <button type="button" className="btn" onClick={p.onBack}>
            Edit request
          </button>
        )}
        {(p.failure.reason === 'setup' || p.failure.kind === 'offline' || p.failure.kind === 'key') && (
          <button type="button" className="btn" onClick={p.onSettings}>
            Open Settings
          </button>
        )}
        <button type="button" className="btn" ref={retry} onClick={p.onRetry}>
          {p.failure.reason === 'cancelled' ? 'Ask again' : 'Try again'}
        </button>
        <button type="button" className="btn btn-primary" onClick={p.onDone}>
          Done
        </button>
      </Foot>
    </div>
  );
}
