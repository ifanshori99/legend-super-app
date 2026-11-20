// The newest-first list: a table from 700px up, one card per row below it.
// Only the layout that fits is rendered (up to 500 rows would otherwise be
// built twice); the server render and first paint assume desktop.
// Each row's reference opens a native <details> with the source, the full
// reference and a plain sentence about the kind (no raw payload, no PII).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FinanceExceptionItemDto } from "@starter/shared/types";
import {
  KIND_HELP_KEYS,
  KIND_LABEL_KEYS,
  OUTBOX_STATE_KEYS,
  detailKey,
  formatOccurred,
  reconScreenPath,
  refTypeKey,
  shortRef,
} from "../lib";

type Props = {
  items: readonly FinanceExceptionItemDto[];
  /** Outlet name by id; undefined when the outlet list does not know the id. */
  outletName: (outletId: string) => string | undefined;
};

const WIDE_QUERY = "(min-width: 700px)";

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** True from 700px up; true on the server and while hydrating. */
function useWideLayout() {
  return React.useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

function useRowText(outletName: Props["outletName"]) {
  const t = useT();
  return (item: FinanceExceptionItemDto) => {
    const when = formatOccurred(item.occurredAt);
    return {
      date: when.date,
      time: when.time ? `${when.time} ${t("financeExceptions.list.wib")}` : "",
      kind: t(KIND_LABEL_KEYS[item.kind]),
      outlet:
        item.outletId === null
          ? t("financeExceptions.list.wholeEntity")
          : (outletName(item.outletId) ??
            t("financeExceptions.list.unknownOutlet")),
    };
  };
}

function Reference({ item }: { item: FinanceExceptionItemDto }) {
  const t = useT();
  const short = shortRef(item.refId);
  const detailSentenceKey = item.detail ? detailKey(item.detail, item.kind) : undefined;
  const reconPath = reconScreenPath(item.kind);
  return (
    <details className="group min-w-0 text-sm">
      <summary
        aria-label={t("financeExceptions.list.refOpen", { ref: short })}
        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 font-medium text-primary tabular marker:content-none min-[700px]:min-h-0"
      >
        <span
          aria-hidden="true"
          className="text-[0.7em] transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {short}
      </summary>
      <div className="mt-1 grid gap-1.5 rounded-control bg-surface-2 p-3 text-sm">
        <p className="text-muted-foreground">{t(KIND_HELP_KEYS[item.kind])}</p>
        <dl className="grid gap-1.5">
          <div>
            <dt className="text-xs text-muted-foreground">
              {t("financeExceptions.list.refSource")}
            </dt>
            <dd>{t(refTypeKey(item.refType))}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t("financeExceptions.list.refId")}
            </dt>
            <dd className="font-mono text-xs break-all">{item.refId}</dd>
          </div>
          {item.detail && (
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("financeExceptions.list.refDetail")}
              </dt>
              <dd className={detailSentenceKey ? undefined : "break-all"}>
                {detailSentenceKey
                  ? t(detailSentenceKey)
                  : item.kind === "payout_fee_not_posted"
                    ? `${t("financeExceptions.details.batchPrefix")} ${item.detail}`
                    : item.detail}
              </dd>
            </div>
          )}
          {item.receiptPending && (
            <>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("financeExceptions.details.receiptOrder")}
                </dt>
                <dd className="font-mono text-xs break-all">
                  {item.receiptPending.orderId ??
                    t("financeExceptions.details.receiptNone")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("financeExceptions.details.receiptIntent")}
                </dt>
                <dd className="font-mono text-xs break-all">
                  {item.receiptPending.intentId ??
                    t("financeExceptions.details.receiptNone")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("financeExceptions.details.receiptOutbox")}
                </dt>
                <dd>{t(OUTBOX_STATE_KEYS[item.receiptPending.outboxState])}</dd>
              </div>
            </>
          )}
        </dl>
        {reconPath && (
          <Link
            to={reconPath}
            className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t("financeExceptions.list.reconLink")}
          </Link>
        )}
      </div>
    </details>
  );
}

function Amount({ value }: { value: number | null }) {
  const t = useT();
  return value === null ? (
    <span className="text-sm text-muted-foreground">
      {t("financeExceptions.list.amountUnavailable")}
    </span>
  ) : (
    <Money amount={value} className="font-semibold" />
  );
}

const rowKey = (item: FinanceExceptionItemDto) =>
  `${item.kind}:${item.refType}:${item.refId}`;

export function ExceptionsList({ items, outletName }: Props) {
  const t = useT();
  const text = useRowText(outletName);
  const wide = useWideLayout();
  if (!wide) {
    // Phones: one card per exception, amount and outlet stay readable.
    return (
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const row = text(item);
          return (
            <li key={rowKey(item)} className="grid gap-1.5 p-card">
              <p className="text-sm tabular text-muted-foreground">
                {row.date} {row.time}
              </p>
              <p className="font-semibold">{row.kind}</p>
              <Reference item={item} />
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-muted-foreground">{row.outlet}</span>
                <Amount value={item.amountIdr} />
              </p>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Table className="min-w-[40rem]">
      <TableHeader>
        <TableRow className="bg-surface-2">
          <TableHead>{t("financeExceptions.list.columns.time")}</TableHead>
          <TableHead>{t("financeExceptions.list.columns.kind")}</TableHead>
          <TableHead>{t("financeExceptions.list.columns.outlet")}</TableHead>
          <TableHead numeric>
            {t("financeExceptions.list.columns.amount")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const row = text(item);
          return (
            <TableRow key={rowKey(item)} className="align-top">
              <TableCell className="py-4 whitespace-nowrap tabular">
                <span className="block">{row.date}</span>
                <span className="block text-muted-foreground">{row.time}</span>
              </TableCell>
              <TableCell className="py-4">
                <span className="block font-semibold">{row.kind}</span>
                <Reference item={item} />
              </TableCell>
              <TableCell className="py-4">{row.outlet}</TableCell>
              <TableCell numeric className="py-4">
                <Amount value={item.amountIdr} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
