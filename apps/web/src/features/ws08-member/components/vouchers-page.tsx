import type { VoucherDto } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMemberVouchers } from "../hooks";
import { ListSkeleton } from "./list-skeleton";
import { MemberPageHeader } from "./page-header";
import { VoucherCard } from "./voucher-card";

type Tab = "active" | "used" | "expired";

function matches(voucher: VoucherDto, tab: Tab): boolean {
  if (tab === "active") return voucher.status === "issued";
  if (tab === "used") return voucher.status === "redeemed";
  return voucher.status === "expired" || voucher.status === "cancelled";
}

// PRD §3.20 "Halaman Member": the member's vouchers, grouped by what they can
// still use. Cancelled vouchers stay visible under "Kedaluwarsa" with their own
// badge, so nothing the member was issued silently disappears.
export function MemberVouchersPage() {
  const t = useT();
  const query = useMemberVouchers();
  const tabs: { value: Tab; label: string; empty: string }[] = [
    {
      value: "active",
      label: t("member.vouchers.tabActive"),
      empty: t("member.vouchers.emptyActive"),
    },
    {
      value: "used",
      label: t("member.vouchers.tabUsed"),
      empty: t("member.vouchers.emptyUsed"),
    },
    {
      value: "expired",
      label: t("member.vouchers.tabExpired"),
      empty: t("member.vouchers.emptyExpired"),
    },
  ];

  return (
    <div className="grid gap-6">
      <MemberPageHeader
        title={t("member.vouchers.title")}
        intro={t("member.vouchers.intro")}
      />

      {query.isPending ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <Tabs defaultValue="active">
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => {
            const vouchers = (query.data?.data ?? []).filter((voucher) =>
              matches(voucher, tab.value),
            );
            return (
              <TabsContent key={tab.value} value={tab.value}>
                {vouchers.length === 0 ? (
                  <EmptyState title={tab.empty} />
                ) : (
                  <div className="grid gap-3">
                    {vouchers.map((voucher) => (
                      <VoucherCard key={voucher.id} voucher={voucher} />
                    ))}
                  </div>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}
