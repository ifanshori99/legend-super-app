// Petty (cash) purchases (PRD v1.7 §3.18 "Pembelian Sederhana", "batas
// nominal"): a photo is mandatory, the per-transaction limit comes from
// `getPettyPurchasePolicy` and is shown before typing, and an over-limit amount
// is blocked both in the form and by the server code
// `PETTY_PURCHASE_LIMIT_EXCEEDED`.
//
// The contract has no category column and no photo upload endpoint: the
// description carries the purpose, and the picked photo stays a data URL in
// local state while only a media id is sent (reported storage gap).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { MediaPlate } from "@/components/ui/media-plate";
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
import { ApiError } from "@/lib/api/errors";
import type { BusinessDate, Idr } from "@starter/shared/core";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import { usePettyCashFunds } from "@/features/ws07-cash-bank/hooks";
import { PhotoField } from "../../ws06-inventory/components/photo-field.tsx";
import {
  WASTE_PHOTO_MAX_BYTES,
  WASTE_PHOTO_TYPES,
} from "../../ws06-inventory/components/photo-field.tsx";
import {
  useAttemptKey,
  useCreatePettyPurchase,
  usePettyPurchasePolicy,
  usePettyPurchases,
} from "../receiving-hooks.ts";
import {
  amountFromInput,
  formatBusinessDate,
  formatIdrText,
  pettySpentOn,
  receivingErrorKey,
  todayBusinessDate,
} from "../receiving-lib.ts";
import { ReceivingOfflineNote } from "./receiving-offline-note.tsx";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type PhotoDraft = { previewUrl: string; mediaId: string };

