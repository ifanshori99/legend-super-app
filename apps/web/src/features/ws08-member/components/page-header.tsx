import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useT } from "@/components/i18n";

// One page title per member screen: the brand display step stays on the
// customer surfaces (DESIGN.md §3), and every subpage offers the way back to
// the overview in thumb reach.
export function MemberPageHeader({
  title,
  intro,
  back = true,
}: {
  title: string;
  intro?: string;
  back?: boolean;
}) {
  const t = useT();
  return (
    <header className="grid gap-2">
      {back && (
        <Link
          to="/member"
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-control px-2 text-sm leading-5 font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {t("member.signup.backToOverview")}
        </Link>
      )}
      <h1 className="font-brand type-display-xl">{title}</h1>
      {intro && (
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {intro}
        </p>
      )}
    </header>
  );
}
