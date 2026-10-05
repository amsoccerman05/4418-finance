import type { ReactNode } from 'react';

/** Shared page framing; the supplied actions retain their existing permissions. */
export function FinancePageHeader({ title, description, badge, children }: {
  title: string;
  description: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading finance-page-heading">
      <div className="finance-page-copy">
        <span className="eyebrow">TEAM 4418 / FINANCE</span>
        <div className="finance-title-line"><h1>{title}</h1>{badge}</div>
        <p>{description}</p>
      </div>
      {children && <div className="finance-page-actions">{children}</div>}
    </header>
  );
}
