import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { useMemberOverview } from "../hooks";
import { ConsentForm } from "./consent-form";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";

// PRD §3.20 "Pendaftaran Member": membership becomes active after a verified
// WhatsApp number and the loyalty consent; marketing and AI consents are
// separate and optional (§2 "Persetujuan terpisah dan berversi").
export function MemberSignupPage() {
  const t = useT();
  const query = useMemberOverview();
  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.signup.title")}
        intro={t("member.signup.intro")}
      />
      {query.isPending ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ConsentForm overview={query.data} />
      )}
    </div>
  );
}
