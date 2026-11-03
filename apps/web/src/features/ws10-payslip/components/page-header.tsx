// The title block every payslip screen shares: one h1 in the Hangat display
// step and one sentence under it (DESIGN.md §3/§5). The back link belongs to
// the page, because each screen returns to a different place.
export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <header className="grid gap-1">
      <h1 className="font-brand type-display-xl">{title}</h1>
      <p className="text-sm leading-5 text-muted-foreground">{subtitle}</p>
    </header>
  );
}
