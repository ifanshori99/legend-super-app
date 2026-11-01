import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { cn } from "cn";
import type { MemberPath } from "../paths";

// A titled block on the member overview. "Lihat semua" is the section's one
// link; the section itself is not a card, so cards inside it never nest.
export function MemberSection({
  title,
  viewAllTo,
  children,
  className,
}: {
  title: string;
  viewAllTo?: MemberPath;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <section className={cn("grid gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-brand text-xl leading-7 font-semibold">{title}</h2>
        {viewAllTo && (
          <Link
            to={viewAllTo}
            className="inline-flex min-h-11 shrink-0 items-center text-sm leading-5 font-semibold text-primary underline-offset-4 hover:underline"
          >
            {t("member.overview.viewAll")}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
