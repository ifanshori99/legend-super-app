import type { ReactNode } from "react";
import { QrCode } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type {
  MemberOpenBill,
  MemberPointsQuote,
  MemberPointsRefusal,
} from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { BillCard } from "./bill-card";
import {
  BigAmount,
  Eyebrow,
  FlowGrid,
  Note,
  Panel,
  PanelTitle,
  SummaryBox,
  SummaryRow,
} from "./flow-parts";

// The screens that show the bill and the balance: no bill linked, several
// bills to pick from, one active bill, and the screen after a redemption.
// Presentational: the page owns the data, the step machine, and every callback.

export function OpenBillView({
  bills,
  selectedOrderId,
  quote,
  balancePoints,
  pointValueIdr,
  memberName,
  onSelect,
  onChoosePoints,
  onShowMemberQr,
  onRefresh,
  refreshing,
}: {
  bills: MemberOpenBill[];
  selectedOrderId: string | null;
  quote?: MemberPointsQuote | null;
  balancePoints?: number;
  pointValueIdr?: number;
  memberName?: string;
  onSelect: (orderId: string) => void;
  onChoosePoints: () => void;
  onShowMemberQr: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const balance = quote?.balancePoints ?? balancePoints;
  const rate = quote?.pointValueIdr ?? pointValueIdr;

  // Several bills and none chosen yet: never pick one for the member.
  const bill =
    bills.length === 1
      ? bills[0]
      : bills.find((candidate) => candidate.orderId === selectedOrderId);

  if (bills.length === 0) {
    return (
      <FlowGrid
        busy={refreshing}
        context={
          <BalanceContext
            balance={balance}
            rate={rate}
            memberName={memberName}
          />
        }
        panel={
          <EmptyPanel
            onShowMemberQr={onShowMemberQr}
            onRefresh={onRefresh}
            refreshing={refreshing}
          />
        }
      />
    );
  }

  if (bill === undefined) {
    return (
      <FlowGrid
        busy={refreshing}
        context={
          <BalanceContext
            balance={balance}
            rate={rate}
            memberName={memberName}
          />
        }
        panel={<BillListPanel bills={bills} onSelect={onSelect} />}
      />
    );
  }

  return (
    <FlowGrid
      busy={refreshing}
      context={
        <BalanceContext
          balance={balance}
          rate={rate}
          memberName={memberName}
          note={<ConnectNote bill={bill} />}
        />
      }
      panel={
        <ActivePanel
          bill={bill}
          quote={quote ?? null}
          onChoosePoints={onChoosePoints}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      }
    />
  );
}

// `poin-setelah`: the bill already has points on it, so there is nothing left
// to redeem here. Shows what was used and what the cashier still has to collect.
export function PointsAfterView({
  bill,
  balancePoints,
}: {
  bill: MemberOpenBill;
  balancePoints: number;
}) {
  const t = useT();
  const redeemed = bill.pointsRedeemed;
  if (redeemed === null) return null;
  return (
    <FlowGrid
      context={
        <>
          <div className="grid gap-2">
            <Eyebrow>
              {t("member.tukarPoin.pointsAfter.contextEyebrow")}
            </Eyebrow>
            <h2 className="font-brand type-title">
              {t("member.tukarPoin.pointsAfter.contextTitle")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("member.tukarPoin.pointsAfter.contextBody")}
            </p>
          </div>
          <SummaryBox>
            <span className="text-sm leading-5">
              {t("member.tukarPoin.pointsAfter.balanceLabel")}
            </span>
            <BigAmount>
              {formatNumber(balancePoints)} <PointsUnit />
            </BigAmount>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("member.tukarPoin.pointsAfter.balanceHint", {
                points: formatNumber(redeemed.points),
              })}
            </p>
          </SummaryBox>
        </>
      }
      panel={
        <Panel>
          <div className="grid gap-2">
            <Eyebrow>
              {t("member.tukarPoin.pointsAfter.panelEyebrow", {
                outlet: bill.outletName,
              })}
            </Eyebrow>
            <PanelTitle>
              {t("member.tukarPoin.pointsAfter.panelTitle")}
            </PanelTitle>
          </div>
          <SummaryBox label={t("member.tukarPoin.pointsAfter.summaryLabel")}>
            <SummaryRow
              label={t("member.tukarPoin.pointsAfter.used")}
              value={t("member.tukarPoin.pointsAfter.usedValue", {
                points: formatNumber(redeemed.points),
              })}
            />
            <SummaryRow
              label={t("member.tukarPoin.pointsAfter.discount")}
              value={<Money amount={redeemed.discountIdr} size="sm" />}
            />
            <SummaryRow
              strong
              label={t("member.tukarPoin.pointsAfter.remaining")}
              value={<Money amount={bill.remainingIdr} size="sm" />}
            />
          </SummaryBox>
          <Note tone="success">{t("member.tukarPoin.pointsAfter.note")}</Note>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.tukarPoin.pointsAfter.oldQr")}
          </p>
        </Panel>
      }
    />
  );
}

