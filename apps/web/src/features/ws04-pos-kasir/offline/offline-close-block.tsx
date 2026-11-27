// O4 shift close refusal (bead legend-wasr7.8, mockup "tutup"; CTO O2 (a)):
// offline sales still on this tablet hold drawer cash the cloud does not
// count yet, so the drawer is not counted until the queue is empty. The cash
// figure is the tablet's own (Keputusan CTO O4 no. 4). A broken tablet is
// not a dead end: a supervisor force-closes from the shift approval screen.
import { useEffect, useState } from "react";
import { Link, useRouteContext } from "@tanstack/react-router";
import { formatRupiah } from "@starter/shared/i18n";
import type { PosOfflineKit } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { OfflineQueueSheet } from "./offline-queue-sheet";
import type { OfflineQueue } from "./queue";
import { cashOf } from "./sale-view";

export function OfflineCloseBlock({
  shiftId,
  pending,
  parked,
  queue,
  kit,
  online,
  syncNow,
}: {
  shiftId: string;
  pending: number;
  parked: number;
  queue:
    | (Pick<OfflineQueue, "pending" | "parked"> &
        Partial<Pick<OfflineQueue, "stuck" | "reportStuck">>)
    | null;
  kit: Pick<PosOfflineKit, "receiptRun"> | null;
  online: boolean;
  syncNow: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [cashIdr, setCashIdr] = useState<number | null>(null);
  useEffect(() => {
    if (!queue) return;
    let alive = true;
    Promise.all([
      queue.pending(),
      queue.parked().then((rows) => rows.map((row) => row.event)),
    ]).then(
      ([waiting, set]) => alive && setCashIdr(cashOf([...waiting, ...set])),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [queue, pending, parked]);
  return (
    <>
      <OfflineCloseBlockBody
        shiftId={shiftId}
        pending={pending}
        parked={parked}
        cashIdr={cashIdr}
        onOpenQueue={() => setOpen(true)}
      />
      <OfflineQueueSheet
        open={open}
        onOpenChange={setOpen}
        queue={queue}
        kit={kit}
        online={online}
        syncNow={syncNow}
      />
    </>
  );
}

/** The force close screen needs the same permission as the API route. */
function useCanForceClose(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? holdsAny(context.access, ["shift.cash.approve_close"])
    : false;
}

/**
 * Review K P1: the way to the force close screen of this shift. Only an
 * account with the permission gets the link; the others read why not, instead
 * of landing on a page that answers "not found".
 */
export function ForceCloseLink({ shiftId }: { shiftId: string }) {
  const t = useT();
  const allowed = useCanForceClose();
  if (!allowed)
    return (
      <p className="text-sm">
        {t("posKasirOffline.close.forceCloseNoPermission")}
      </p>
    );
  return (
    <Button asChild variant="outline" className="justify-self-start font-bold">
      <Link to="/pos/supervisor/shift/$shiftId" params={{ shiftId }}>
        {t("posKasirOffline.close.forceClose")}
      </Link>
    </Button>
  );
}

/** The server refused the close: this device does not hold the offline kit. */
export function OfflineUnverifiedNotice({ shiftId }: { shiftId: string }) {
  const t = useT();
  return (
    <Notice
      tone="warning"
      title={t("posKasirOffline.close.unverifiedTitle")}
      data-slot="pos-offline-close-unverified"
    >
      <div className="grid gap-2">
        <p>{t("posKasirOffline.close.unverifiedBody")}</p>
        <ForceCloseLink shiftId={shiftId} />
      </div>
    </Notice>
  );
}

export function OfflineCloseBlockBody({
  shiftId,
  pending,
  parked,
  cashIdr,
  onOpenQueue,
}: {
  shiftId: string;
  pending: number;
  parked: number;
  cashIdr: number | null;
  onOpenQueue: () => void;
}) {
  const t = useT();
  return (
    <Notice
      tone="danger"
      title={t("posKasirOffline.close.title")}
      data-slot="pos-offline-close-block"
    >
      <div className="grid gap-2">
        <p>{t("posKasirOffline.close.body", { count: pending })}</p>
        {parked > 0 && (
          <p>{t("posKasirOffline.close.parked", { count: parked })}</p>
        )}
        {cashIdr !== null && cashIdr > 0 && (
          <p className="font-bold">
            {t("posKasirOffline.close.cash", { amount: formatRupiah(cashIdr) })}
          </p>
        )}
        <Button
          type="button"
          onClick={onOpenQueue}
          className="justify-self-start font-bold"
        >
          {t("posKasirOffline.close.openQueue")}
        </Button>
        <p className="text-sm">{t("posKasirOffline.close.forceHint")}</p>
        <ForceCloseLink shiftId={shiftId} />
      </div>
    </Notice>
  );
}