function PettyFormDialog({
  limitIdr,
  todayTotal,
  today,
  onClose,
}: {
  limitIdr: Idr | null;
  todayTotal: Idr | null;
  today: BusinessDate | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const attempt = useAttemptKey();
  const { outlet } = useTenantContext();
  const createPurchase = useCreatePettyPurchase();
  const [vendor, setVendor] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [photo, setPhoto] = React.useState<PhotoDraft | null>(null);
  const [photoError, setPhotoError] = React.useState<string | undefined>();
  const [vendorError, setVendorError] = React.useState<string | undefined>();
  const [descriptionError, setDescriptionError] = React.useState<
    string | undefined
  >();
  const [amountError, setAmountError] = React.useState<string | undefined>();
  const [formError, setFormError] = React.useState<string | undefined>();
  const paidAtRef = React.useRef<string | null>(null);

  const parsedAmount = amountFromInput(amount);
  const overLimit =
    limitIdr !== null && parsedAmount !== null && parsedAmount > limitIdr;

  function selectPhoto(file: File) {
    setPhotoError(undefined);
    if (!WASTE_PHOTO_TYPES.includes(file.type)) {
      setPhotoError(t("inventoryReceiving.receiving.form.photoInvalid"));
      return;
    }
    if (file.size > WASTE_PHOTO_MAX_BYTES) {
      setPhotoError(t("inventoryReceiving.receiving.form.photoTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setPhoto({ previewUrl: reader.result, mediaId: newIdempotencyKey() });
    };
    reader.onerror = () =>
      setPhotoError(t("inventoryReceiving.receiving.form.photoInvalid"));
    reader.readAsDataURL(file);
  }

  function submit() {
    if (!outlet) return;
    let invalid = false;
    setVendorError(undefined);
    setDescriptionError(undefined);
    setAmountError(undefined);
    setFormError(undefined);
    if (vendor.trim() === "") {
      setVendorError(t("inventoryReceiving.petty.errorVendor"));
      invalid = true;
    }
    if (description.trim() === "") {
      setDescriptionError(t("inventoryReceiving.petty.errorDescription"));
      invalid = true;
    }
    if (parsedAmount === null) {
      setAmountError(t("inventoryReceiving.petty.errorAmount"));
      invalid = true;
    } else if (limitIdr === null) {
      setAmountError(
        t("inventoryReceiving.petty.errorOverLimit", {
          limit: t("inventoryReceiving.petty.noPolicy"),
        }),
      );
      invalid = true;
    } else if (parsedAmount > limitIdr) {
      setAmountError(
        t("inventoryReceiving.petty.errorOverLimit", {
          limit: formatIdrText(limitIdr),
        }),
      );
      invalid = true;
    }
    if (!photo) {
      setPhotoError(t("inventoryReceiving.petty.errorPhoto"));
      invalid = true;
    }
    if (invalid) return;
    if (!photo || parsedAmount === null || today === null) return;
    // One paid-at per attempt: a retry must send the same payload to reuse the
    // idempotency key instead of booking the spend twice.
    paidAtRef.current ??= new Date().toISOString();
    const payload = {
      outletId: outlet.id,
      vendorName: vendor.trim(),
      description: description.trim(),
      amountIdr: parsedAmount,
      photoMediaId: photo.mediaId,
      paidAt: paidAtRef.current,
      businessDate: today,
      note: note.trim() === "" ? null : note.trim(),
    };
    createPurchase.mutate(
      { ...payload, idempotencyKey: attempt.keyFor(payload) },
      {
        onSuccess: () => {
          attempt.settle();
          paidAtRef.current = null;
          toast({
            title: t("inventoryReceiving.petty.created"),
            tone: "success",
          });
          onClose();
        },
        onError: (error) =>
          setFormError(
            t(
              receivingErrorKey(
                error instanceof ApiError ? error.code : undefined,
              ),
            ),
          ),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("inventoryReceiving.petty.formTitle")}</DialogTitle>
          <DialogDescription>
            {t("inventoryReceiving.petty.formSubtitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 rounded-container bg-surface-2 p-card text-sm">
          <p className="font-semibold">
            {t("inventoryReceiving.petty.policyTitle")}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {t("inventoryReceiving.petty.limit")}:{" "}
              {limitIdr === null ? (
                t("inventoryReceiving.petty.noPolicy")
              ) : (
                <Money amount={limitIdr} />
              )}
            </span>
            {todayTotal !== null && limitIdr !== null && (
              <span className="text-muted-foreground">
                {t("inventoryReceiving.petty.todayTotalHint", {
                  total: formatIdrText(todayTotal),
                  limit: formatIdrText(limitIdr),
                })}
              </span>
            )}
          </div>
          <p className="text-muted-foreground">
            {t("inventoryReceiving.petty.policyHint")}
          </p>
        </div>
        <div className="grid min-w-0 gap-4">
          <PhotoField
            label={t("inventoryReceiving.petty.photoSection")}
            hint={t("inventoryReceiving.petty.photoHint")}
            previewUrl={photo?.previewUrl ?? null}
            error={photoError}
            onSelect={selectPhoto}
            onClear={() => {
              setPhoto(null);
              setPhotoError(undefined);
            }}
          />
          <FormField
            label={t("inventoryReceiving.petty.vendorName")}
            hint={t("inventoryReceiving.petty.vendorHint")}
            error={vendorError}
            required
          >
            <Input
              value={vendor}
              onChange={(event) => {
                setVendor(event.target.value);
                setVendorError(undefined);
              }}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("inventoryReceiving.petty.description")}
            hint={t("inventoryReceiving.petty.descriptionHint")}
            error={descriptionError}
            required
          >
            <Input
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setDescriptionError(undefined);
              }}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("inventoryReceiving.petty.amount")}
            error={
              amountError ??
              (overLimit && limitIdr !== null
                ? t("inventoryReceiving.petty.errorOverLimit", {
                    limit: formatIdrText(limitIdr),
                  })
                : undefined)
            }
            required
          >
            <Input
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setAmountError(undefined);
              }}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={overLimit || undefined}
            />
          </FormField>
          <FormField label={t("inventoryReceiving.petty.note")}>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
            />
          </FormField>
          {formError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("inventoryReceiving.common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={submit}
              loading={createPurchase.isPending}
              disabled={overLimit || limitIdr === null}
            >
              <Wallet aria-hidden="true" />
              {t("inventoryReceiving.petty.submit")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh page, so an
 * open form or search of the previous outlet cannot leak.
 */
export function PettyPage({ canCreate }: { canCreate: boolean }) {
  const { outlet } = useTenantContext();
  return <PettyContent key={outlet?.id ?? "none"} canCreate={canCreate} />;
}

function PettyContent({ canCreate }: { canCreate: boolean }) {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? "";
  const purchases = usePettyPurchases(outletId);
  const policy = usePettyPurchasePolicy(outletId);
  // Deny by default (legend petty fund): no fund row for this outlet means the
  // server refuses the purchase, so say so up front. Shown only once the funds
  // loaded; a failed lookup keeps the server error as the fallback.
  const outlets = useOutlets();
  const entityId = outlets.data?.find((o) => o.id === outletId)?.legalEntityId;
  const funds = usePettyCashFunds(entityId);
  const noFund =
    Boolean(outletId) &&
    Boolean(entityId) &&
    funds.isSuccess &&
    !funds.data.some((fund) => fund.outletId === outletId);
  const [formOpen, setFormOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [today] = React.useState<BusinessDate>(() => todayBusinessDate());

  // Deny by default (contract `assertPettyPurchaseWithinLimit`): a missing
  // policy row answers NOT_FOUND, which is the "no limit configured" state, not
  // a load failure that would also hide the purchase history.
  const noPolicy =
    policy.error instanceof ApiError && policy.error.code === "NOT_FOUND";
  const policyFailed = policy.isError && !noPolicy;
  const limitIdr = policy.data?.data.limitIdr ?? null;
  const spent = pettySpentOn(purchases.data?.data ?? [], today);
  const rows = React.useMemo(
    () =>
      (purchases.data?.data ?? []).filter((purchase) => {
        const needle = search.trim().toLocaleLowerCase("id-ID");
        if (needle === "") return true;
        return [purchase.vendorName, purchase.description].some((value) =>
          value.toLocaleLowerCase("id-ID").includes(needle),
        );
      }),
    [purchases.data, search],
  );

  const loading =
    Boolean(outletId) && (purchases.isPending || policy.isPending);
  const failed = purchases.isError || policyFailed;
  const state: DataState = loading
    ? "loading"
    : failed
      ? "error"
      : (purchases.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-4">
      <ReceivingOfflineNote />
      <Card className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="type-title">
              {t("inventoryReceiving.petty.policyTitle")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryReceiving.petty.policyHint")}
            </p>
          </div>
          {canCreate && (
            <Button onClick={() => setFormOpen(true)}>
              <Wallet aria-hidden="true" />
              {t("inventoryReceiving.petty.newPurchase")}
            </Button>
          )}
        </div>
        {noFund && (
          <p role="status" className="text-sm leading-5 text-muted-foreground">
            {t("inventoryReceiving.petty.noFund")}{" "}
            <Link
              to="/kelola/akuntansi/kas-bank"
              className="font-medium text-primary underline underline-offset-4"
            >
              {t("inventoryReceiving.petty.noFundLink")}
            </Link>
          </p>
        )}
        {policy.isPending ? (
          <Skeleton className="h-12" />
        ) : policyFailed ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("inventoryReceiving.errors.load")}
          </p>
        ) : limitIdr === null ? (
          <EmptyState
            icon={Wallet}
            title={t("inventoryReceiving.petty.noPolicy")}
            description={t("inventoryReceiving.petty.noPolicyHint")}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="type-eyebrow">
                {t("inventoryReceiving.petty.limit")}
              </p>
              <Money amount={limitIdr} size="lg" />
            </div>
            <div>
              <p className="type-eyebrow">
                {t("inventoryReceiving.petty.todayTotal")}
              </p>
              <Money amount={spent} size="lg" />
            </div>
          </div>
        )}
      </Card>

      <DataTableShell
        title={t("inventoryReceiving.petty.listTitle")}
        description={t("inventoryReceiving.petty.listDescription")}
        state={state}
        error={purchases.error ?? policy.error}
        onRetry={() => {
          void purchases.refetch();
          void policy.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("common.search"),
        }}
        empty={{
          title: t("inventoryReceiving.petty.emptyTitle"),
          description: t("inventoryReceiving.petty.emptyHint"),
          action: canCreate ? (
            <Button variant="outline" onClick={() => setFormOpen(true)}>
              {t("inventoryReceiving.petty.newPurchase")}
            </Button>
          ) : null,
        }}
        noResults={rows.length === 0 && (purchases.data?.data.length ?? 0) > 0}
        rowCount={rows.length}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventoryReceiving.petty.columns.date")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.petty.columns.vendor")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.petty.columns.description")}
                </TableHead>
                <TableHead numeric>
                  {t("inventoryReceiving.petty.columns.amount")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.petty.columns.photo")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.petty.columns.limit")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((purchase) => (
                <TableRow key={purchase.id}>
                  <TableCell>
                    {formatBusinessDate(purchase.businessDate)}
                  </TableCell>
                  <TableCell className="font-medium">
                    {purchase.vendorName}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span className="line-clamp-2">{purchase.description}</span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={purchase.amountIdr} />
                  </TableCell>
                  <TableCell>
                    <MediaPlate
                      alt={purchase.description}
                      ratio="card"
                      missing="quiet"
                      className="w-10 rounded-md"
                    />
                  </TableCell>
                  <TableCell>
                    {limitIdr === null ? (
                      "—"
                    ) : purchase.amountIdr > limitIdr ? (
                      <StatusPill status="danger">
                        {t("inventoryReceiving.petty.overLimit")}
                      </StatusPill>
                    ) : (
                      <StatusPill status="success">
                        {t("inventoryReceiving.petty.withinLimit")}
                      </StatusPill>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>

      {formOpen && (
        <PettyFormDialog
          limitIdr={limitIdr}
          todayTotal={spent}
          today={today}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
