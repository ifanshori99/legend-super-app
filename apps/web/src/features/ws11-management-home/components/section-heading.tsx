// Section heading of the management home. The page title lives in the
// ManagementShell topbar (DESIGN.md v3), so a screen section starts at h2 in
// the `type-title` step.
export function SectionHeading({
  id,
  title,
  hint,
}: {
  id: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <h2 id={id} className="type-title">
        {title}
      </h2>
      {hint !== undefined && (
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
