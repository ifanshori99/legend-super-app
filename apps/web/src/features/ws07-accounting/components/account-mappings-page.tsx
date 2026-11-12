// Account-role mapping per legal entity (bead legend-fzvh; mockup
// design/mockups/backoffice/account-role-mappings.html). Automatic journals
// name a role, never an account code: this screen says which account each role
// posts to. Logic (draft, per-role checks, error wording) lives in
// ../mapping-state.ts.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type { Account, AccountMapping } from "@starter/shared/accounting";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { fieldClass } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCanPostJournals } from "../guard";
import { useAccounts, useEntityPicker } from "../hooks";
import {
  useAccountMappings,
  useReplaceAccountMappings,
} from "../mapping-hooks";
import {
  MAPPING_ROLES,
  SAVE_ERROR_KEYS,
  buildReplaceBody,
  draftFromMappings,
  draftIssues,
  eligibleAccounts,
  firstIssueRole,
  isDraftDirty,
  mappingCounts,
  mappingSaveError,
  mergeDraftOnto,
  mappingScreenState,
  parseContractIssues,
  roleLabelKey,
  roleTypeLabelKey,
  type MappingDraft,
  type MappingIssue,
  type MappingSaveError,
} from "../mapping-state";
import { EntityPicker } from "./entity-picker";

// What the editor reports up so the scope card (completeness) and the entity
// switch (discard confirm) can follow the draft.
type EditorStatus = { dirty: boolean; mapped: number; total: number };

type Banner =
  | { kind: "success" }
  | { kind: "invalid" }
  | { kind: "failed"; error: MappingSaveError };

const key = (value: string) => value as MessageKey;

function BannerBox({
  tone,
  title,
  hint,
  role,
}: {
  tone: "warning" | "danger" | "success";
  title: string;
  hint: string;
  role?: "alert" | "status";
}) {
  const Icon = tone === "success" ? CircleCheck : TriangleAlert;
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-2 rounded-container border-(length:--border-w) p-card text-foreground",
        tone === "warning" && "border-warning bg-warning-subtle",
        tone === "danger" && "border-danger bg-danger-subtle",
        tone === "success" && "border-success bg-success-subtle",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="text-sm leading-5">
        <strong className="font-semibold">{title}</strong>
        <br />
        {hint}
      </p>
    </div>
  );
}

