interface Props {
  icon: string;
  title: string;
  message: string;
  /** Phase in which this feature becomes functional. */
  phase?: number;
}

export default function EmptyState({ icon, title, message, phase }: Props) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-8 py-16 text-center">
      <div className="text-4xl">{icon}</div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{message}</p>
      {phase !== undefined && (
        <span className="mt-4 inline-block rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
          Coming in Phase {phase}
        </span>
      )}
    </div>
  );
}
