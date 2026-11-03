// /kelola/pengumuman — internal announcements and their read receipts (PRD
// v1.7 §3 F32 "Pengumuman Internal", F29 "dengan tanda terima"). Audience is
// all employees or specific outlets; the receipt table shows who read and who
// confirmed. Receipts have no list endpoint yet, so the table reads the mock
// read model and says so otherwise; mark-read still goes through the contract.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@starter/shared/i18n";
import {
  isAnnouncementReceiptComplete,
  type Announcement,
  type AnnouncementReceipt,
} from "@starter/shared/hris";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  useAnnouncements,
  useEmployees,
  useMarkAnnouncementRead,
  useMyProfile,
} from "../hooks";
import { formatDateTime } from "../lib";
import {
  fixtureAnnouncementReceipts,
  recordAnnouncementReceipt,
} from "../read-model";

export function AnnouncementsPage() {
  const t = useT();
  const toast = useToast();
  const announcementsQuery = useAnnouncements();
  const employeesQuery = useEmployees();
  const profileQuery = useMyProfile();
  const markRead = useMarkAnnouncementRead();

  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Announcement | null>(null);
  const receipts = fixtureAnnouncementReceipts();
  const employeeId = profileQuery.data?.employee.id;

  const employeesById = React.useMemo(
    () =>
      new Map(
        (employeesQuery.data?.data ?? []).map((employee) => [
          employee.id,
          employee,
        ]),
      ),
    [employeesQuery.data],
  );
  const announcements = React.useMemo(
    () =>
      [...(announcementsQuery.data?.data ?? [])].sort(
        (left, right) =>
          Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
      ),
    [announcementsQuery.data],
  );

  const receiptsFor = (announcementId: string): AnnouncementReceipt[] =>
    receipts === null
      ? []
      : receipts.filter((receipt) => receipt.announcementId === announcementId);

  // Announcements finished in this visit: without a receipts list (real API)
  // the read model cannot reflect the write, so the button must still go away.
  const [doneHere, setDoneHere] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const myReceipt = (announcementId: string): AnnouncementReceipt | null =>
    receipts === null || employeeId === undefined
      ? null
      : (receipts.find(
          (receipt) =>
            receipt.announcementId === announcementId &&
            receipt.employeeId.toLowerCase() === employeeId.toLowerCase(),
        ) ?? null);

  /** Read, and confirmed when the announcement asks for a receipt (F29). */
  const isDone = (announcement: Announcement): boolean =>
    doneHere.has(announcement.id) ||
    (myReceipt(announcement.id) !== null &&
      isAnnouncementReceiptComplete(announcement, myReceipt(announcement.id)));

  /** Readers and confirmers, each employee counted once. */
  const receiptCounts = (announcementId: string) => {
    const rows = receiptsFor(announcementId);
    const readers = new Set(rows.map((row) => row.employeeId.toLowerCase()));
    const confirmers = new Set(
      rows
        .filter((row) => row.acknowledgedAt !== null)
        .map((row) => row.employeeId.toLowerCase()),
    );
    return { read: readers.size, acknowledged: confirmers.size };
  };

  function open(announcement: Announcement) {
    markRead.reset();
    setSelected(announcement);
  }

  const audienceName = (announcement: Announcement) =>
    announcement.audience.kind === "all"
      ? t("learning.announcements.audienceAll")
      : t("learning.announcements.audienceOutlets", {
          count: announcement.audience.outletIds.length,
        });

  const searchText = search.trim().toLocaleLowerCase("id-ID");
  const visible = React.useMemo(
    () =>
      searchText === ""
        ? announcements
        : announcements.filter((announcement) =>
            announcement.title.toLocaleLowerCase("id-ID").includes(searchText),
          ),
    [announcements, searchText],
  );

  const requiresReceipt = announcements.filter(
    (announcement) => announcement.requiresReceipt,
  ).length;

  const state: DataState =
    announcementsQuery.isPending || employeesQuery.isPending
      ? "loading"
      : announcementsQuery.isError || employeesQuery.isError
        ? "error"
        : announcements.length === 0
          ? "empty"
          : "ready";

  function markAsRead(announcement: Announcement) {
    markRead.mutate(
      {
        announcementId: announcement.id,
        acknowledged: announcement.requiresReceipt,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (receipt) => {
          recordAnnouncementReceipt(receipt);
          setDoneHere((current) => new Set(current).add(announcement.id));
          toast({
            title: t("learning.announcements.readToast"),
            tone: "success",
          });
        },
      },
    );
  }

  const selectedReceipts = selected === null ? [] : receiptsFor(selected.id);

  return (
    <div className="grid min-w-0 gap-4">
      <StatStrip label={t("learning.announcements.summaryLabel")} columns={3}>
        <StatTile
          label={t("learning.announcements.metric.announcements")}
          value={
            <span className="tabular">
              {formatNumber(announcements.length)}
            </span>
          }
        />
        <StatTile
          label={t("learning.announcements.metric.requiresReceipt")}
          value={
            <span className="tabular">{formatNumber(requiresReceipt)}</span>
          }
        />
        <StatTile
          label={t("learning.announcements.metric.receipts")}
          value={
            <span className="tabular">
              {receipts === null
                ? t("learning.common.none")
                : formatNumber(
                    announcements.reduce(
                      (sum, announcement) =>
                        sum + receiptCounts(announcement.id).read,
                      0,
                    ),
                  )}
            </span>
          }
        />
      </StatStrip>

      <DataTableShell
        title={t("learning.announcements.tableTitle")}
        description={t("learning.announcements.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("learning.announcements.table.announcement"),
        }}
        onRetry={() => {
          void announcementsQuery.refetch();
          void employeesQuery.refetch();
        }}
        empty={{
          title: t("learning.announcements.emptyTitle"),
          description: t("learning.announcements.emptyHint"),
        }}
        noResults={visible.length === 0 && state === "ready"}
        rowCount={visible.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("learning.announcements.table.announcement")}
              </TableHead>
              <TableHead>
                {t("learning.announcements.table.audience")}
              </TableHead>
              <TableHead>
                {t("learning.announcements.table.published")}
              </TableHead>
              <TableHead>
                {t("learning.announcements.table.receipts")}
              </TableHead>
              <TableHead>
                {t("learning.announcements.table.requirement")}
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("learning.announcements.table.action")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((announcement) => {
              const counts = receiptCounts(announcement.id);
              return (
                <TableRow key={announcement.id}>
                  <TableCell>
                    <p className="font-medium">{announcement.title}</p>
                    {isDone(announcement) && (
                      <StatusPill status="success" className="mt-1">
                        {t(
                          announcement.requiresReceipt
                            ? "learning.announcements.alreadyAcknowledged"
                            : "learning.announcements.alreadyRead",
                        )}
                      </StatusPill>
                    )}
                  </TableCell>
                  <TableCell>{audienceName(announcement)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatDateTime(announcement.publishedAt)}
                  </TableCell>
                  <TableCell>
                    {receipts === null ? (
                      <span className="text-sm text-muted-foreground">
                        {t("learning.common.none")}
                      </span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        <Badge tone="neutral">
                          {t("learning.announcements.receiptsCount", {
                            count: counts.read,
                          })}
                        </Badge>
                        {announcement.requiresReceipt && (
                          <Badge tone="neutral">
                            {t("learning.announcements.acknowledgedCount", {
                              count: counts.acknowledged,
                            })}
                          </Badge>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={
                        announcement.requiresReceipt ? "warning" : "success"
                      }
                    >
                      {t(
                        announcement.requiresReceipt
                          ? "learning.announcements.requirementRequired"
                          : "learning.announcements.requirementOptional",
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => open(announcement)}
                    >
                      {t("learning.announcements.open")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {receipts === null && state === "ready" && (
        <p className="rounded-container border-(length:--border-w) bg-card p-3 text-sm leading-5 text-muted-foreground shadow-hairline">
          {t("learning.announcements.receiptsUnavailable")}
        </p>
      )}

      {selected !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {t("learning.announcements.detailTitle")}
              </DialogTitle>
              <DialogDescription>
                {t("learning.common.meta", {
                  first: audienceName(selected),
                  second: t("learning.announcements.publishedAt", {
                    date: formatDateTime(selected.publishedAt),
                  }),
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <div>
                <h3 className="type-title">{selected.title}</h3>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge
                    tone={selected.requiresReceipt ? "warning" : "success"}
                  >
                    {t(
                      selected.requiresReceipt
                        ? "learning.announcements.requirementRequired"
                        : "learning.announcements.requirementOptional",
                    )}
                  </Badge>
                  {selected.expiresAt !== null && (
                    <Badge tone="neutral">
                      {t("learning.announcements.expiresAt", {
                        date: formatDateTime(selected.expiresAt),
                      })}
                    </Badge>
                  )}
                </div>
              </div>

              <div>
                <h4 className="type-eyebrow text-muted-foreground">
                  {t("learning.announcements.bodyLabel")}
                </h4>
                <p className="mt-1 rounded-container border-(length:--border-w) bg-surface-2 p-3 text-sm leading-6 whitespace-pre-line">
                  {selected.body}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isDone(selected) ? (
                  <StatusPill status="success">
                    {t(
                      selected.requiresReceipt
                        ? "learning.announcements.alreadyAcknowledged"
                        : "learning.announcements.alreadyRead",
                    )}
                  </StatusPill>
                ) : (
                  <Button
                    onClick={() => markAsRead(selected)}
                    loading={markRead.isPending}
                  >
                    {t(
                      !selected.requiresReceipt
                        ? "learning.announcements.markRead"
                        : myReceipt(selected.id) !== null
                          ? "learning.announcements.acknowledge"
                          : "learning.announcements.markReadAndAcknowledge",
                    )}
                  </Button>
                )}
                {markRead.isError && (
                  <p role="alert" className="text-sm text-danger">
                    {t("learning.common.actionFailed")}
                  </p>
                )}
              </div>

              <div>
                <h4 className="type-title">
                  {t("learning.announcements.receiptsTitle")}
                </h4>
                {receipts === null ? (
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {t("learning.announcements.receiptsUnavailable")}
                  </p>
                ) : selectedReceipts.length === 0 ? (
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {t("learning.announcements.receipts.empty")}
                  </p>
                ) : (
                  <Table className="mt-1">
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("learning.announcements.receipts.employee")}
                        </TableHead>
                        <TableHead>
                          {t("learning.announcements.receipts.readAt")}
                        </TableHead>
                        <TableHead>
                          {t("learning.announcements.receipts.acknowledgedAt")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedReceipts.map((receipt) => (
                        <TableRow key={receipt.id}>
                          <TableCell>
                            {employeesById.get(receipt.employeeId)?.fullName ??
                              t("learning.common.none")}
                          </TableCell>
                          <TableCell className="tabular whitespace-nowrap">
                            {formatDateTime(receipt.readAt)}
                          </TableCell>
                          <TableCell className="tabular whitespace-nowrap">
                            {receipt.acknowledgedAt === null
                              ? t("learning.common.none")
                              : formatDateTime(receipt.acknowledgedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t("common.close")}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
