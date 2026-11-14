import { Link, useLocation } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { memberReturnPath } from "@/features/ws01-login/flow";
import type { WhatsAppLinkState } from "../hooks";

// Invitation to link a WhatsApp number on the member screens (legend-vnvg,
// PRD §3 F3 "Penautan WhatsApp"; the flow itself is /masuk/hubungkan, AUTH-07).
// It shows only while the number is not verified: checking keeps the slot with
// a skeleton so the page does not jump, a failed check says so with a retry,
// and a linked member sees nothing.
export function WhatsAppLinkPrompt({ state }: { state: WhatsAppLinkState }) {
  const t = useT();
  // The link screen sends the member back to the screen they started from.
  const lanjut = memberReturnPath(useLocation().pathname);

  if (state.status === "linked") return null;

  if (state.status === "checking")
    return (
      <Card role="status" aria-busy="true" className="gap-3">
        <span className="sr-only">{t("member.whatsapp.loading")}</span>
        <Skeleton className="h-6 w-2/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-control-lg w-full" />
      </Card>
    );

  if (state.status === "error")
    return (
      <ErrorState
        title={t("member.whatsapp.errorTitle")}
        description={t("member.whatsapp.errorHint")}
        onRetry={state.retry}
      />
    );

  return (
    <Card
      role="region"
      aria-labelledby="member-whatsapp-title"
      data-testid="member-whatsapp-prompt"
      className="gap-3"
    >
      <p className="type-eyebrow text-muted-foreground">
        {t("member.whatsapp.eyebrow")}
      </p>
      <h2 id="member-whatsapp-title" className="font-brand type-title">
        {t("member.whatsapp.title")}
      </h2>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("member.whatsapp.body")}
      </p>
      <Button asChild size="lg" className="w-full">
        <Link to="/masuk/hubungkan" search={{ lanjut }}>
          {t("member.whatsapp.action")}
        </Link>
      </Button>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("member.whatsapp.hint")}
      </p>
    </Card>
  );
}
