// EDC terminals and the cashier default tender (PRD §3 F13 "EDC Terintegrasi
// Multi-bank" + "Routing kasir"): several banks run side by side in one
// outlet, and each cashier has a default method/terminal without retyping the
// amount at the EDC. The amount itself always comes from POS (EDC-01).
import * as React from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useAttemptKey } from "../use-attempt-key";
import { Pencil, Plus, Scale } from "lucide-react";
import { useT } from "@/components/i18n";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { OutletId } from "@starter/shared/core";
import type {
  CashierDefaultMethod,
  CreateEdcTerminalInput,
  EdcCashierDefault,
  EdcTerminalView,
  UpdateEdcCashierDefaultInput,
  UpdateEdcTerminalInput,
} from "@starter/shared/payment/admin";
import {
  bankLabelKey,
  cashierMethodLabelKey,
  connectionLabelKey,
} from "../format";
import {
  useCreateEdcTerminal,
  useEdcCashierDefaults,
  useEdcTerminals,
  usePaymentRouting,
  useUpdateEdcCashierDefault,
  useUpdateEdcTerminal,
} from "../hooks";

const BANKS = ["bca", "mandiri", "bni", "bjb"] as const;
const CASHIER_METHODS: readonly CashierDefaultMethod[] = [
  "edc_card",
  "edc_qris",
  "qris_doit",
];

/** The reconciliation page needs payment.reconcile, like its API route. */
function useCanReconcileEdc(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? holdsAny(context.access, ["payment.reconcile"])
    : false;
}

