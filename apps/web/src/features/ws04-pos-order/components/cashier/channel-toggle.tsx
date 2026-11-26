import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useCaptainTables,
  useNextCallNumber,
} from "@/features/ws04-pos-order/hooks";
import type {
  CaptainTable,
  OjolPlatform,
  SaleChannel,
} from "@/features/ws04-pos-order/types";

const CHANNELS: readonly { value: SaleChannel; key: MessageKey }[] = [
  { value: "dine_in", key: "posOrderCart.channel.dineIn" },
  { value: "takeaway", key: "posOrderCart.channel.takeaway" },
  { value: "ojol_manual", key: "posOrderCart.channel.ojol" },
];

const PLATFORMS: readonly { value: OjolPlatform; key: MessageKey }[] = [
  { value: "gofood", key: "posOrderCart.ojol.gofood" },
  { value: "grabfood", key: "posOrderCart.ojol.grabfood" },
  { value: "shopeefood", key: "posOrderCart.ojol.shopeefood" },
];

const choiceClass =
  "min-h-control-lg flex-1 px-2 text-center text-sm leading-tight whitespace-normal";

// Dine-in, takeaway or manual online/ojol: three equal choices, the selected
// one filled and bordered in ink (state is also exposed as aria-pressed).
export function ChannelToggle({
  value,
  onChange,
  only,
}: {
  value: SaleChannel;
  onChange: (channel: SaleChannel) => void;
  /** O4: offline sells dine-in and takeaway only. */
  only?: readonly SaleChannel[];
}) {
  const t = useT();
  const channels = only
    ? CHANNELS.filter((channel) => only.includes(channel.value))
    : CHANNELS;
  return (
    <div
      role="group"
      aria-label={t("posOrderCart.channel.label")}
      className={cn(
        "grid gap-1.5",
        channels.length === 2 ? "grid-cols-2" : "grid-cols-3",
      )}
    >
      {channels.map((channel) => (
        <Button
          key={channel.value}
          type="button"
          variant="outline"
          aria-pressed={value === channel.value}
          onClick={() => onChange(channel.value)}
          className={cn(
            choiceClass,
            channel.value === "dine_in" && "whitespace-nowrap",
            value === channel.value &&
              "border-foreground bg-surface-2 not-aria-disabled:hover:bg-surface-2",
          )}
        >
          {t(channel.key)}
        </Button>
      ))}
    </div>
  );
}

export type ChannelDetailError = "table" | "ojolPlatform" | "ojolRef" | null;