function PageHead() {
  const t = useT();
  return (
    <div className="grid gap-4">
      <Link
        to="/kelola/akuntansi"
        className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t("accounting.mapping.back")}
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <h2 className="text-xl leading-7 font-semibold">
            {t("accounting.mapping.title")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("accounting.mapping.subtitle")}
          </p>
        </div>
        <Button asChild variant="outline" className="max-sm:w-full">
          <Link to="/kelola/akuntansi">
            {t("accounting.mapping.viewAccounts")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

function LoadingCard() {
  const t = useT();
  return (
    <CardShell>
      <Card aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <h3 className="text-lg font-semibold">
          {t("accounting.mapping.loadingTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("accounting.mapping.loadingHint")}
        </p>
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </Card>
    </CardShell>
  );
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <>
      <BannerBox
        tone="danger"
        title={t("accounting.mapping.errorBannerTitle")}
        hint={t("accounting.mapping.errorBannerHint")}
        role="alert"
      />
      <CardShell>
        <Card>
          <EmptyState
            title={t("accounting.mapping.errorTitle")}
            description={t("accounting.mapping.errorHint")}
            action={
              <Button variant="outline" onClick={onRetry}>
                {t("accounting.mapping.retry")}
              </Button>
            }
          />
        </Card>
      </CardShell>
    </>
  );
}

function Completeness({ status }: { status: EditorStatus | null }) {
  const t = useT();
  return (
    <div className="grid gap-1">
      <p className="text-sm font-semibold">
        {t("accounting.mapping.completenessLabel")}
      </p>
      <p className="font-semibold" aria-live="polite">
        {status
          ? t("accounting.mapping.completeness", {
              mapped: status.mapped,
              total: status.total,
            })
          : t("accounting.mapping.completenessUnknown")}
      </p>
    </div>
  );
}

function MappingEditor({
  legalEntityId,
  accounts,
  mappings,
  onStatusChange,
}: {
  legalEntityId: string;
  accounts: readonly Account[];
  mappings: readonly AccountMapping[];
  onStatusChange: (status: EditorStatus | null) => void;
}) {
  const t = useT();
  const canWrite = useCanPostJournals();
  const replace = useReplaceAccountMappings(legalEntityId);
  const saved = React.useMemo(() => draftFromMappings(mappings), [mappings]);
  const [draft, setDraft] = React.useState<MappingDraft>(saved);
  // The mapping the draft started from; the save merges only the roles the
  // user changed from it onto the latest saved state.
  const [baseline, setBaseline] = React.useState<MappingDraft>(saved);
  const [banner, setBanner] = React.useState<Banner | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [serverIssues, setServerIssues] = React.useState<
    Partial<Record<(typeof MAPPING_ROLES)[number], MappingIssue>>
  >({});

  // A refetch changed the saved mapping while the draft is untouched: follow it.
  if (isDraftDirty(baseline, saved) && !isDraftDirty(baseline, draft)) {
    setBaseline(saved);
    setDraft(saved);
  }

  const issues = React.useMemo(
    () => (checked ? draftIssues(draft, accounts, legalEntityId) : {}),
    [checked, draft, accounts, legalEntityId],
  );
  const counts = mappingCounts(draft);
  const dirty = isDraftDirty(saved, draft);

  React.useEffect(() => {
    onStatusChange({ dirty, mapped: counts.mapped, total: counts.total });
  }, [onStatusChange, dirty, counts.mapped, counts.total]);
  React.useEffect(() => () => onStatusChange(null), [onStatusChange]);

  // After a failed save the first flagged select takes focus. Wait until the
  // selects are enabled again (the save is no longer pending).
  const selectRefs = React.useRef<
    Partial<Record<(typeof MAPPING_ROLES)[number], HTMLSelectElement | null>>
  >({});
  const focusRole = React.useRef<(typeof MAPPING_ROLES)[number] | null>(null);
  React.useEffect(() => {
    if (focusRole.current === null || replace.isPending) return;
    selectRefs.current[focusRole.current]?.focus();
    focusRole.current = null;
  }, [serverIssues, replace.isPending]);

  const choose = (role: (typeof MAPPING_ROLES)[number], accountId: string) => {
    setDraft((current) => ({ ...current, [role]: accountId }));
    setBanner(null);
    setServerIssues({});
  };

  const cancel = () => {
    setDraft(saved);
    setBaseline(saved);
    setBanner(null);
    setServerIssues({});
    setChecked(false);
  };

  const save = async () => {
    setChecked(true);
    if (Object.keys(draftIssues(draft, accounts, legalEntityId)).length > 0) {
      setBanner({ kind: "invalid" });
      return;
    }
    setServerIssues({});
    const merged = mergeDraftOnto(baseline, draft, saved);
    try {
      await replace.mutateAsync(buildReplaceBody(merged));
      setChecked(false);
      setBaseline(merged);
      setDraft(merged);
      setBanner({ kind: "success" });
    } catch (error) {
      const kind = mappingSaveError(error);
      if (kind === "invalid") {
        if ((error as { status?: unknown }).status === 422) {
          const parsed = parseContractIssues(
            (error as { message?: string }).message,
          );
          setServerIssues(parsed);
          focusRole.current = firstIssueRole(parsed);
        }
        setBanner({ kind: "invalid" });
      } else setBanner({ kind: "failed", error: kind });
    }
  };

  const failed =
    banner?.kind === "failed" ? SAVE_ERROR_KEYS[banner.error] : null;

  return (
    <>
      {banner?.kind === "invalid" && (
        <BannerBox
          tone="danger"
          role="alert"
          title={t("accounting.mapping.invalidTitle")}
          hint={t("accounting.mapping.invalidHint")}
        />
      )}
      {failed && (
        <BannerBox
          tone="danger"
          role="alert"
          title={t(key(failed.title))}
          hint={t(key(failed.hint))}
        />
      )}
      {/* The live region exists before the message so it is announced. */}
      <div
        role="status"
        aria-live="polite"
        className={banner?.kind === "success" ? undefined : "-mb-4"}
      >
        {banner?.kind === "success" && (
          <BannerBox
            tone="success"
            title={t("accounting.mapping.successTitle")}
            hint={t("accounting.mapping.successHint")}
          />
        )}
      </div>
      {banner === null && counts.missing > 0 && (
        <BannerBox
          tone="warning"
          title={t("accounting.mapping.incompleteTitle")}
          hint={t("accounting.mapping.incompleteHint")}
        />
      )}
      <CardShell>
        <Card>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="grid gap-1">
              <h3 className="text-lg font-semibold">
                {t("accounting.mapping.sectionTitle")}
              </h3>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.mapping.sectionHint")}
              </p>
            </div>
            <Badge tone={counts.missing > 0 ? "warning" : "success"}>
              {counts.missing > 0
                ? t("accounting.mapping.missingTag", { count: counts.missing })
                : t("accounting.mapping.completeTag")}
            </Badge>
          </div>
          {!canWrite && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("accounting.mapping.readOnlyHint")}
            </p>
          )}
          <div className="hidden grid-cols-[34%_18%_1fr] gap-2 border-b-(length:--border-w) border-border px-2 pb-2 text-xs font-semibold text-muted-foreground md:grid">
            <span>{t("accounting.mapping.columns.role")}</span>
            <span>{t("accounting.mapping.columns.type")}</span>
            <span>{t("accounting.mapping.columns.account")}</span>
          </div>
          <ul className="divide-y divide-border">
            {MAPPING_ROLES.map((role) => {
              const current = draft[role] ?? "";
              const issue = issues[role] ?? serverIssues[role];
              const options = eligibleAccounts(role, accounts);
              // A saved account that is no longer eligible stays visible so the
              // row can be flagged instead of silently showing "Pilih akun".
              const kept =
                current !== "" && !options.some((a) => a.id === current)
                  ? accounts.find((a) => a.id === current)
                  : undefined;
              const label = t(key(roleLabelKey(role)));
              const issueId = `mapping-issue-${role}`;
              return (
                <li
                  key={role}
                  className="grid gap-1 px-2 py-3.5 md:grid-cols-[34%_18%_1fr] md:gap-2"
                >
                  <span className="font-semibold">{label}</span>
                  <span className="text-sm text-muted-foreground md:text-base">
                    {t(key(roleTypeLabelKey(role)))}
                  </span>
                  <div className="grid gap-1">
                    <select
                      ref={(node) => {
                        selectRefs.current[role] = node;
                      }}
                      className={cn(fieldClass, "h-control px-3")}
                      value={current}
                      disabled={!canWrite || replace.isPending}
                      aria-label={t("accounting.mapping.selectLabel", {
                        role: label,
                      })}
                      aria-invalid={issue ? true : undefined}
                      aria-describedby={issue ? issueId : undefined}
                      onChange={(event) => choose(role, event.target.value)}
                    >
                      <option value="">
                        {t("accounting.mapping.selectPlaceholder")}
                      </option>
                      {kept && (
                        <option value={kept.id}>
                          {kept.code} · {kept.name}
                        </option>
                      )}
                      {options.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                    {issue && (
                      <p
                        id={issueId}
                        className="text-sm font-semibold text-danger"
                      >
                        <TriangleAlert
                          className="mr-1 inline size-3.5"
                          aria-hidden="true"
                        />
                        {t(`accounting.mapping.issues.${issue}`)}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {canWrite && (
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={cancel}
                disabled={replace.isPending || (!dirty && banner === null)}
                className="max-sm:w-full"
              >
                {t("accounting.mapping.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  void save();
                }}
                loading={replace.isPending}
                disabled={!dirty}
                className="max-sm:w-full"
              >
                {replace.isPending
                  ? t("accounting.mapping.saving")
                  : t("accounting.mapping.save")}
              </Button>
            </div>
          )}
        </Card>
      </CardShell>
    </>
  );
}

export function AccountMappingsPage() {
  const t = useT();
  const picker = useEntityPicker();
  const entityId = picker.entity?.id;
  const accountsQuery = useAccounts(entityId);
  const mappingsQuery = useAccountMappings(entityId);
  const [status, setStatus] = React.useState<EditorStatus | null>(null);
  const [pendingEntity, setPendingEntity] = React.useState<string | null>(null);
  const dirty = status?.dirty === true;

  // Closing the tab or reloading with an unsaved draft asks first.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const changeEntity = (next: string) => {
    if (next === entityId) return;
    if (dirty) setPendingEntity(next);
    else picker.selectEntity(next);
  };

  if (picker.entitiesQuery.isPending)
    return (
      <div className="grid min-w-0 gap-4">
        <PageHead />
        <LoadingCard />
      </div>
    );
  if (picker.entitiesQuery.isError)
    return (
      <div className="grid min-w-0 gap-4">
        <PageHead />
        <ErrorCard
          onRetry={() => {
            void picker.entitiesQuery.refetch();
          }}
        />
      </div>
    );
  if (!picker.entity)
    return (
      <div className="grid min-w-0 gap-4">
        <PageHead />
        <CardShell>
          <Card>
            <EmptyState
              title={t("accounting.mapping.emptyTitle")}
              description={t("accounting.mapping.emptyHint")}
              action={
                <Button asChild>
                  <Link to="/kelola/akuntansi">
                    {t("accounting.mapping.openAccounts")}
                  </Link>
                </Button>
              }
            />
          </Card>
        </CardShell>
      </div>
    );

  const state = mappingScreenState({
    mappingsPending: mappingsQuery.isPending,
    accountsPending: accountsQuery.isPending,
    mappingsError: mappingsQuery.isError,
    accountsError: accountsQuery.isError,
  });

  return (
    <div className="grid min-w-0 gap-4">
      <PageHead />
      <CardShell>
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
            <div className="grid gap-2">
              <EntityPicker
                entities={picker.entities}
                value={picker.entity.id}
                onChange={changeEntity}
              />
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.mapping.entityHint")}
              </p>
            </div>
            <Completeness status={state === "ready" ? status : null} />
          </div>
        </Card>
      </CardShell>
      <Dialog
        open={pendingEntity !== null}
        onOpenChange={(open) => !open && setPendingEntity(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accounting.mapping.discardTitle")}</DialogTitle>
            <DialogDescription>
              {t("accounting.mapping.discardBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingEntity(null)}
            >
              {t("accounting.mapping.discardKeep")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (pendingEntity !== null) picker.selectEntity(pendingEntity);
                setPendingEntity(null);
              }}
            >
              {t("accounting.mapping.discardConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {state === "loading" && <LoadingCard />}
      {state === "error" && (
        <ErrorCard
          onRetry={() => {
            void accountsQuery.refetch();
            void mappingsQuery.refetch();
          }}
        />
      )}
      {state === "ready" && accountsQuery.data && mappingsQuery.data && (
        <MappingEditor
          key={picker.entity.id}
          legalEntityId={picker.entity.id}
          accounts={accountsQuery.data}
          mappings={mappingsQuery.data}
          onStatusChange={setStatus}
        />
      )}
    </div>
  );
}
