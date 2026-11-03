// One fixed asset in a sheet: carrying amounts, the full straight-line
// schedule, and the two lifecycle actions the contract exposes (PRD v1.7
// §3.19 "Aset Tetap [P0] — … revaluasi, dan penjualan aset"). Revaluation and
// disposal replace the view inside the same dialog so the list stays behind it.
import * as React from "react";
import { PencilLine, Scale, TriangleAlert } from "lucide-react";
import type { FixedAsset } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  businessDateToday,
  formatBusinessDate,
  formatPeriod,
} from "@/features/ws07-accounting/lib";
import {
  useDisposeFixedAsset,
  useFixedAssetDetail,
  useRevalueFixedAsset,
} from "../hooks";
import {
  assetBookValueIdr,
  assetCode,
  disposedResultIdr,
  disposalPreviewIdr,
  parseAmountInput,
} from "../lib";
import { AssetStatusBadge } from "./status-badge";

type Mode = "view" | "revalue" | "dispose";

export function FixedAssetDetailDialog({
  open,
  onOpenChange,
  fixedAssetId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fixedAssetId: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <AssetDetail fixedAssetId={fixedAssetId} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function AssetDetail({
  fixedAssetId,
  onOpenChange,
}: {
  fixedAssetId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const detailQuery = useFixedAssetDetail(fixedAssetId ?? undefined);
  const [mode, setMode] = React.useState<Mode>("view");
  const asset = detailQuery.data?.asset;

  if (detailQuery.isPending)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("accounting.ap.assets.detail.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </>
    );
  if (detailQuery.isError || !asset)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("accounting.ap.assets.detail.title")}</DialogTitle>
        </DialogHeader>
        <ErrorState
          onRetry={() => {
            void detailQuery.refetch();
          }}
        />
      </>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{asset.name}</DialogTitle>
        <DialogDescription>
          {assetCode(asset)} ·{" "}
          {t("accounting.ap.assets.detail.methodStraightLine")}
        </DialogDescription>
      </DialogHeader>
      {mode === "view" && (
        <AssetView
          asset={asset}
          schedule={detailQuery.data?.schedule ?? []}
          onRevalue={() => setMode("revalue")}
          onDispose={() => setMode("dispose")}
          onClose={() => onOpenChange(false)}
        />
      )}
      {mode === "revalue" && (
        <RevalueForm asset={asset} onCancel={() => setMode("view")} />
      )}
      {mode === "dispose" && (
        <DisposeForm asset={asset} onCancel={() => setMode("view")} />
      )}
    </>
  );
}

function AssetView({
  asset,
  schedule,
  onRevalue,
  onDispose,
  onClose,
}: {
  asset: FixedAsset;
  schedule: readonly { period: string; amountIdr: number }[];
  onRevalue: () => void;
  onDispose: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const disposed = asset.status === "disposed";
  const result = disposedResultIdr(asset);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <AssetStatusBadge status={asset.status} />
        {result !== null && (
          <Badge tone={result >= 0 ? "success" : "danger"}>
            <Scale aria-hidden="true" />
            {result >= 0
              ? t("accounting.ap.assets.detail.gain")
              : t("accounting.ap.assets.detail.loss")}
          </Badge>
        )}
      </div>
      <dl className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-card sm:grid-cols-2 lg:grid-cols-3">
        <AssetField
          label={t("accounting.ap.assets.detail.acquiredOn")}
          value={formatBusinessDate(asset.acquiredOn)}
        />
        <AssetField
          label={t("accounting.ap.assets.detail.cost")}
          value={<Money amount={asset.costIdr} />}
        />
        <AssetField
          label={t("accounting.ap.assets.detail.residual")}
          value={<Money amount={asset.residualValueIdr} />}
        />
        <AssetField
          label={t("accounting.ap.assets.detail.accumulated")}
          value={<Money amount={asset.accumulatedDepreciationIdr} />}
        />
        <AssetField
          label={t("accounting.ap.assets.detail.bookValue")}
          value={
            <Money
              amount={assetBookValueIdr(asset)}
              className="font-semibold"
            />
          }
        />
        <AssetField
          label={t("accounting.ap.assets.detail.usefulLife")}
          value={t("accounting.ap.assets.detail.usefulLifeValue", {
            months: asset.usefulLifeMonths,
          })}
        />
        <AssetField
          label={t("accounting.ap.assets.detail.startPeriod")}
          value={formatPeriod(asset.depreciationStartPeriod)}
        />
        {disposed && (
          <>
            <AssetField
              label={t("accounting.ap.assets.detail.disposedOn")}
              value={
                asset.disposedOn ? formatBusinessDate(asset.disposedOn) : "—"
              }
            />
            <AssetField
              label={t("accounting.ap.assets.detail.proceeds")}
              value={<Money amount={asset.disposalProceedsIdr ?? 0} />}
            />
            <AssetField
              label={t("accounting.ap.assets.detail.result")}
              value={<Money amount={result ?? 0} />}
            />
          </>
        )}
      </dl>
      <section className="grid gap-2">
        <div className="grid gap-0.5">
          <h3 className="type-heading">
            {t("accounting.ap.assets.detail.schedule")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.ap.assets.detail.scheduleHint")}
          </p>
        </div>
        {schedule.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("accounting.ap.assets.detail.scheduleEmpty")}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-container border-(length:--border-w)">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("accounting.ap.assets.detail.schedulePeriod")}
                  </TableHead>
                  <TableHead numeric>
                    {t("accounting.ap.assets.detail.scheduleAmount")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedule.map((row) => (
                  <TableRow key={row.period}>
                    <TableCell className="tabular">
                      {formatPeriod(row.period)}
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={row.amountIdr} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disposed}
          onClick={onRevalue}
        >
          <PencilLine aria-hidden="true" />
          {t("accounting.ap.assets.detail.revalue")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={disposed}
          onClick={onDispose}
        >
          <TriangleAlert aria-hidden="true" />
          {t("accounting.ap.assets.detail.dispose")}
        </Button>
      </DialogFooter>
    </>
  );
}

function AssetField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs leading-4 text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function RevalueForm({
  asset,
  onCancel,
}: {
  asset: FixedAsset;
  onCancel: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const revalue = useRevalueFixedAsset();
  const [carrying, setCarrying] = React.useState(() =>
    String(assetBookValueIdr(asset)),
  );
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<{
    carrying?: string;
    reason?: string;
  }>({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const submit = async () => {
    setServerError(null);
    const nextErrors: typeof errors = {};
    const newCarryingAmountIdr =
      carrying.trim() === "" ? null : parseAmountInput(carrying);
    if (
      newCarryingAmountIdr === null ||
      newCarryingAmountIdr < asset.residualValueIdr ||
      newCarryingAmountIdr > asset.costIdr
    )
      nextErrors.carrying = t("accounting.ap.assets.revalue.invalid");
    if (reason.trim() === "")
      nextErrors.reason = t("accounting.ap.assets.revalue.reasonRequired");
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    try {
      await revalue.mutateAsync({
        fixedAssetId: asset.id,
        body: {
          revaluedOn: businessDateToday(),
          newCarryingAmountIdr: newCarryingAmountIdr as number,
          reason: reason.trim(),
        },
      });
      toast({ title: t("accounting.ap.assets.revalue.saved") });
      onCancel();
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("state.errorTitle"),
      );
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.ap.assets.revalue.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.ap.assets.revalue.hint")}
        </p>
      </div>
      <FormField
        label={t("accounting.ap.assets.revalue.newCarrying")}
        error={errors.carrying}
        required
      >
        <Input
          value={carrying}
          onChange={(event) => setCarrying(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          className="tabular"
        />
      </FormField>
      <FormField
        label={t("accounting.ap.assets.revalue.reason")}
        error={errors.reason}
        required
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={200}
        />
      </FormField>
      {serverError && (
        <p
          role="alert"
          className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
        >
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={revalue.isPending}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={revalue.isPending}>
          {t("accounting.ap.assets.revalue.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DisposeForm({
  asset,
  onCancel,
}: {
  asset: FixedAsset;
  onCancel: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const dispose = useDisposeFixedAsset();
  const today = React.useMemo(() => businessDateToday(), []);
  const [disposedOn, setDisposedOn] = React.useState(today);
  const [proceeds, setProceeds] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<{
    proceeds?: string;
    reason?: string;
  }>({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const proceedsIdr =
    proceeds.trim() === "" ? null : parseAmountInput(proceeds);
  const preview =
    proceedsIdr === null ? null : disposalPreviewIdr(asset, proceedsIdr);

  const submit = async () => {
    setServerError(null);
    const nextErrors: typeof errors = {};
    if (proceedsIdr === null)
      nextErrors.proceeds = t("accounting.ap.budgets.dialog.amountInvalid");
    if (reason.trim() === "")
      nextErrors.reason = t("accounting.ap.assets.dispose.reasonRequired");
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    try {
      await dispose.mutateAsync({
        fixedAssetId: asset.id,
        body: {
          disposedOn,
          proceedsIdr: proceedsIdr as number,
          reason: reason.trim(),
        },
      });
      toast({ title: t("accounting.ap.assets.dispose.saved") });
      onCancel();
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("state.errorTitle"),
      );
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1">
        <h3 className="type-heading">
          {t("accounting.ap.assets.dispose.title")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("accounting.ap.assets.dispose.hint")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("accounting.ap.assets.dispose.date")} required>
          <Input
            type="date"
            value={disposedOn}
            onChange={(event) => setDisposedOn(event.target.value)}
            className="tabular"
          />
        </FormField>
        <FormField
          label={t("accounting.ap.assets.dispose.proceeds")}
          error={errors.proceeds}
          required
        >
          <Input
            value={proceeds}
            onChange={(event) => setProceeds(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
          />
        </FormField>
      </div>
      {preview !== null && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3">
          <span className="text-sm font-medium">
            {t("accounting.ap.assets.dispose.preview")}
          </span>
          <span className="flex items-center gap-2">
            <Badge tone={preview >= 0 ? "success" : "danger"}>
              {preview >= 0
                ? t("accounting.ap.assets.dispose.gain")
                : t("accounting.ap.assets.dispose.loss")}
            </Badge>
            <Money amount={Math.abs(preview)} />
          </span>
        </div>
      )}
      <FormField
        label={t("accounting.ap.assets.dispose.reason")}
        error={errors.reason}
        required
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={200}
        />
      </FormField>
      {serverError && (
        <p
          role="alert"
          className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
        >
          {serverError}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={dispose.isPending}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="destructive" loading={dispose.isPending}>
          {t("accounting.ap.assets.dispose.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