function PointsUnit() {
  const t = useT();
  return (
    <span className="text-[0.5em] font-semibold text-muted-foreground">
      {t("member.tukarPoin.openBill.balanceUnit")}
    </span>
  );
}

// Left column: the balance first, so the member sees what they can spend.
// While the balance is not known yet the figure is a placeholder with a
// spoken "Sedang dimuat".
function BalanceContext({
  balance,
  rate,
  memberName,
  note,
}: {
  balance: number | undefined;
  rate: number | undefined;
  memberName: string | undefined;
  note?: ReactNode;
}) {
  const t = useT();
  const rateText =
    rate === undefined
      ? null
      : memberName
        ? t("member.tukarPoin.openBill.memberRateLine", {
            name: memberName,
            value: formatRupiah(rate),
          })
        : t("member.tukarPoin.openBill.rateLine", {
            value: formatRupiah(rate),
          });
  return (
    <>
      <div className="grid gap-1">
        <Eyebrow>{t("member.tukarPoin.openBill.balanceLabel")}</Eyebrow>
        <BigAmount
          label={
            balance === undefined
              ? t("member.tukarPoin.openBill.balanceLoading")
              : undefined
          }
        >
          {balance === undefined
            ? t("member.tukarPoin.openBill.balancePlaceholder")
            : formatNumber(balance)}{" "}
          <PointsUnit />
        </BigAmount>
        {rateText !== null && (
          <p className="text-sm leading-5 text-muted-foreground">{rateText}</p>
        )}
      </div>
      {note}
    </>
  );
}

function ConnectNote({ bill }: { bill: MemberOpenBill }) {
  const t = useT();
  return (
    <Note>
      {bill.attachedVia === "member_qr"
        ? t("member.tukarPoin.openBill.noteScanned")
        : t("member.tukarPoin.openBill.noteSession")}
    </Note>
  );
}