export function EdcPanel() {
  const t = useT();
  const canReconcile = useCanReconcileEdc();
  const routing = usePaymentRouting(null);
  const outlets = routing.data?.data.outlets ?? [];
  const [outletId, setOutletId] = React.useState<string | null>(null);
  const selectedOutletId = outletId ?? outlets[0]?.id ?? null;

  if (routing.isPending && outlets.length === 0) return <EdcSkeleton />;
  if (routing.isError) {
    return (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <ErrorState
          title={t("paymentAdmin.loadErrorTitle")}
          description={t("paymentAdmin.loadErrorHint")}
          onRetry={() => void routing.refetch()}
        />
      </div>
    );
  }
  if (selectedOutletId === null) {
    return (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <section
      aria-labelledby="edc-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline sm:flex sm:items-end sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <h2 id="edc-title" className="type-title">
            {t("paymentAdmin.tabs.edc")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.edc.terminalsHint")}
          </p>
        </div>
        <div className="grid gap-3 sm:flex sm:items-end">
          {canReconcile && (
            <Button asChild variant="outline">
              <Link to="/kelola/pembayaran/edc-rekonsiliasi">
                <Scale aria-hidden="true" />
                {t("edcRecon.queue.entryLink")}
              </Link>
            </Button>
          )}
          <FormField
            label={t("paymentAdmin.routing.outlet")}
            required
            className="sm:w-64"
          >
            <Select value={selectedOutletId} onValueChange={setOutletId}>
              <SelectTrigger
                className="w-full"
                aria-label={t("paymentAdmin.routing.outlet")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {outlets.map((outlet) => (
                  <SelectItem key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </div>
      <TerminalsTable
        outletId={selectedOutletId}
        outletName={
          outlets.find((outlet) => outlet.id === selectedOutletId)?.name ?? ""
        }
      />
      <CashierDefaults outletId={selectedOutletId} />
    </section>
  );
}

function TerminalsTable({
  outletId,
  outletName,
}: {
  outletId: string;
  outletName: string;
}) {
  const t = useT();
  const toast = useToast();
  const terminals = useEdcTerminals(outletId);
  const [editor, setEditor] = React.useState<
    { mode: "new" } | { mode: "edit"; terminal: EdcTerminalView } | null
  >(null);
  const rows = terminals.data?.data ?? [];
  const state = terminals.isPending
    ? "loading"
    : terminals.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <>
      <DataTableShell
        title={t("paymentAdmin.edc.terminalsTitle")}
        state={state}
        rowCount={rows.length}
        onRetry={() => void terminals.refetch()}
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => setEditor({ mode: "new" })}
          >
            <Plus aria-hidden="true" />
            {t("paymentAdmin.edc.add")}
          </Button>
        }
        empty={{
          title: t("paymentAdmin.edc.emptyTitle"),
          description: t("paymentAdmin.edc.emptyHint"),
          action: (
            <Button
              type="button"
              size="sm"
              onClick={() => setEditor({ mode: "new" })}
            >
              <Plus aria-hidden="true" />
              {t("paymentAdmin.edc.add")}
            </Button>
          ),
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("paymentAdmin.edc.bank")}</TableHead>
              <TableHead>{t("paymentAdmin.edc.terminalId")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("paymentAdmin.edc.model")}
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("paymentAdmin.edc.methods")}
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                {t("paymentAdmin.edc.status")}
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("common.save")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((terminal) => (
              <TableRow key={terminal.id}>
                <TableCell className="font-semibold">
                  {t(bankLabelKey(terminal.bankCode))}
                  <span className="mt-1 flex sm:hidden">
                    <StatusPill
                      status={
                        terminal.status === "active" ? "success" : "warning"
                      }
                    >
                      {terminal.status === "active"
                        ? t("paymentAdmin.edc.active")
                        : t("paymentAdmin.edc.inactive")}
                    </StatusPill>
                  </span>
                </TableCell>
                <TableCell>
                  <p className="tabular">{terminal.terminalId}</p>
                  <p className="text-sm text-muted-foreground tabular">
                    {terminal.merchantId}
                  </p>
                  <p className="text-sm text-muted-foreground sm:hidden">
                    {terminal.supportedMethods
                      .map((method) =>
                        method === "card"
                          ? t("paymentAdmin.edc.methodCard")
                          : t("paymentAdmin.edc.methodQris"),
                      )
                      .join(" · ")}
                  </p>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <p>{terminal.model}</p>
                  <p className="text-sm text-muted-foreground">
                    {t(connectionLabelKey(terminal.connection))}
                  </p>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {terminal.supportedMethods.map((method) => (
                      <Badge key={method} tone="neutral">
                        {method === "card"
                          ? t("paymentAdmin.edc.methodCard")
                          : t("paymentAdmin.edc.methodQris")}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <StatusPill
                    status={
                      terminal.status === "active" ? "success" : "warning"
                    }
                  >
                    {terminal.status === "active"
                      ? t("paymentAdmin.edc.active")
                      : t("paymentAdmin.edc.inactive")}
                  </StatusPill>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("paymentAdmin.edc.edit")}
                    onClick={() => setEditor({ mode: "edit", terminal })}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      {editor && (
        <TerminalDialog
          outletId={outletId}
          outletName={outletName}
          terminal={editor.mode === "edit" ? editor.terminal : null}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            setEditor(null);
            toast({
              title:
                editor.mode === "edit"
                  ? t("paymentAdmin.edc.updated", {
                      terminalId: saved.terminalId,
                    })
                  : t("paymentAdmin.edc.created", {
                      terminalId: saved.terminalId,
                    }),
            });
          }}
        />
      )}
    </>
  );
}

function TerminalDialog({
  outletId,
  outletName,
  terminal,
  onClose,
  onSaved,
}: {
  outletId: string;
  outletName: string;
  terminal: EdcTerminalView | null;
  onClose: () => void;
  onSaved: (terminal: EdcTerminalView) => void;
}) {
  const t = useT();
  const create = useCreateEdcTerminal();
  const update = useUpdateEdcTerminal();
  const attempt = useAttemptKey();
  const [bankCode, setBankCode] = React.useState<EdcTerminalView["bankCode"]>(
    terminal?.bankCode ?? "bca",
  );
  const [terminalId, setTerminalId] = React.useState(
    terminal?.terminalId ?? "",
  );
  const [merchantId, setMerchantId] = React.useState(
    terminal?.merchantId ?? "",
  );
  const [model, setModel] = React.useState(terminal?.model ?? "");
  const [connection, setConnection] = React.useState<
    EdcTerminalView["connection"]
  >(terminal?.connection ?? "lan");
  const [ipAddress, setIpAddress] = React.useState(terminal?.ipAddress ?? "");
  const [supportsCard, setSupportsCard] = React.useState(
    terminal?.supportedMethods.includes("card") ?? true,
  );
  const [supportsQris, setSupportsQris] = React.useState(
    terminal?.supportedMethods.includes("qris") ?? true,
  );
  const [status, setStatus] = React.useState<EdcTerminalView["status"]>(
    terminal?.status ?? "active",
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const pending = create.isPending || update.isPending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string | undefined> = {};
    if (terminalId.trim() === "")
      next.terminalId = t("paymentAdmin.edc.terminalIdRequired");
    if (merchantId.trim() === "")
      next.merchantId = t("paymentAdmin.edc.merchantIdRequired");
    if (model.trim() === "") next.model = t("paymentAdmin.edc.modelRequired");
    if (!supportsCard && !supportsQris)
      next.supportedMethods = t("paymentAdmin.edc.methodsRequired");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const supportedMethods = [
      ...(supportsCard ? (["card"] as const) : []),
      ...(supportsQris ? (["qris"] as const) : []),
    ];
    const common: Omit<CreateEdcTerminalInput, "outletId" | "status"> = {
      bankCode,
      terminalId: terminalId.trim(),
      merchantId: merchantId.trim(),
      model: model.trim(),
      connection,
      ipAddress: ipAddress.trim() === "" ? null : ipAddress.trim(),
      supportedMethods,
    };
    const onError = (error: Error) => setErrors({ form: error.message });

    if (terminal) {
      const body: UpdateEdcTerminalInput = { ...common, status };
      const input = { terminalId: terminal.id, body };
      update.mutate(
        { ...input, idempotencyKey: attempt.keyFor(input) },
        {
          onSuccess: (result) => {
            attempt.settle();
            onSaved(result.data);
          },
          onError,
        },
      );
      return;
    }
    const body: CreateEdcTerminalInput = {
      ...common,
      outletId: outletId as OutletId,
      status,
    };
    create.mutate(
      { body, idempotencyKey: attempt.keyFor(body) },
      {
        onSuccess: (result) => {
          attempt.settle();
          onSaved(result.data);
        },
        onError,
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {terminal ? t("paymentAdmin.edc.edit") : t("paymentAdmin.edc.add")}
          </DialogTitle>
          <DialogDescription>{outletName}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("paymentAdmin.edc.bank")} required>
              <Select
                value={bankCode}
                onValueChange={(value) =>
                  setBankCode(value as EdcTerminalView["bankCode"])
                }
              >
                <SelectTrigger aria-label={t("paymentAdmin.edc.bank")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANKS.map((bank) => (
                    <SelectItem key={bank} value={bank}>
                      {t(bankLabelKey(bank))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("paymentAdmin.edc.terminalId")}
              required
              error={errors.terminalId}
            >
              <Input
                value={terminalId}
                onChange={(event) => setTerminalId(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("paymentAdmin.edc.merchantId")}
              required
              error={errors.merchantId}
            >
              <Input
                value={merchantId}
                onChange={(event) => setMerchantId(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("paymentAdmin.edc.model")}
              required
              error={errors.model}
            >
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </FormField>
            <FormField label={t("paymentAdmin.edc.connection")} required>
              <Select
                value={connection}
                onValueChange={(value) =>
                  setConnection(value as EdcTerminalView["connection"])
                }
              >
                <SelectTrigger aria-label={t("paymentAdmin.edc.connection")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["lan", "usb", "bluetooth"] as const).map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(connectionLabelKey(entry))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("paymentAdmin.edc.ipAddress")}>
              <Input
                value={ipAddress}
                onChange={(event) => setIpAddress(event.target.value)}
                inputMode="numeric"
              />
            </FormField>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.edc.methods")}
            </legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex min-h-control items-center gap-2">
                <Checkbox
                  checked={supportsCard}
                  onCheckedChange={(checked) =>
                    setSupportsCard(checked === true)
                  }
                />
                {t("paymentAdmin.edc.methodCard")}
              </label>
              <label className="flex min-h-control items-center gap-2">
                <Checkbox
                  checked={supportsQris}
                  onCheckedChange={(checked) =>
                    setSupportsQris(checked === true)
                  }
                />
                {t("paymentAdmin.edc.methodQris")}
              </label>
            </div>
            {errors.supportedMethods && (
              <p className="text-sm leading-5 font-medium text-danger">
                {errors.supportedMethods}
              </p>
            )}
          </fieldset>

          <FormField label={t("paymentAdmin.edc.status")} required>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as EdcTerminalView["status"])
              }
            >
              <SelectTrigger aria-label={t("paymentAdmin.edc.status")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">
                  {t("paymentAdmin.edc.active")}
                </SelectItem>
                <SelectItem value="inactive">
                  {t("paymentAdmin.edc.inactive")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          {errors.form && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {errors.form}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={pending}>
              {t("paymentAdmin.edc.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CashierDefaults({ outletId }: { outletId: string }) {
  const t = useT();
  const query = useEdcCashierDefaults(outletId);
  const rows = query.data?.data.cashiers ?? [];
  const terminals = query.data?.data.terminals ?? [];
  const state = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <DataTableShell
      title={t("paymentAdmin.edc.cashierTitle")}
      description={t("paymentAdmin.edc.cashierHint")}
      state={state}
      rowCount={rows.length}
      onRetry={() => void query.refetch()}
      empty={{
        title: t("paymentAdmin.edc.emptyTitle"),
        description: t("paymentAdmin.edc.emptyHint"),
      }}
    >
      <ul className="grid gap-2 p-card">
        {rows.map((cashier) => (
          <CashierRow
            key={`${cashier.id}:${cashier.updatedAt}`}
            cashier={cashier}
            outletId={outletId}
            terminals={terminals}
          />
        ))}
      </ul>
    </DataTableShell>
  );
}

function CashierRow({
  cashier,
  outletId,
  terminals,
}: {
  cashier: EdcCashierDefault;
  outletId: string;
  terminals: readonly EdcTerminalView[];
}) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateEdcCashierDefault();
  const attempt = useAttemptKey();
  const [method, setMethod] = React.useState<CashierDefaultMethod>(
    cashier.defaultMethod,
  );
  const [terminalId, setTerminalId] = React.useState<string | null>(
    cashier.terminalId,
  );
  const activeTerminals = terminals.filter(
    (terminal) => terminal.status === "active",
  );
  const needsTerminal = method !== "qris_doit";
  const changed =
    method !== cashier.defaultMethod || terminalId !== cashier.terminalId;

  const chooseMethod = (next: CashierDefaultMethod) => {
    setMethod(next);
    if (next === "qris_doit") {
      setTerminalId(null);
      return;
    }
    const need = next === "edc_card" ? "card" : "qris";
    const current = terminals.find((entry) => entry.id === terminalId);
    if (!current || !current.supportedMethods.includes(need)) {
      const fallback = activeTerminals.find((entry) =>
        entry.supportedMethods.includes(need),
      );
      setTerminalId(fallback?.id ?? null);
    }
  };

  const save = () => {
    if (needsTerminal && terminalId === null) {
      toast({ title: t("paymentAdmin.edc.terminalRequired"), tone: "danger" });
      return;
    }
    const body: UpdateEdcCashierDefaultInput = {
      outletId: outletId as OutletId,
      terminalId: needsTerminal ? terminalId : null,
      defaultMethod: method,
    };
    const input = { cashierId: cashier.cashierId, body };
    update.mutate(
      { ...input, idempotencyKey: attempt.keyFor(input) },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.edc.defaultSaved", {
              cashier: cashier.cashierName,
            }),
          });
        },
        onError: (error) => toast({ title: error.message, tone: "danger" }),
      },
    );
  };

  return (
    <li className="grid gap-3 rounded-lg border-(length:--border-w) p-card sm:grid-cols-[minmax(8rem,1fr)_12rem_minmax(10rem,16rem)_auto] sm:items-end">
      <p className="font-semibold sm:pb-2">{cashier.cashierName}</p>
      <FormField label={t("paymentAdmin.edc.defaultMethod")} required>
        <Select
          value={method}
          onValueChange={(value) => chooseMethod(value as CashierDefaultMethod)}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("paymentAdmin.edc.defaultMethod")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CASHIER_METHODS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(cashierMethodLabelKey(entry))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={t("paymentAdmin.edc.terminal")}
        required={needsTerminal}
        hint={needsTerminal ? undefined : t("paymentAdmin.edc.noTerminalHint")}
      >
        <Select
          value={terminalId ?? "none"}
          onValueChange={(value) =>
            setTerminalId(value === "none" ? null : value)
          }
          disabled={!needsTerminal}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("paymentAdmin.edc.terminal")}
          >
            <SelectValue placeholder={t("paymentAdmin.edc.noTerminal")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              {t("paymentAdmin.edc.noTerminal")}
            </SelectItem>
            {activeTerminals.map((terminal) => (
              <SelectItem key={terminal.id} value={terminal.id}>
                {t(bankLabelKey(terminal.bankCode))} · {terminal.terminalId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!changed}
        loading={update.isPending}
        onClick={save}
        className="justify-self-start sm:justify-self-end"
      >
        {t("common.save")}
      </Button>
    </li>
  );
}

function EdcSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-20" />
      <Skeleton className="h-48" />
    </div>
  );
}