// The row under the toggle: the table (dine-in), the call number (takeaway) or
// the platform and its order number (online/ojol manual).
export function ChannelDetail({
  channel,
  tableLabel,
  onTableChange,
  ojolPlatform,
  onOjolPlatformChange,
  ojolRef,
  onOjolRefChange,
  error,
  focusToken,
}: {
  channel: SaleChannel;
  tableLabel: string | null;
  onTableChange: (table: { label: string; sessionId: string }) => void;
  ojolPlatform: OjolPlatform | null;
  onOjolPlatformChange: (platform: OjolPlatform) => void;
  ojolRef: string;
  onOjolRefChange: (value: string) => void;
  error: ChannelDetailError;
  /** Changes on every failed "Lanjutkan", so the same error focuses again. */
  focusToken: number;
}) {
  const t = useT();
  const refId = useId();
  const tableRef = useRef<HTMLButtonElement>(null);
  const platformRef = useRef<HTMLButtonElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const messageId = `${refId}-message`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const callNumber = useNextCallNumber(channel === "takeaway");

  // A validation error moves focus to the first field that has one.
  useEffect(() => {
    if (!error) return;
    const target =
      error === "table"
        ? tableRef.current
        : error === "ojolPlatform"
          ? platformRef.current
          : refInputRef.current;
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [error, focusToken]);

  const rowClass =
    "flex min-h-control-lg w-full items-center justify-between gap-3 rounded-control border-(length:--border-w) border-border bg-card px-3 text-left text-(length:--density-text) font-semibold";

  if (channel === "takeaway") {
    return (
      <div className={rowClass}>
        <span>{t("posOrderCart.call.label")}</span>
        {callNumber.isPending ? (
          <>
            <Skeleton className="h-6 w-16" />
            <span className="sr-only">{t("posOrderCart.call.loading")}</span>
          </>
        ) : callNumber.isError ? (
          <span className="text-muted-foreground">
            {t("posOrderCart.call.unavailable")}
          </span>
        ) : (
          <span className="tabular">{callNumber.data}</span>
        )}
      </div>
    );
  }

  if (channel === "ojol_manual") {
    const message =
      error === "ojolPlatform"
        ? t("posOrderCart.validation.ojolPlatform")
        : error === "ojolRef"
          ? t("posOrderCart.validation.ojolRef")
          : null;
    return (
      <div className="grid gap-2">
        <div
          role="group"
          aria-label={t("posOrderCart.ojol.platform")}
          className="grid grid-cols-3 gap-1.5"
        >
          {PLATFORMS.map((platform, index) => (
            <Button
              key={platform.value}
              ref={index === 0 ? platformRef : undefined}
              type="button"
              variant="outline"
              aria-pressed={ojolPlatform === platform.value}
              onClick={() => onOjolPlatformChange(platform.value)}
              className={cn(
                choiceClass,
                ojolPlatform === platform.value &&
                  "border-foreground bg-surface-2 not-aria-disabled:hover:bg-surface-2",
              )}
            >
              {t(platform.key)}
            </Button>
          ))}
        </div>
        <div className="grid gap-1">
          <label
            htmlFor={refId}
            className="text-sm font-semibold text-muted-foreground"
          >
            {t("posOrderCart.ojol.refLabel")}
          </label>
          <Input
            id={refId}
            ref={refInputRef}
            value={ojolRef}
            onChange={(event) => onOjolRefChange(event.target.value)}
            placeholder={t("posOrderCart.ojol.refPlaceholder")}
            autoComplete="off"
            maxLength={64}
            aria-invalid={error === "ojolRef" ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            className="h-control-lg"
          />
        </div>
        {message && (
          <p
            id={messageId}
            role="alert"
            className="text-base font-semibold text-danger"
          >
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <button
        ref={tableRef}
        type="button"
        onClick={() => setPickerOpen(true)}
        aria-invalid={error === "table" ? true : undefined}
        aria-describedby={error === "table" ? messageId : undefined}
        className={cn(
          rowClass,
          "pressable hover:bg-surface-2",
          error === "table" && "border-danger",
        )}
      >
        <span>
          {tableLabel
            ? t("posOrderCart.table.value", { label: tableLabel })
            : t("posOrderCart.table.none")}
        </span>
        <span>
          {tableLabel
            ? t("posOrderCart.table.change")
            : t("posOrderCart.table.choose")}
        </span>
      </button>
      {error === "table" && (
        <p
          id={messageId}
          role="alert"
          className="text-base font-semibold text-danger"
        >
          {t("posOrderCart.validation.table")}
        </p>
      )}
      <TablePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selected={tableLabel}
        onPick={(table) => {
          onTableChange(table);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

function TablePickerDialog({
  open,
  onOpenChange,
  selected,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: string | null;
  onPick: (table: { label: string; sessionId: string }) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-density="kontras" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("posOrderCart.table.title")}</DialogTitle>
          <DialogDescription>
            {t("posOrderCart.table.description")}
          </DialogDescription>
        </DialogHeader>
        {open && <TableList selected={selected} onPick={onPick} />}
      </DialogContent>
    </Dialog>
  );
}

// Only mounted while the dialog is open, so the query runs on demand.
function TableList({
  selected,
  onPick,
}: {
  selected: string | null;
  onPick: (table: { label: string; sessionId: string }) => void;
}) {
  const t = useT();
  const tables = useCaptainTables();

  if (tables.isPending) {
    return (
      <div aria-busy="true" className="grid grid-cols-2 gap-2">
        <span className="sr-only">{t("posOrderCart.table.loading")}</span>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-control" />
        ))}
      </div>
    );
  }

  if (!tables.data) {
    return (
      <div className="grid gap-3">
        <Notice
          tone="danger"
          title={
            isContractPending(tables.error)
              ? t("posOrderCart.error.pendingTitle")
              : t("posOrderCart.table.error")
          }
        />
        {!isContractPending(tables.error) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => tables.refetch()}
          >
            {t("posOrderCart.error.retry")}
          </Button>
        )}
      </div>
    );
  }

  if (tables.data.length === 0) {
    return (
      <Notice tone="info" title={t("posOrderCart.table.emptyTitle")}>
        {t("posOrderCart.table.emptyDescription")}
      </Notice>
    );
  }

  return (
    <div className="grid gap-3">
      {tables.isError && (
        <Notice tone="warning" title={t("posOrderCart.table.refreshFailed")} />
      )}
      <ul className="grid max-h-[60dvh] grid-cols-2 gap-2 overflow-y-auto">
        {tables.data.map((table) => (
          <li key={table.id}>
            <TableChoice
              table={table}
              selected={selected === table.label}
              onPick={onPick}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableChoice({
  table,
  selected,
  onPick,
}: {
  table: CaptainTable;
  selected: boolean;
  onPick: (table: { label: string; sessionId: string }) => void;
}) {
  const t = useT();
  // An order goes onto the table's open session. A table nobody sits at has
  // none yet (seating a walk-in is on the captain screen), so it cannot be
  // chosen here.
  const sessionId = table.sessionId;
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      disabled={sessionId === null}
      onClick={() => {
        if (sessionId !== null) onPick({ label: table.label, sessionId });
      }}
      className={cn(
        "h-auto min-h-control-lg w-full flex-col items-start gap-0 py-2 text-left",
        selected &&
          "border-foreground bg-surface-2 not-aria-disabled:hover:bg-surface-2",
      )}
    >
      <span>{t("posOrderCart.table.value", { label: table.label })}</span>
      <span className="text-sm font-normal text-muted-foreground">
        {sessionId === null
          ? t("posOrderCart.table.noSession")
          : t("posOrderCart.table.occupied", { count: table.guestCount })}
      </span>
    </Button>
  );
}
