// O4 offline payment (bead legend-wasr7.8, mockup design/mockups/pos/offline
// "bayar" and "tersimpan"). Only what the kit allows offline is offered: cash
// and manual EDC with the slip number (OFFLINE_TENDER_METHODS); QRIS, VA,
// points, vouchers and DP are named as online only, never shown as choices.
// The total is the kit's list price (no promo). "Simpan penjualan" queues the
// sale with its `L` number on this tablet; the cloud gets it when online.
// Printing needs the cloud's ESC/POS job, so the receipt is printed again
// once online (Keputusan CTO O4 no. 5).
import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Banknote, CircleCheck, CreditCard } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import type { PosOfflineKit } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { OfflineSaleError, priceOfflineSale, type OfflineCart } from "./price";
import type { OfflineQueue } from "./queue";
import {
  quickCash,
  saveOfflineSale,
  tenderOf,
  type OfflineSaved,
} from "./sale-view";

const ERROR_CODES = [
  "KIT_MISSING",
  "KIT_EXPIRED",
  "KIT_SHIFT_CLOSED",
  "TENDER_TOTAL_MISMATCH",
  "CASH_RECEIVED_SHORT",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];
const isErrorCode = (code: string): code is ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(code);

export type { OfflineSaved };

function digits(value: string): number | null {
  // Twelve digits are a trillion rupiah: enough, and always a safe integer.
  const only = value.replace(/\D/g, "").slice(0, 12);
  return only === "" ? null : Number(only);
}