// `tanpa-tagihan`: the way to get a bill linked is to show the member QR.
function EmptyPanel({
  onShowMemberQr,
  onRefresh,
  refreshing,
}: {
  onShowMemberQr: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useT();
  return (
    <Panel>
      <div className="grid gap-2">
        <Eyebrow>{t("member.tukarPoin.openBill.emptyEyebrow")}</Eyebrow>
        <PanelTitle>{t("member.tukarPoin.openBill.emptyTitle")}</PanelTitle>
      </div>
      <p className="text-sm leading-6">
        {t("member.tukarPoin.openBill.emptyBody")}
      </p>
      <Note>{t("member.tukarPoin.openBill.emptyNote")}</Note>
      <div className="grid gap-3">
        <Button className="min-h-11 w-full" onClick={onShowMemberQr}>
          <QrCode aria-hidden="true" />
          {t("member.tukarPoin.openBill.showMemberQr")}
        </Button>
        <Button
          variant="secondary"
          className="min-h-11 w-full"
          loading={refreshing}
          onClick={onRefresh}
        >
          {t("member.tukarPoin.openBill.refresh")}
        </Button>
      </div>
    </Panel>
  );
}

// More than one linked bill: the member picks. Each button names its bill so
// a screen reader hears which one it chooses.
function BillListPanel({
  bills,
  onSelect,
}: {
  bills: MemberOpenBill[];
  onSelect: (orderId: string) => void;
}) {
  const t = useT();
  return (
    <Panel>
      <div className="grid gap-2">
        <Eyebrow>{t("member.tukarPoin.openBill.listEyebrow")}</Eyebrow>
        <PanelTitle>{t("member.tukarPoin.openBill.listTitle")}</PanelTitle>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("member.tukarPoin.openBill.listBody")}
        </p>
      </div>
      <ul className="grid gap-5">
        {bills.map((bill) => (
          <li key={bill.orderId} className="grid gap-3">
            <BillCard bill={bill} />
            <Button
              variant="outline"
              className="min-h-11 w-full"
              aria-label={t("member.tukarPoin.openBill.selectLabel", {
                number: bill.billNumber,
                outlet: bill.outletName,
              })}
              onClick={() => onSelect(bill.orderId)}
            >
              {t("member.tukarPoin.openBill.select")}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("member.tukarPoin.openBill.listNote")}
      </p>
    </Panel>
  );
}

type Blocker = MemberPointsRefusal | "noPoints" | "alreadyRedeemed";

// Why the "Pilih jumlah poin" button is off, or null when it is on. The server
// refusal wins; the others cover a bill that cannot take points anyway.
function blockerOf(
  bill: MemberOpenBill,
  quote: MemberPointsQuote | null,
): Blocker | null {
  if (bill.pointsRedeemed !== null) return "alreadyRedeemed";
  if (quote === null) return null;
  if (quote.refusal !== null) return quote.refusal;
  if (quote.maxPoints < quote.minPoints) return "noPoints";
  return null;
}

// `tagihan-aktif`: one bill, what the points could cover, and one next step.
function ActivePanel({
  bill,
  quote,
  onChoosePoints,
  onRefresh,
  refreshing,
}: {
  bill: MemberOpenBill;
  quote: MemberPointsQuote | null;
  onChoosePoints: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useT();
  const blocker = blockerOf(bill, quote);
  const checking = quote === null && blocker === null;
  const remaining = quote?.remainingIdr ?? bill.remainingIdr;
  return (
    <Panel>
      <div className="grid gap-2">
        <Eyebrow>{t("member.tukarPoin.openBill.activeEyebrow")}</Eyebrow>
        <PanelTitle>{t("member.tukarPoin.openBill.activeTitle")}</PanelTitle>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("member.tukarPoin.openBill.activeBody")}
        </p>
      </div>
      <BillCard bill={bill} />
      <SummaryBox label={t("member.tukarPoin.openBill.summaryLabel")}>
        <SummaryRow
          label={t("member.tukarPoin.openBill.remaining")}
          value={<Money amount={remaining} size="sm" />}
        />
        <SummaryRow
          label={t("member.tukarPoin.openBill.usable")}
          value={
            quote === null
              ? t("member.tukarPoin.openBill.usableChecking")
              : quote.maxPoints < quote.minPoints
                ? t("member.tukarPoin.openBill.usableNone")
                : t("member.tukarPoin.openBill.usableMax", {
                    points: formatNumber(quote.maxPoints),
                  })
          }
        />
        {quote !== null && quote.maxPoints >= quote.minPoints && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.tukarPoin.openBill.usableHint", {
              value: formatRupiah(quote.maxPoints * quote.pointValueIdr),
              min: formatNumber(quote.minPoints),
            })}
          </p>
        )}
      </SummaryBox>
      {blocker !== null && (
        <Note tone="warning">
          <span className="font-semibold">
            {t("member.tukarPoin.openBill.refusalLabel")}
          </span>{" "}
          {t(`member.tukarPoin.openBill.refusal.${blocker}`)}
        </Note>
      )}
      <div className="grid gap-3">
        <Button
          className="min-h-11 w-full"
          disabled={blocker !== null || checking}
          onClick={onChoosePoints}
        >
          {t("member.tukarPoin.openBill.choosePoints")}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 w-full"
          loading={refreshing}
          onClick={onRefresh}
        >
          {t("member.tukarPoin.openBill.refresh")}
        </Button>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {checking
          ? t("member.tukarPoin.openBill.checking")
          : blocker === null
            ? t("member.tukarPoin.openBill.chooseHint")
            : null}
      </p>
    </Panel>
  );
}
