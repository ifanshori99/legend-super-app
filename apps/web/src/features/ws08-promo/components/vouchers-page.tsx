// Voucher codes (/kelola/promo/voucher; PRD v1.7 §3.21, §6.G): issued vouchers
// with status, issuing a new one (the plain code shows once), and a validity
// check that behaves like the cashier's code entry.
import * as React from "react";
import { Plus, ShieldCheck, Ticket } from "lucide-react";
import type {
  PromoChannel,
  VoucherDto,
  VoucherRejectionReason,
  VoucherSource,
  VoucherStatus,
} from "@starter/shared/crm";
import { formatRupiah } from "@starter/shared/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  useIssueVoucher,
  usePromotions,
  useValidateVoucher,
  useVouchers,
} from "../hooks";
import {
  PROMO_CHANNELS,
  dateInputValue,
  formatDateLabel,
  isUuid,
  isValidCode,
  isoFromDateInput,
  normalizeCode,
  parseWholeNumber,
} from "../lib";
import { usePromoT, type PromoT } from "../t";
import { Notice, useOnline } from "./promo-shell";

const STATUSES: readonly VoucherStatus[] = [
  "issued",
  "redeemed",
  "expired",
  "cancelled",
];
const SOURCES: readonly VoucherSource[] = [
  "promo_code",
  "apology",
  "birthday",
  "referral",
  "campaign",
  "manual",
];
const STATUS_TONE: Record<
  VoucherStatus,
  "success" | "neutral" | "warning" | "danger"
> = {
  issued: "success",
  redeemed: "neutral",
  expired: "warning",
  cancelled: "danger",
};

function validityLine(voucher: VoucherDto, t: PromoT): string {
  return voucher.validUntil === null
    ? t("promo.list.windowOpen", { from: formatDateLabel(voucher.validFrom) })
    : t("promo.list.window", {
        from: formatDateLabel(voucher.validFrom),
        to: formatDateLabel(voucher.validUntil),
      });
}

