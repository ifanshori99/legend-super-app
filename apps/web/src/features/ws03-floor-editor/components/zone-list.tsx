// Zone list of the floor editor: every zone with its pay mode, service charge,
// minimum spend and opening hours (PRD §3 F9 "Zona"), plus the edit and delete
// actions. Deleting is confirmed, and the API refuses a zone that still holds
// tables.
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { FloorZone, Table } from "@starter/shared/qr-order";
import type { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import {
  Table as TableView,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useDeleteZone } from "../hooks";
import { DAY_LABEL_KEYS, describeZoneHours } from "../lib";
import { ConfirmDialog } from "./confirm-dialog";

type Props = {
  zones: FloorZone[];
  tables: Table[];
  state: DataState;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (zone: FloorZone) => void;
};

function ZoneList({ zones, tables, state, onRetry, onCreate, onEdit }: Props) {
  const t = useT();
  const toast = useToast();
  const deleteZone = useDeleteZone();
  const [deleting, setDeleting] = React.useState<FloorZone | null>(null);
  const [deleteError, setDeleteError] = React.useState<ApiError | null>(null);

  const dayLabels = React.useMemo(
    () => DAY_LABEL_KEYS.map((key) => t(key)),
    [t],
  );
  const hoursLabel = (zone: FloorZone) =>
    describeZoneHours(zone.hours, {
      days: dayLabels,
      everyDay: t("floorEditor.hoursEveryDay"),
      more: t("floorEditor.hoursMore"),
    });

  const confirmDelete = () => {
    if (!deleting) return;
    setDeleteError(null);
    deleteZone.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("floorEditor.formDeleted"), tone: "success" });
        setDeleting(null);
      },
      onError: (error: Error) => setDeleteError(error as ApiError),
    });
  };

  return (
    <>
      <DataTableShell
        title={t("floorEditor.zonesTitle")}
        state={state}
        onRetry={onRetry}
        rowCount={state === "ready" ? zones.length : undefined}
        empty={{
          title: t("floorEditor.zonesEmptyTitle"),
          description: t("floorEditor.zonesEmptyHint"),
          action: (
            <Button variant="outline" size="sm" onClick={onCreate}>
              <Plus aria-hidden="true" />
              {t("floorEditor.addZone")}
            </Button>
          ),
        }}
        actions={
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("floorEditor.addZone")}
          </Button>
        }
        loadingRows={4}
      >
        <TableView>
          <TableHeader>
            <TableRow>
              <TableHead>{t("floorEditor.zonesTitle")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("floorEditor.formPaymentMode")}
              </TableHead>
              <TableHead numeric className="hidden md:table-cell">
                {t("floorEditor.serviceCharge")}
              </TableHead>
              <TableHead numeric className="hidden md:table-cell">
                {t("floorEditor.minSpend")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                {t("floorEditor.formHours")}
              </TableHead>
              <TableHead numeric>{t("terms.table")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{t("common.more")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {zones.map((zone) => {
              const tableCount = tables.filter(
                (table) => table.zoneId === zone.id,
              ).length;
              return (
                <TableRow key={zone.id}>
                  <TableCell>
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{zone.name}</span>
                        <Badge
                          tone={
                            zone.status === "active" ? "success" : "neutral"
                          }
                        >
                          {zone.status === "active"
                            ? t("floorEditor.zoneActive")
                            : t("floorEditor.zoneInactive")}
                        </Badge>
                      </div>
                      {/* Phones: the wide columns fold into this line. */}
                      <p className="text-xs leading-4 text-muted-foreground md:hidden">
                        {[
                          zone.paymentMode === "pay_first"
                            ? t("floorEditor.payFirst")
                            : t("floorEditor.openBill"),
                          `${zone.serviceChargeBp / 100}%`,
                          hoursLabel(zone),
                        ].join(" · ")}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {zone.paymentMode === "pay_first"
                      ? t("floorEditor.payFirst")
                      : t("floorEditor.openBill")}
                  </TableCell>
                  <TableCell numeric className="hidden md:table-cell">
                    {zone.serviceChargeBp / 100}%
                  </TableCell>
                  <TableCell numeric className="hidden md:table-cell">
                    {zone.minimumSpendIdr === 0 ? (
                      t("floorEditor.noMinSpend")
                    ) : (
                      <Money amount={zone.minimumSpendIdr} size="sm" />
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                    {hoursLabel(zone)}
                  </TableCell>
                  <TableCell numeric>{tableCount}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("floorEditor.edit", { name: zone.name })}
                        onClick={() => onEdit(zone)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("floorEditor.delete", {
                          name: zone.name,
                        })}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(zone);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableView>
      </DataTableShell>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("floorEditor.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("floorEditor.deleteBody")}
        confirmLabel={t("floorEditor.deleteConfirm")}
        pending={deleteZone.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
      />
    </>
  );
}

export { ZoneList };
