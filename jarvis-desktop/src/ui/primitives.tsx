import { useId, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { CircleNotch, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import { cx } from './util';

type IconType = ComponentType<{ size?: number | string; weight?: 'regular' | 'bold' | 'fill' | 'duotone' | 'light' | 'thin'; className?: string; 'aria-hidden'?: boolean }>;

export function Spinner({ size = 14 }: { size?: number }) {
  return <CircleNotch size={size} className="spin" aria-hidden />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'quiet';
  icon?: IconType;
  busy?: boolean;
  size?: 'sm' | 'md';
};

export function Button({ variant = 'ghost', icon: Icon, busy, size = 'md', className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner /> : Icon ? <Icon size={size === 'sm' ? 14 : 16} aria-hidden /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, size = 16, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconType; label: string; size?: number }) {
  return (
    <button type="button" className={cx('iconbtn', className)} aria-label={label} title={label} {...rest}>
      <Icon size={size} aria-hidden />
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string, describedBy: string | undefined) => ReactNode; className?: string }) {
  const id = useId();
  const dId = hint || error ? `${id}-d` : undefined;
  return (
    <div className={cx('field', className, error && 'has-error')}>
      <label htmlFor={id}>{label}</label>
      {children(id, dId)}
      {(hint || error) && (
        <p id={dId} className={error ? 'field-error' : 'field-hint'} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent';

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Panel({ title, eyebrow, actions, children, className, as: Tag = 'section' }: { title?: string; eyebrow?: string; actions?: ReactNode; children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' }) {
  const id = useId();
  return (
    <Tag className={cx('panel', className)} aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2 id={id}>{title}</h2>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon?: IconType; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <Icon size={26} weight="duotone" aria-hidden />}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'danger'; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'danger' ? WarningCircle : tone === 'warn' ? Warning : Info;
  return (
    <div className={cx('notice', `notice-${tone}`)} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon size={18} weight="duotone" aria-hidden />
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  );
}

/**
 * Labelled on/off control. The button is named by aria-labelledby, pointing at the visible label, so its name does
 * not depend on the <label for> link alone. The description is linked with aria-describedby. Disabled switches keep
 * the same name, so a disabled state is announced with what it applies to.
 */
export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="switch-row">
      <div>
        <label id={labelId} htmlFor={id} className="switch-label">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="field-hint">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        className={cx('switch', checked && 'on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" aria-hidden />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: IconType; hint?: string }[]; label: string }) {
  // Roving tabindex. When `value` matches no option (stale or unset), the first option stays tabbable so the group is
  // still reachable with Tab; arrow keys move relative to the option that has focus, not to `value`.
  const selected = options.findIndex((o) => o.value === value);
  const tabbable = selected >= 0 ? selected : 0;
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o, index) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={index === tabbable ? 0 : -1}
          className={cx('seg', value === o.value && 'on')}
          title={o.hint}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            const jump = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : -1;
            if (!step && jump < 0) return;
            e.preventDefault();
            const next = jump >= 0 ? options[jump] : options[(index + step + options.length) % options.length];
            onChange(next.value);
            const btns = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=radio]');
            btns?.[options.indexOf(next)]?.focus();
          }}
        >
          {o.icon && <o.icon size={14} aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
