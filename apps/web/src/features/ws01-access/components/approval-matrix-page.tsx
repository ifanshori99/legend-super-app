// Approval matrix editor (PRD v1.7 §3 F7 "Matriks Approval"): who approves
// what, at which threshold, and how many levels. Actions without a policy are
// denied to everyone (fail closed), so the screen names them explicitly.
// AUTH-06: the approver is always a different person from the requester; that
// rule is fixed by the contract (requiresDistinctActor: true), not a toggle.
import * as React from "react";
import { CircleAlert, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  APPROVAL_MAX_LEVELS,
  type ApprovalPolicy,
  type Role,
} from "@starter/shared/access";
import { ApiError } from "@/lib/api/errors";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { accessErrorMessage } from "../errors";
import {
  addActionRow,
  addLevel,
  addTier,
  actionLabelKey,
  matrixApproverRoles,
  matrixCoverage,
  matrixDraftFromPolicies,
  matrixIssues,
  matrixPoliciesFromDraft,
  removeLevel,
  removeTier,
  setLevelRole,
  setTierThreshold,
  type MatrixDraftRow,
  type MatrixIssue,
  type MatrixTierDraft,
} from "../lib";
import {
  useApprovalMatrix,
  useReplaceApprovalMatrix,
  useRoles,
} from "../hooks";
import { AccessPage } from "./access-shell";

const SUPPLIER_PAYMENT_BASE_TIER_REQUIRED =
  "SUPPLIER_PAYMENT_BASE_TIER_REQUIRED";

function issueMessageKey(kind: MatrixIssue["kind"]) {
  switch (kind) {
    case "empty":
      return "access.matrix.issueEmpty" as const;
    case "missing_level":
      return "access.matrix.issueMissingLevel" as const;
    case "no_approver":
      return "access.matrix.issueNoApprover" as const;
    case "bad_threshold":
      return "access.matrix.issueThreshold" as const;
  }
}