export function VouchersPage() {
  const t = usePromoT();
  const [filter, setFilter] = React.useState<"all" | VoucherStatus>("all");
  const [search, setSearch] = React.useState("");
  const [issuing, setIssuing] = React.useState(false);
  const [issuedCode, setIssuedCode] = React.useState<string | null>(null);
  const vouchersQuery = useVouchers(filter === "all" ? undefined : filter);
  const promotionsQuery = usePromotions();

  const vouchers = vouchersQuery.data?.data ?? [];
  const promotions = promotionsQuery.data?.data ?? [];
  const promoName = (voucher: VoucherDto) =>
    voucher.promotionId === null
      ? t("promo.vouchers.noPromo")
      : (promotions.find((p) => p.id === voucher.promotionId)?.name ?? "—");
  const filtered = vouchers.filter((voucher) =>
    `${promoName(voucher)} ${t(`promo.vouchers.source.${voucher.source}`)}`
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );
  const valueLine = (voucher: VoucherDto) =>
    voucher.valueIdr === null ? "—" : formatRupiah(voucher.valueIdr);
  const pill = (voucher: VoucherDto) => (
    <Badge tone={STATUS_TONE[voucher.status]}>
      {t(`promo.vouchers.status.${voucher.status}`)}
    </Badge>
  );

  const state = vouchersQuery.isPending
    ? "loading"
    : vouchersQuery.isError
      ? "error"
      : vouchers.length === 0
        ? "empty"
        : "ready";
  const filteredEmpty = filter !== "all" && vouchers.length === 0;

  return (
    <>
      <DataTableShell
        title={t("promo.vouchers.title")}
        description={t("promo.vouchers.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("promo.vouchers.searchLabel"),
        }}
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={filter}
              onValueChange={(value) =>
                setFilter(value as "all" | VoucherStatus)
              }
            >
              <SelectTrigger
                aria-label={t("promo.vouchers.filterLabel")}
                className="sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("promo.vouchers.filterAll")}
                </SelectItem>
                {STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`promo.vouchers.status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" onClick={() => setIssuing(true)}>
              <Plus aria-hidden="true" />
              {t("promo.vouchers.issue")}
            </Button>
          </div>
        }
        onRetry={() => void vouchersQuery.refetch()}
        empty={{
          title: filteredEmpty
            ? t("promo.vouchers.emptyFilteredTitle")
            : t("promo.vouchers.emptyTitle"),
          description: filteredEmpty
            ? t("promo.vouchers.emptyFilteredHint")
            : t("promo.vouchers.emptyHint"),
          action: filteredEmpty ? undefined : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setIssuing(true)}
            >
              {t("promo.vouchers.issue")}
            </Button>
          ),
        }}
        noResults={filtered.length === 0 && vouchers.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("promo.vouchers.columns.promo")}</TableHead>
                <TableHead>{t("promo.vouchers.columns.source")}</TableHead>
                <TableHead numeric>
                  {t("promo.vouchers.columns.value")}
                </TableHead>
                <TableHead>{t("promo.vouchers.columns.window")}</TableHead>
                <TableHead>{t("promo.vouchers.columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((voucher) => (
                <TableRow key={voucher.id}>
                  <TableCell className="font-medium">
                    {promoName(voucher)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {t(`promo.vouchers.source.${voucher.source}`)}
                  </TableCell>
                  <TableCell numeric className="tabular">
                    {valueLine(voucher)}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {validityLine(voucher, t)}
                  </TableCell>
                  <TableCell>{pill(voucher)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ul className="md:hidden">
          {filtered.map((voucher) => (
            <li
              key={voucher.id}
              className="grid gap-1 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-medium">
                  {promoName(voucher)}
                </span>
                {pill(voucher)}
              </div>
              <span className="text-sm text-muted-foreground">
                {t(`promo.vouchers.source.${voucher.source}`)} ·{" "}
                {valueLine(voucher)}
              </span>
              <span className="tabular text-sm text-muted-foreground">
                {validityLine(voucher, t)}
              </span>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <ValidateCard />

      <IssueDialog
        open={issuing}
        onClose={() => setIssuing(false)}
        onIssued={(code) => {
          setIssuing(false);
          setIssuedCode(code);
        }}
      />

      <Dialog
        open={issuedCode !== null}
        onOpenChange={(open) => !open && setIssuedCode(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("promo.vouchers.issuedTitle")}</DialogTitle>
            <DialogDescription>
              {t("promo.vouchers.issuedBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1 rounded-control bg-surface-2 p-4 text-center">
            <p className="type-eyebrow text-muted-foreground">
              {t("promo.vouchers.issuedCode")}
            </p>
            <p
              data-testid="issued-code"
              className="tabular font-mono text-2xl font-semibold tracking-widest break-all select-all"
            >
              {issuedCode}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setIssuedCode(null)}>
              {t("promo.vouchers.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type IssueForm = {
  promotionId: string;
  source: VoucherSource;
  value: string;
  customer: string;
  from: string;
  until: string;
};
type IssueErrors = Partial<Record<keyof IssueForm, Parameters<PromoT>[0]>>;

function IssueDialog({
  open,
  onClose,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onIssued: (code: string) => void;
}) {
  const t = usePromoT();
  const toast = useToast();
  const online = useOnline();
  const promotionsQuery = usePromotions();
  const issue = useIssueVoucher();
  const blank = (): IssueForm => ({
    promotionId: "none",
    source: "manual",
    value: "",
    customer: "",
    from: dateInputValue(new Date().toISOString()),
    until: "",
  });
  const [form, setForm] = React.useState<IssueForm>(blank);
  const [errors, setErrors] = React.useState<IssueErrors>({});
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // Reset the dialog each time it opens.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(blank());
      setErrors({});
      setFailed(false);
    }
  }, [open]);

  const promotions = (promotionsQuery.data?.data ?? []).filter(
    (promotion) => promotion.status !== "ended",
  );
  const set = <Field extends keyof IssueForm>(
    field: Field,
    value: IssueForm[Field],
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFailed(false);
  };
  const err = (field: keyof IssueForm) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };

  function submit() {
    const next: IssueErrors = {};
    const hasPromo = form.promotionId !== "none";
    const value =
      form.value.trim() === "" ? null : parseWholeNumber(form.value);
    if (!hasPromo && form.value.trim() === "")
      next.value = "vouchers.errorPromoOrValue";
    else if (form.value.trim() !== "" && (value === null || value < 0))
      next.value = "vouchers.errorValue";
    if (form.customer.trim() !== "" && !isUuid(form.customer))
      next.customer = "vouchers.errorCustomer";
    if (form.from === "") next.from = "vouchers.errorFrom";
    else if (form.until !== "" && form.until < form.from)
      next.until = "vouchers.errorDates";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    issue.mutate(
      {
        promotionId: hasPromo ? form.promotionId : null,
        customerProfileId:
          form.customer.trim() === "" ? null : form.customer.trim(),
        source: form.source,
        valueIdr: value,
        validFrom: isoFromDateInput(form.from, "start"),
        validUntil:
          form.until === "" ? null : isoFromDateInput(form.until, "end"),
      } as Parameters<typeof issue.mutate>[0],
      {
        onSuccess: (result) => {
          toast({ title: t("promo.vouchers.issuedTitle"), tone: "success" });
          onIssued(result.code);
        },
        onError: () => setFailed(true),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !issue.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("promo.vouchers.issueTitle")}</DialogTitle>
          <DialogDescription>
            {t("promo.vouchers.issueDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          id="voucher-issue-form"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            id="voucher-promo"
            label={t("promo.vouchers.fieldPromo")}
            className="sm:col-span-2"
          >
            <Select
              value={form.promotionId}
              onValueChange={(value) => set("promotionId", value)}
            >
              <SelectTrigger id="voucher-promo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("promo.vouchers.fieldPromoNone")}
                </SelectItem>
                {promotions.map((promotion) => (
                  <SelectItem key={promotion.id} value={promotion.id}>
                    {promotion.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            id="voucher-source"
            label={t("promo.vouchers.fieldSource")}
          >
            <Select
              value={form.source}
              onValueChange={(value) => set("source", value as VoucherSource)}
            >
              <SelectTrigger id="voucher-source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((source) => (
                  <SelectItem key={source} value={source}>
                    {t(`promo.vouchers.source.${source}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("promo.vouchers.fieldValue")}
            hint={t("promo.vouchers.fieldValueHint")}
            error={err("value")}
            required={form.promotionId === "none"}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={form.value}
              onChange={(event) => set("value", event.target.value)}
            />
          </FormField>
          <FormField
            label={t("promo.vouchers.fieldCustomer")}
            hint={t("promo.vouchers.fieldCustomerHint")}
            error={err("customer")}
            className="sm:col-span-2"
          >
            <Input
              value={form.customer}
              onChange={(event) => set("customer", event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField
            label={t("promo.vouchers.fieldFrom")}
            error={err("from")}
            required
          >
            <Input
              type="date"
              value={form.from}
              onChange={(event) => set("from", event.target.value)}
            />
          </FormField>
          <FormField
            label={t("promo.vouchers.fieldUntil")}
            hint={t("promo.vouchers.fieldUntilHint")}
            error={err("until")}
          >
            <Input
              type="date"
              value={form.until}
              onChange={(event) => set("until", event.target.value)}
            />
          </FormField>
          {failed && (
            <Notice tone="danger" role="alert" className="sm:col-span-2">
              {t("promo.vouchers.issueFailed")}
            </Notice>
          )}
          {!online && (
            <Notice tone="warning" className="sm:col-span-2">
              {t("promo.offline.saveBlocked")}
            </Notice>
          )}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={issue.isPending}
            onClick={onClose}
          >
            {t("promo.common.cancel")}
          </Button>
          <Button
            type="submit"
            form="voucher-issue-form"
            loading={issue.isPending}
            disabled={!online}
          >
            <Ticket aria-hidden="true" />
            {t("promo.vouchers.issueSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ValidateCard() {
  const t = usePromoT();
  const online = useOnline();
  const validate = useValidateVoucher();
  const [code, setCode] = React.useState("");
  const [subtotal, setSubtotal] = React.useState("100000");
  const [channel, setChannel] = React.useState<PromoChannel>("dine_in");
  const [errors, setErrors] = React.useState<{
    code?: boolean;
    subtotal?: boolean;
  }>({});

  function submit() {
    const amount = parseWholeNumber(subtotal);
    const next = {
      code: !isValidCode(code) || undefined,
      subtotal: amount === null || amount < 0 || undefined,
    };
    setErrors(next);
    if (next.code || next.subtotal || amount === null) return;
    validate.mutate({
      code: normalizeCode(code),
      subtotalIdr: amount,
      channel,
    } as Parameters<typeof validate.mutate>[0]);
  }

  const result = validate.data;
  return (
    <Card aria-labelledby="voucher-validate-title">
      <div className="grid gap-1">
        <h3 id="voucher-validate-title" className="type-title">
          {t("promo.vouchers.validateTitle")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("promo.vouchers.validateDescription")}
        </p>
      </div>
      <form
        noValidate
        className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField
          label={t("promo.vouchers.validateCode")}
          hint={t("promo.vouchers.validateCodeHint")}
          error={errors.code ? t("promo.vouchers.errorCode") : undefined}
          required
        >
          <Input
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              setErrors((current) => ({ ...current, code: undefined }));
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label={t("promo.vouchers.validateSubtotal")}
          error={
            errors.subtotal ? t("promo.vouchers.errorSubtotal") : undefined
          }
          required
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={subtotal}
            onChange={(event) => {
              setSubtotal(event.target.value);
              setErrors((current) => ({ ...current, subtotal: undefined }));
            }}
          />
        </FormField>
        <FormField
          id="voucher-validate-channel"
          label={t("promo.vouchers.validateChannel")}
        >
          <Select
            value={channel}
            onValueChange={(value) => setChannel(value as PromoChannel)}
          >
            <SelectTrigger id="voucher-validate-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROMO_CHANNELS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`promo.channel.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <Button
          type="submit"
          variant="outline"
          className="sm:mt-6"
          loading={validate.isPending}
          disabled={!online}
        >
          <ShieldCheck aria-hidden="true" />
          {t("promo.vouchers.validateSubmit")}
        </Button>
      </form>
      {validate.isError && (
        <Notice tone="danger" role="alert">
          {t("promo.vouchers.validateFailed")}
        </Notice>
      )}
      {result &&
        (result.valid ? (
          <Notice tone="info" role="status" icon={ShieldCheck}>
            {t("promo.vouchers.validateOk", {
              amount: formatRupiah(result.discountPreviewIdr),
            })}
          </Notice>
        ) : (
          <Notice tone="warning" role="status">
            {t(
              `vouchers.reason.${result.reason satisfies VoucherRejectionReason}`,
            )}
          </Notice>
        ))}
    </Card>
  );
}
