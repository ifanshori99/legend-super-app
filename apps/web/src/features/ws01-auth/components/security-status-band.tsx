import { Link } from "@tanstack/react-router";
import { CircleCheck, Info, ShieldAlert, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "../format";
import type { SecondFactorState } from "../state";

/**
 * AUTH-05 at the top of the security page: is this session allowed into the
 * back office, and what does the user do when it is not? A band, not a card:
 * it is a status line above the real content.
 */
export function SecurityStatusBand({
  state,
  verifiedAt,
  returnTo,
}: {
  state: SecondFactorState;
  /** When this session passed the second factor, if it did. */
  verifiedAt: string | null;
  /** Where to come back to after verifying. */
  returnTo: string;
}) {
  const t = useT();
  const blocked = state.blocked;
  const Icon = blocked ? ShieldAlert : state.required ? ShieldCheck : Info;
  const tone = blocked
    ? "border-warning bg-warning-subtle text-warning"
    : state.required
      ? "border-success bg-success-subtle text-success"
      : "border-border bg-surface-2 text-muted-foreground";

  return (
    <section
      aria-labelledby="security-status-title"
      className={`flex flex-col gap-3 rounded-container border-(length:--border-w) p-card shadow-hairline sm:flex-row sm:items-start ${tone}`}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-card">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <h2 id="security-status-title" className="type-heading text-foreground">
          {blocked
            ? t("staffAuth.status.requiredTitle")
            : state.required
              ? t("staffAuth.status.verifiedTitle")
              : t("staffAuth.mfa.title")}
        </h2>
        <p className="text-sm leading-5 text-foreground">
          {blocked
            ? t("staffAuth.status.requiredHint")
            : state.required && verifiedAt
              ? t("staffAuth.status.verifiedHint", {
                  time: formatDateTime(verifiedAt),
                })
              : t("staffAuth.status.optionalHint")}
        </p>
      </div>
      {blocked && (
        <Button asChild className="shrink-0 sm:self-center">
          <Link to="/verifikasi" search={{ returnTo }}>
            <ShieldCheck aria-hidden="true" />
            {t("staffAuth.status.verifyNow")}
          </Link>
        </Button>
      )}
      {!blocked && state.required && (
        <span className="hidden shrink-0 items-center gap-1 self-center text-sm font-semibold sm:flex">
          <CircleCheck className="size-4" aria-hidden="true" />
          {t("staffAuth.sessions.statusActive")}
        </span>
      )}
    </section>
  );
}
