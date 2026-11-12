// Desktop list: one row per request, same facts as the mobile card.
import type { ApprovalRequest } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  actionLabelKey,
  moduleLabelKey,
  moduleOf,
  previewRow,
} from "../logic.ts";
import {
  Deadline,
  RequestStatusBadge,
  ShiftDifference,
  SourceBadge,
  formatWhen,
  useApprovalAmount,
  useDiffRows,
  useRequesterName,
  withoutShiftValue,
} from "./parts";

function Row({
  request,
  now,
  onOpen,
}: {
  request: ApprovalRequest;
  now: number;
  onOpen: (request: ApprovalRequest) => void;
}) {
  const t = useT();
  const requester = useRequesterName(request.requestedBy);
  const { amount, isShiftClose, isRequester } = useApprovalAmount(request);
  const preview = previewRow(
    withoutShiftValue(useDiffRows(request.payload), request.actionType),
  );
  const action = t(actionLabelKey(request.actionType));
  return (
    <TableRow data-testid="approval-row" data-request-id={request.id}>
      <TableCell className="max-w-56">
        <p className="font-semibold">{action}</p>
        <p className="text-sm text-muted-foreground">
          {t(moduleLabelKey(moduleOf(request.actionType)))} · {requester}
          {request.requiredLevels > 1 &&
            ` · ${t("approvals.level", { level: request.level, total: request.requiredLevels })}`}
        </p>
        {preview && (
          <p className="truncate text-sm">
            {preview.label}:{" "}
            {preview.before !== null && (
              <span className="line-through">{preview.before} </span>
            )}
            <span className="font-semibold">
              {preview.before !== null && "→ "}
              {preview.after}
            </span>
          </p>
        )}
      </TableCell>
      <TableCell>
        <SourceBadge source={request.source} />
      </TableCell>
      <TableCell className="text-right">
        {amount !== null && isShiftClose ? (
          <div className="grid justify-items-end">
            <span className="text-xs text-muted-foreground">
              {t("approvals.shift.difference")}
            </span>
            <ShiftDifference amount={amount} size="md" />
          </div>
        ) : amount !== null ? (
          <Money amount={amount} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="grid gap-0.5">
          <Deadline request={request} now={now} />
          <span className="text-xs text-muted-foreground">
            {formatWhen(request.deadlineAt)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <RequestStatusBadge status={request.status} />
      </TableCell>
      <TableCell className="text-right whitespace-nowrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpen(request)}
          aria-label={t("approvals.reviewAria", { action })}
        >
          {t(
            isShiftClose && isRequester
              ? "approvals.shift.viewStatus"
              : "approvals.review",
          )}
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function ApprovalTable({
  rows,
  now,
  onOpen,
}: {
  rows: readonly ApprovalRequest[];
  now: number;
  onOpen: (request: ApprovalRequest) => void;
}) {
  const t = useT();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("approvals.col.request")}</TableHead>
          <TableHead>{t("approvals.col.source")}</TableHead>
          <TableHead className="text-right">
            {t("approvals.col.value")}
          </TableHead>
          <TableHead>{t("approvals.col.deadline")}</TableHead>
          <TableHead>{t("approvals.col.status")}</TableHead>
          <TableHead>
            <span className="sr-only">{t("approvals.col.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((request) => (
          <Row key={request.id} request={request} now={now} onOpen={onOpen} />
        ))}
      </TableBody>
    </Table>
  );
}