function TierEditor({
  tier,
  row,
  roles,
  issues,
  disabled,
  onChange,
}: {
  tier: MatrixTierDraft;
  row: MatrixDraftRow;
  roles: readonly Role[];
  issues: readonly MatrixIssue[];
  disabled: boolean;
  onChange: (next: MatrixDraftRow) => void;
}) {
  const t = useT();
  const update = (fn: (row: MatrixDraftRow) => MatrixDraftRow) =>
    onChange(fn(row));

  const lastLevel = tier.levels.at(-1);

  return (
    <div className="grid gap-3 rounded-container bg-surface-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={`threshold-${tier.key}`}
          className="type-eyebrow text-muted-foreground"
        >
          {t("access.matrix.threshold")}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={t("access.matrix.removeTier")}
          onClick={() => update((current) => removeTier(current, tier.key))}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`threshold-${tier.key}`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1000}
          value={tier.thresholdIdr ?? ""}
          placeholder={t("access.matrix.anyAmount")}
          disabled={disabled}
          className="h-control-sm w-40 tabular"
          onChange={(event) => {
            const raw = event.target.value;
            update((current) =>
              setTierThreshold(
                current,
                tier.key,
                raw === "" ? null : Math.max(0, Number(raw)),
              ),
            );
          }}
        />
        {tier.thresholdIdr === null ? (
          <Badge tone="info">{t("access.matrix.anyAmount")}</Badge>
        ) : (
          <Money amount={tier.thresholdIdr} size="sm" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("access.matrix.thresholdHint")}
      </p>

      <div className="grid gap-2">
        {tier.levels.map((level, index) => (
          <div
            key={level.key}
            className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center"
          >
            <span className="text-sm text-muted-foreground">
              {t("access.matrix.level", { level: index + 1 })}
            </span>
            <Select
              value={level.roleId}
              disabled={disabled}
              onValueChange={(value) =>
                update((current) =>
                  setLevelRole(current, tier.key, level.key, value),
                )
              }
            >
              <SelectTrigger
                className="h-control-sm"
                aria-label={t("access.matrix.approver")}
              >
                <SelectValue
                  placeholder={t("access.matrix.approverPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || tier.levels.length >= APPROVAL_MAX_LEVELS}
          onClick={() => update((current) => addLevel(current, tier.key))}
        >
          <Plus aria-hidden="true" />
          {t("access.matrix.addLevel")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || tier.levels.length === 1 || !lastLevel}
          onClick={() => {
            if (!lastLevel) return;
            update((current) => removeLevel(current, tier.key, lastLevel.key));
          }}
        >
          {t("access.matrix.removeLevel")}
        </Button>
        {tier.levels.length >= APPROVAL_MAX_LEVELS && (
          <span className="text-xs text-muted-foreground">
            {t("access.matrix.levelMax", { max: APPROVAL_MAX_LEVELS })}
          </span>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="grid gap-1" role="alert">
          {issues.map((issue, index) => (
            <li key={`${issue.kind}-${index}`} className="text-sm text-danger">
              {t(issueMessageKey(issue.kind))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MatrixEditor({
  policies,
  roles,
  canManage,
}: {
  policies: readonly ApprovalPolicy[];
  roles: readonly Role[];
  canManage: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const save = useReplaceApprovalMatrix();
  const [draft, setDraft] = React.useState<MatrixDraftRow[]>(() =>
    matrixDraftFromPolicies(policies),
  );
  const [initialJson, setInitialJson] = React.useState(() =>
    JSON.stringify(matrixPoliciesFromDraft(draft)),
  );
  // The supplier payment base-tier error belongs to that row, not the top alert.
  const [supplierPaymentError, setSupplierPaymentError] = React.useState<
    string | null
  >(null);
  const issues = matrixIssues(draft);
  const coverage = matrixCoverage(draft);
  const approverRoles = matrixApproverRoles(roles);
  const dirty = JSON.stringify(matrixPoliciesFromDraft(draft)) !== initialJson;
  const saveErrorInRow =
    save.error instanceof ApiError &&
    save.error.code === SUPPLIER_PAYMENT_BASE_TIER_REQUIRED;

  const updateRow = (
    actionType: MatrixDraftRow["actionType"],
    next: MatrixDraftRow,
  ) => {
    if (actionType === "supplier_payment") setSupplierPaymentError(null);
    setDraft((current) =>
      current.map((row) => (row.actionType === actionType ? next : row)),
    );
  };

  const submit = () => {
    const body = { policies: matrixPoliciesFromDraft(draft) };
    if (body.policies.length === 0) return;
    setSupplierPaymentError(null);
    save.mutate(body, {
      onSuccess: (response) => {
        const next = matrixDraftFromPolicies(response.data);
        setDraft(next);
        setInitialJson(JSON.stringify(matrixPoliciesFromDraft(next)));
        toast({ title: t("access.matrix.saved") });
      },
      onError: (error) => {
        if (
          error instanceof ApiError &&
          error.code === SUPPLIER_PAYMENT_BASE_TIER_REQUIRED
        )
          setSupplierPaymentError(accessErrorMessage(error, t));
      },
    });
  };

  return (
    <>
      <CardShell className="gap-3">
        <Card className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <h2 className="type-title">{t("access.matrix.title")}</h2>
              <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
                {t("access.matrix.description")}
              </p>
            </div>
            {canManage && (
              <Button
                type="button"
                loading={save.isPending}
                disabled={!dirty || issues.length > 0}
                onClick={submit}
              >
                {t("access.matrix.save")}
              </Button>
            )}
          </div>
          <div className="flex items-start gap-2 rounded-container bg-surface-2 p-3">
            <ShieldCheck
              className="mt-0.5 size-icon shrink-0 text-success"
              aria-hidden="true"
            />
            <div className="grid gap-1">
              <p className="text-sm font-semibold">
                {t("access.matrix.distinctActor")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("access.matrix.coverage", {
                  covered: coverage.covered,
                  total: coverage.total,
                })}
              </p>
            </div>
          </div>
        </Card>
      </CardShell>

      {save.isError && !saveErrorInRow && (
        <p className="text-sm text-danger" role="alert">
          {accessErrorMessage(save.error, t)}
        </p>
      )}

      {issues.some((issue) => issue.kind === "empty") && (
        <p className="text-sm text-danger" role="alert">
          {t("access.matrix.issueEmpty")}
        </p>
      )}

      <div className="grid min-w-0 gap-3">
        {draft.map((row) => {
          const rowIssues = issues.filter(
            (issue) =>
              issue.actionType === row.actionType &&
              issue.kind !== "missing_level",
          );
          return (
            <CardShell key={row.actionType}>
              <Card className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="type-heading">
                    {t(actionLabelKey(row.actionType))}
                  </h2>
                  <div className="flex items-center gap-2">
                    <Badge tone={row.tiers.length > 0 ? "success" : "danger"}>
                      {row.tiers.length > 0
                        ? t("access.matrix.policyCount", {
                            count: row.tiers.length,
                          })
                        : t("access.matrix.noPolicyShort")}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canManage}
                      onClick={() => updateRow(row.actionType, addTier(row))}
                    >
                      <Plus aria-hidden="true" />
                      {t("access.matrix.addTier")}
                    </Button>
                  </div>
                </div>

                {row.tiers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("access.matrix.notConfiguredNote")}
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {row.tiers.map((tier) => (
                      <TierEditor
                        key={tier.key}
                        tier={tier}
                        row={row}
                        roles={approverRoles}
                        issues={rowIssues.filter(
                          (issue) => issue.tierKey === tier.key,
                        )}
                        disabled={!canManage}
                        onChange={(next) => updateRow(row.actionType, next)}
                      />
                    ))}
                  </div>
                )}

                {row.actionType === "supplier_payment" &&
                  supplierPaymentError && (
                    <p
                      className="text-sm text-danger"
                      role="alert"
                      data-testid="approval-row-error-supplier_payment"
                    >
                      {supplierPaymentError}
                    </p>
                  )}
              </Card>
            </CardShell>
          );
        })}
      </div>

      <Card className="grid gap-3">
        <div className="grid gap-1">
          <h2 className="flex items-center gap-2 type-heading">
            <CircleAlert
              className="size-icon text-warning"
              aria-hidden="true"
            />
            {t("access.matrix.uncoveredTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("access.matrix.uncoveredHint")}
          </p>
        </div>
        {coverage.uncovered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("access.matrix.allCovered")}
          </p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {coverage.uncovered.map((action) => (
              <li
                key={action}
                className="flex min-h-control-sm items-center justify-between gap-2 rounded-control border-(length:--border-w) px-2 py-1"
              >
                <span className="text-(length:--density-text) leading-5">
                  {t(actionLabelKey(action))}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canManage}
                  onClick={() =>
                    setDraft((current) => addActionRow(current, action))
                  }
                >
                  {t("access.matrix.configure")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function ApprovalMatrixPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const matrix = useApprovalMatrix();
  const roles = useRoles();
  const canManage = holdsAny(access, ["access.approval_policy.manage"]);

  const loading = matrix.isPending || roles.isPending;
  const failed = matrix.isError || roles.isError;

  return (
    <AccessPage active="matrix">
      {loading ? (
        <div aria-busy="true" className="grid gap-2">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : failed ? (
        <Card className="p-0">
          <ErrorState
            onRetry={() => {
              void matrix.refetch();
              void roles.refetch();
            }}
          />
        </Card>
      ) : (
        <MatrixEditor
          policies={matrix.data.data}
          roles={roles.data?.data ?? []}
          canManage={canManage}
        />
      )}
    </AccessPage>
  );
}