export function OfflinePayDialog({
  open,
  onOpenChange,
  kit,
  cart,
  itemCount,
  queue,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kit: PosOfflineKit;
  cart: OfflineCart;
  itemCount: number;
  queue: Pick<OfflineQueue, "recordSale">;
  onSaved: (saved: OfflineSaved) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <PayBody
            kit={kit}
            cart={cart}
            itemCount={itemCount}
            queue={queue}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
            t={t}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PayBody({
  kit,
  cart,
  itemCount,
  queue,
  onSaved,
  onCancel,
  t,
  initial,
}: {
  kit: PosOfflineKit;
  cart: OfflineCart;
  itemCount: number;
  queue: Pick<OfflineQueue, "recordSale">;
  onSaved: (saved: OfflineSaved) => void;
  onCancel: () => void;
  t: ReturnType<typeof useT>;
  /** Tests only: server rendering cannot type. */
  initial?: { method?: "cash" | "edc_card"; received?: string };
}) {
  const id = useId();
  const [method, setMethod] = useState<"cash" | "edc_card">(
    initial?.method ?? "cash",
  );
  const [received, setReceived] = useState(initial?.received ?? "");
  const [reference, setReference] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priced = useMemo(() => {
    try {
      return priceOfflineSale(kit, cart, new Date());
    } catch {
      return null;
    }
  }, [kit, cart]);
  const totalIdr = priced?.totalIdr ?? 0;
  const receivedIdr = digits(received);
  const tender = tenderOf(method, totalIdr, { receivedIdr, reference });
  const short =
    method === "cash" && receivedIdr !== null && receivedIdr < totalIdr;
  const missingReference =
    method === "edc_card" && touched && reference.trim() === "";
  const allowed = new Set(kit.tenders);

  async function save() {
    setTouched(true);
    if (!tender || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveOfflineSale(queue, kit, cart, tender));
    } catch (failure) {
      const code =
        failure instanceof OfflineSaleError && isErrorCode(failure.code)
          ? failure.code
          : "generic";
      setError(t(`posKasirOffline.pay.errors.${code}`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("posKasirOffline.pay.title")}</DialogTitle>
        <DialogDescription>
          {t("posKasirOffline.pay.summary", { amount: formatRupiah(totalIdr) })}
        </DialogDescription>
      </DialogHeader>

      {!priced ? (
        <Notice tone="danger" title={t("posKasirOffline.pay.priceError")} />
      ) : (
        <>
          <dl className="grid gap-1 text-base">
            <Row
              label={t("posKasirOffline.pay.subtotal", { count: itemCount })}
              amount={priced.subtotalIdr}
            />
            {priced.serviceChargeIdr > 0 && (
              <Row
                label={t("posKasirOffline.pay.service")}
                amount={priced.serviceChargeIdr}
              />
            )}
            {priced.taxIdr > 0 && (
              <Row
                label={t("posKasirOffline.pay.tax")}
                amount={priced.taxIdr}
              />
            )}
            {priced.roundingIdr !== 0 && (
              <Row
                label={t("posKasirOffline.pay.rounding")}
                amount={priced.roundingIdr}
              />
            )}
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-xl font-bold">
              <dt>{t("posKasirOffline.pay.total")}</dt>
              <dd>
                <Money amount={totalIdr} size="lg" />
              </dd>
            </div>
          </dl>

          <div
            role="radiogroup"
            aria-label={t("posKasirOffline.pay.methods")}
            className="grid grid-cols-2 gap-2"
          >
            {allowed.has("cash") && (
              <MethodButton
                selected={method === "cash"}
                onClick={() => setMethod("cash")}
                icon={<Banknote aria-hidden="true" />}
                title={t("posKasirOffline.pay.cash")}
                hint={t("posKasirOffline.pay.cashHint")}
              />
            )}
            {allowed.has("edc_card") && (
              <MethodButton
                selected={method === "edc_card"}
                onClick={() => setMethod("edc_card")}
                icon={<CreditCard aria-hidden="true" />}
                title={t("posKasirOffline.pay.edc")}
                hint={t("posKasirOffline.pay.edcHint")}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("posKasirOffline.pay.onlineOnly")}
          </p>

          {method === "cash" ? (
            <div className="grid gap-2">
              <FormField
                id={`${id}-received`}
                label={t("posKasirOffline.pay.received")}
                error={short ? t("posKasirOffline.pay.short") : undefined}
                required
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={receivedIdr === null ? "" : formatRupiah(receivedIdr)}
                  onChange={(event) => setReceived(event.target.value)}
                  className="h-15 text-2xl font-bold tabular"
                />
              </FormField>
              <div className="grid grid-cols-3 gap-2">
                {quickCash(totalIdr).map((amount) => (
                  <Button
                    key={amount}
                    type="button"
                    variant="outline"
                    onClick={() => setReceived(String(amount))}
                    className="h-auto min-h-12 px-2 font-bold whitespace-normal"
                  >
                    {amount === totalIdr
                      ? t("posKasirOffline.pay.exact")
                      : formatRupiah(amount)}
                  </Button>
                ))}
              </div>
              {tender?.method === "cash" && (
                <p
                  role="status"
                  className="flex items-baseline justify-between gap-3 rounded-control bg-success-subtle px-4 py-2 text-lg font-bold text-success"
                >
                  <span>{t("posKasirOffline.pay.change")}</span>
                  <Money amount={tender.receivedIdr - tender.amountIdr} />
                </p>
              )}
            </div>
          ) : (
            <FormField
              id={`${id}-reference`}
              label={t("posKasirOffline.pay.reference")}
              hint={t("posKasirOffline.pay.referenceHint")}
              error={
                missingReference
                  ? t("posKasirOffline.pay.referenceRequired")
                  : undefined
              }
              required
            >
              <Input
                autoComplete="off"
                maxLength={100}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                onBlur={() => setTouched(true)}
                className="h-15 text-xl font-bold"
              />
            </FormField>
          )}
        </>
      )}

      {error && <Notice tone="danger" title={error} />}

      <DialogFooter className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="lg" onClick={onCancel}>
          {t("posKasirOffline.pay.cancel")}
        </Button>
        <Button
          type="button"
          size="lg"
          loading={saving}
          aria-disabled={!tender || saving ? true : undefined}
          onClick={() => void save()}
          className="font-bold"
        >
          {t("posKasirOffline.pay.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money amount={amount} />
      </dd>
    </div>
  );
}

function MethodButton({
  selected,
  onClick,
  icon,
  title,
  hint,
}: {
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "grid min-h-16 grid-cols-[auto_1fr] items-center gap-x-3 rounded-container border-(length:--border-w) border-border bg-card px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-6",
        selected && "border-primary bg-primary-tint ring-2 ring-primary",
      )}
    >
      <span className="row-span-2">{icon}</span>
      <span className="text-lg font-bold">{title}</span>
      <span className="text-sm text-muted-foreground">{hint}</span>
    </button>
  );
}

export function OfflineSavedDialog({
  saved,
  pending,
  onDone,
}: {
  saved: OfflineSaved | null;
  pending: number;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={saved !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="sm:max-w-md">
        {saved && (
          <>
            <DialogHeader className="items-center text-center">
              <CircleCheck
                className="size-14 text-success"
                aria-hidden="true"
              />
              <DialogTitle>{t("posKasirOffline.saved.title")}</DialogTitle>
              <DialogDescription>
                {t("posKasirOffline.saved.number")}
              </DialogDescription>
              <p className="text-4xl font-bold tracking-wide tabular">
                {saved.receiptNumber}
              </p>
            </DialogHeader>
            <dl className="grid border-t border-border text-base">
              {saved.event.tenders[0]?.method === "cash" && (
                <SavedRow label={t("posKasirOffline.saved.change")}>
                  <Money amount={saved.changeIdr} />
                </SavedRow>
              )}
              <SavedRow label={t("posKasirOffline.saved.cloud")}>
                {t("posKasirOffline.saved.cloudWaiting")}
              </SavedRow>
              <SavedRow label={t("posKasirOffline.saved.receipt")}>
                {t("posKasirOffline.saved.receiptLater")}
              </SavedRow>
              <SavedRow label={t("posKasirOffline.saved.queue")}>
                {t("posKasirOffline.saved.queueCount", { count: pending })}
              </SavedRow>
            </dl>
            <DialogFooter>
              <Button
                type="button"
                size="lg"
                onClick={onDone}
                className="w-full font-bold"
              >
                {t("posKasirOffline.saved.next")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SavedRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-bold">{children}</dd>
    </div>
  );
}
