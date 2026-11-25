// Public e-receipt (bead legend-1uk9; PRD §3 F11 "Struk & Kuitansi", POS-07):
// what a customer sees after opening the link or QR on their receipt. Phone
// first (one column, 48px targets), still tidy on a desktop. No sign-in; the
// API removes the cashier name and payment references from this document.
import * as React from "react";
import { CircleCheck, Download, Undo2 } from "lucide-react";
import type { ReceiptDocument } from "@starter/shared/pos";
import { formatRupiah, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { receiptPdfUrl } from "../api.ts";
import { useReceiptBrand, usePublicReceipt } from "../hooks.ts";
import {
  formatIssuedAt,
  isInvalidLink,
  paidIdr,
  singleTender,
} from "../lib.ts";

function Divider() {
  return <hr className="my-5 border-border" />;
}

function Line({
  label,
  hint,
  children,
  strong,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={`mt-3 flex items-start justify-between gap-4 ${strong ? "text-lg font-bold" : ""}`}
    >
      <span className="min-w-0">
        {label}
        {hint && (
          <small className="block text-sm font-normal text-muted-foreground">
            {hint}
          </small>
        )}
      </span>
      <span className="text-right font-semibold whitespace-nowrap">
        {children}
      </span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-bold tracking-wider text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function ReceiptBody({ document }: { document: ReceiptDocument }) {
  const t = useT();
  const voided = document.status === "voided";
  const deposit = Number(document.depositAppliedIdr);
  const single = singleTender(document.tenders, deposit);
  const tenderLabel = (method: ReceiptDocument["tenders"][number]["method"]) =>
    t(`posReceiptPublic.tender.${method}` as MessageKey);
  return (
    <article
      className="rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:p-6"
      aria-label={t(`posReceiptPublic.title.${document.documentKind}`)}
      data-testid="public-receipt"
    >
      <header className="text-center">
        <h1 className="text-2xl font-bold">
          {t(`posReceiptPublic.title.${document.documentKind}`)}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {t("posReceiptPublic.meta", {
            number: document.receiptNumber,
            when: formatIssuedAt(document.issuedAt),
          })}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Badge tone={voided ? "danger" : "success"}>
            {voided ? (
              <Undo2 aria-hidden="true" />
            ) : (
              <CircleCheck aria-hidden="true" />
            )}
            {t(`posReceiptPublic.status.${document.status}`)}
          </Badge>
          {document.reprint && (
            <Badge tone="neutral">{t("posReceiptPublic.reprint")}</Badge>
          )}
        </div>
      </header>

      <Divider />
      <Label>{t("posReceiptPublic.outlet")}</Label>
      <p className="mt-1 font-semibold">{document.outletName}</p>
      <p className="text-sm text-muted-foreground">{document.outletAddress}</p>

      <Divider />
      <Label>{t("posReceiptPublic.orderLabel")}</Label>
      <ul>
        {document.items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <Line
              label={t("posReceiptPublic.lineCount", {
                count: item.quantity,
                name: item.name,
              })}
              hint={
                <>
                  {item.quantity > 1 && (
                    <span className="block">
                      {t("posReceiptPublic.unitPrice", {
                        price: formatRupiah(item.unitPriceIdr),
                      })}
                    </span>
                  )}
                  {item.note && (
                    <span className="block">
                      {t("posReceiptPublic.note", { note: item.note })}
                    </span>
                  )}
                </>
              }
            >
              <Money amount={item.lineTotalIdr} className="font-semibold" />
            </Line>
          </li>
        ))}
      </ul>

      <Divider />
      <Line label={t("posReceiptPublic.subtotal")}>
        <Money amount={document.subtotalIdr} className="font-semibold" />
      </Line>
      {document.discounts.map((discount, index) => (
        <Line key={`${discount.label}-${index}`} label={discount.label}>
          <Money amount={-discount.amountIdr} className="font-semibold" />
        </Line>
      ))}
      {document.serviceCharge && (
        <Line label={t("posReceiptPublic.service")}>
          <Money
            amount={document.serviceCharge.amountIdr}
            className="font-semibold"
          />
        </Line>
      )}
      {document.taxLines.map((tax) => (
        <Line key={tax.taxRuleId} label={tax.name}>
          <Money amount={tax.amountIdr} className="font-semibold" />
        </Line>
      ))}
      {document.roundingIdr !== 0 && (
        <Line label={t("posReceiptPublic.rounding")}>
          <Money amount={document.roundingIdr} className="font-semibold" />
        </Line>
      )}
      <Line label={t("posReceiptPublic.total")} strong>
        <Money amount={document.totalIdr} size="lg" className="font-bold" />
      </Line>

      <Divider />
      {single ? (
        <Line label={t("posReceiptPublic.payment")}>
          {tenderLabel(single.method)}
        </Line>
      ) : (
        <>
          <Label>{t("posReceiptPublic.payment")}</Label>
          {document.tenders.map((tender, index) => (
            <Line
              key={`${tender.method}-${index}`}
              label={tenderLabel(tender.method)}
            >
              <Money amount={tender.amountIdr} className="font-semibold" />
            </Line>
          ))}
          {deposit > 0 && (
            <Line label={t("posReceiptPublic.deposit")}>
              <Money amount={deposit} className="font-semibold" />
            </Line>
          )}
        </>
      )}
      <Line label={t("posReceiptPublic.paid")}>
        <Money
          amount={paidIdr(document.tenders, deposit)}
          className="font-semibold"
        />
      </Line>
    </article>
  );
}

function ReceiptSkeleton() {
  const t = useT();
  return (
    <div
      aria-busy="true"
      role="status"
      aria-label={t("posReceiptPublic.loadingLabel")}
    >
      <p className="mb-4 text-center text-muted-foreground">
        {t("posReceiptPublic.loading")}
      </p>
      <div className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:p-6">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-5 w-4/5" />
        <hr className="border-border" />
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-5 w-4/5" />
        <hr className="border-border" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-5 w-1/3" />
      </div>
    </div>
  );
}

export function PublicReceiptPage({ token }: { token: string }) {
  const t = useT();
  const brand = useReceiptBrand();
  const query = usePublicReceipt(token);
  const document = query.data;
  const brandName = brand ?? document?.outletName ?? null;

  let body: React.ReactNode;
  if (query.isError && isInvalidLink(query.error)) {
    body = (
      <ErrorState
        title={t("posReceiptPublic.invalid.title")}
        description={t("posReceiptPublic.invalid.hint")}
      />
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title={t("posReceiptPublic.error.title")}
        description={t("posReceiptPublic.error.hint")}
        action={
          <Button
            className="w-full min-w-48"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t("posReceiptPublic.error.retry")}
          </Button>
        }
      />
    );
  } else if (!document) {
    body = <ReceiptSkeleton />;
  } else {
    body = (
      <>
        <ReceiptBody document={document} />
        <div className="mt-5 grid gap-2.5">
          <Button asChild size="lg" className="w-full">
            <a href={receiptPdfUrl(token, "receipt")} download>
              <Download aria-hidden="true" />
              {t("posReceiptPublic.downloadReceipt")}
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full">
            <a href={receiptPdfUrl(token, "kuitansi")} download>
              <Download aria-hidden="true" />
              {t("posReceiptPublic.downloadKuitansi")}
            </a>
          </Button>
        </div>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {t("posReceiptPublic.thanks")}
        </p>
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-1 pb-10">
      <div className="my-2 mb-6 text-center">
        {brandName && <strong className="text-xl">{brandName}</strong>}
        {API_MOCK && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("posReceiptPublic.mockNote")}
          </p>
        )}
      </div>
      {body}
    </div>
  );
}
