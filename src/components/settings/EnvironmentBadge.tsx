import { ShieldAlert } from 'lucide-react';
import { environmentMeta, type EnvironmentId } from '../../types/settings';
import './environment.css';

/**
 * The environment marker. It always carries its written label, so the colour is a
 * reinforcement and never the signal on its own — a reader who cannot separate the
 * hues still gets the same information.
 */
export function EnvironmentBadge({
  environment,
  size = 'normal',
}: {
  environment: EnvironmentId;
  size?: 'normal' | 'small';
}) {
  const meta = environmentMeta(environment);
  if (meta.id === 'unset') return null;

  return (
    <span className={`env-badge env-badge-${meta.id}${size === 'small' ? ' is-small' : ''}`}>
      {meta.id === 'production' && <ShieldAlert size={size === 'small' ? 11 : 12} aria-hidden />}
      {size === 'small' ? meta.short : meta.label}
    </span>
  );
}

/** A hairline stripe across the top of the shell, so the environment is visible
 *  on every screen without occupying layout space. */
export function EnvironmentStripe({ environment }: { environment: EnvironmentId }) {
  if (environment === 'unset') return null;
  return <div className={`env-stripe env-stripe-${environment}`} role="presentation" />;
}
