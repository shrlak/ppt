import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  /** Action buttons rendered on the right side. */
  actions?: ReactNode;
}

export default function PageHeader({ title, description, actions }: Props) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-none gap-2">{actions}</div>}
    </div>
  );
}
