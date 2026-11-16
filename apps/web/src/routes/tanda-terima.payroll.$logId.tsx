import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { DisownPage } from "@/features/ws10-payroll-payout/components/disown-page";
import { SESSION_GUARD } from "@/lib/areas/definitions";
import { runGuard } from "@/lib/areas/route";

// "/tanda-terima/payroll/:logId" — the page a payout step receipt links to,
// with the "Bukan saya" button (legend-l2zru). Outside every area on purpose:
// the kelola area needs dashboard.management.view, and an approver whose access
// an attacker removed must still be able to freeze the batch. Any signed-in
// session may open it; the API answers 404 for a step that is not on the
// caller's login and checks the password and account status itself.
const t = createTranslator();

export const Route = createFileRoute("/tanda-terima/payroll/$logId")({
  beforeLoad: ({ context }) => runGuard(SESSION_GUARD, context.access),
  headers: () => ({ "Cache-Control": "private, no-store" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("payrollPayoutReceipt.disown.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: DisownRoute,
});

function DisownRoute() {
  const { logId } = Route.useParams();
  return (
    <main className="mx-auto grid w-full max-w-2xl gap-4 p-4 min-[700px]:p-8">
      <DisownPage logId={logId} />
    </main>
  );
}
