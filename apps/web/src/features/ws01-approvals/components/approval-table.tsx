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
  SourceBadge,
  formatWhen,
  useDiffRows,
  useRequesterName,
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
  const preview = previewRow(useDiffRows(request.payload));
  const action = t(actionLabelKey(request.actionType));
  return (
    <TableRow data-testid="approval-row" data-request-id={request.id}>
      <TableCell className="max-w-xs">
        <p className="font-semibold">{action}</p>
        <p className="text-sm text-muted-foreground">
          {t(moduleLabelKey(moduleOf(request.actionType)))} · {requester}
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
        {request.amountIdr !== null ? (
          <Money amount={request.amountIdr} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="tabular">
        {request.level}/{request.requiredLevels}
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
      <TableCell className="text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpen(request)}
          aria-label={t("approvals.reviewAria", { action })}
        >
          {t("approvals.review")}
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
          <TableHead>{t("approvals.col.level")}</TableHead>
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
