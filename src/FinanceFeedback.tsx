import { CheckCircle2, AlertCircle, LoaderCircle, X } from 'lucide-react';

/** One visible live message, placed in the dialog when one is open. */
export function FinanceFeedback({ busy, pending, error, message, onDismiss }: {
  busy: boolean;
  pending: string;
  error: string;
  message: string;
  onDismiss: () => void;
}) {
  if (!busy && !error && !message) return null;
  const Icon = busy ? LoaderCircle : error ? AlertCircle : CheckCircle2;
  return (
    <div className={`finance-feedback ${busy ? 'is-pending' : error ? 'is-error' : 'is-success'}`}>
      <div role={error && !busy ? 'alert' : 'status'} aria-atomic="true">
        <Icon size={19} aria-hidden="true" />
        <span>{busy ? pending : error || message}</span>
      </div>
      {!busy && <button type="button" className="feedback-dismiss" aria-label="Dismiss update" onClick={onDismiss}><X size={17} aria-hidden="true" /></button>}
    </div>
  );
}
