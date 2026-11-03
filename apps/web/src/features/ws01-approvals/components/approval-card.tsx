// Mobile card (and the narrow-width form of a row): source badge, action,
// value, a one-line preview of the proposed change, countdown and a review
// button with a 44px target (PRD §3 F7 Kotak Approval; MCP-04).
import { ChevronRight } from "lucide-react";
import type { ApprovalRequest } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { actionLabelKey, isAgentDraft, previewRow } from "../logic.ts";
import {
  Deadline,
  RequestStatusBadge,
  SourceBadge,
  useDiffRows,
  useRequesterName,
} from "./parts";

export function ApprovalCard({
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
    <Card
      data-testid="approval-card"
      data-request-id={request.id}
      className="gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SourceBadge source={request.source} />
        {request.status === "pending" ? (
          <Deadline request={request} now={now} />
        ) : (
          <RequestStatusBadge status={request.status} />
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="text-base leading-6 font-semibold">{action}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            isAgentDraft(request.source)
              ? "approvals.draftFor"
              : "approvals.requestedBy",
            { name: requester },
          )}
          {request.requiredLevels > 1 &&
            ` · ${t("approvals.level", { level: request.level, total: request.requiredLevels })}`}
        </p>
      </div>
      {request.amountIdr !== null && (
        <Money amount={request.amountIdr} size="lg" />
      )}
      {preview && (
        <p className="text-sm leading-5">
          <span className="text-muted-foreground">{preview.label}: </span>
          {preview.before !== null && (
            <>
              <span className="line-through">{preview.before}</span>
              <span aria-hidden="true"> → </span>
              <span className="sr-only">{t("approvals.diff.becomes")}</span>
            </>
          )}
          <span className="font-semibold">{preview.after}</span>
        </p>
      )}
      <Button
        variant="outline"
        className="min-h-11 w-full justify-between"
        onClick={() => onOpen(request)}
        aria-label={t("approvals.reviewAria", { action })}
      >
        {t("approvals.review")}
        <ChevronRight aria-hidden="true" />
      </Button>
    </Card>
  );
}
