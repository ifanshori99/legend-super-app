// One role: a template is read-only (its permissions come from the contract);
// a custom role is editable here (PRD v1.7 §3 F7 "Custom Role").
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, ShieldCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { PermissionCode, Role, ScopeType } from "@starter/shared/access";
import {
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
  roleTemplate,
} from "@starter/shared/access";
import { ApiError } from "@/lib/api/errors";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import {
  useCreateCustomRole,
  useMfaFactors,
  useNow,
  useRoles,
  useUpdateCustomRole,
  useVerifyMfaFactor,
  useViewerAssignments,
} from "../hooks";
import { accessErrorMessage, roleEditorErrorMessage } from "../errors";
import {
  canSelectPermission,
  customRoleMfaRequired,
  heldAtTenantScope,
  permissionBlockReason,
  permissionsViewerMayAdd,
  roleEditNeedsReauth,
  SCOPE_LABEL_KEY,
  SCOPE_TYPES,
  togglePermission,
  viewerHoldsRole,
  viewerHoldsTopAuthority,
} from "../lib";
import { AccessPage } from "./access-shell";
import {
  PermissionChecklist,
  PermissionReadOnlyList,
} from "./permission-catalog";

type FormErrors = {
  name?: string;
  permissions?: string;
  scope?: string;
};

function RoleFrame({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const t = useT();
  return (
    <AccessPage active="roles">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="/kelola/akses" aria-label={t("access.role.back")}>
              <ArrowLeft aria-hidden="true" />
            </Link>
          </Button>
          <h2 className="type-title">{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </AccessPage>
  );
}

export function RoleDetailPage({
  roleId,
  access,
  viewerUserId,
}: {
  roleId: string;
  access: AreaAccess;
  /** The signed-in user's id (session), used to mirror the grant rules. */
  viewerUserId?: string;
}) {
  const t = useT();
  const roles = useRoles();
  const role = roles.data?.data.find((row) => row.id === roleId);
  const canManage = holdsAny(access, ["access.role.manage"]);

  if (roles.isPending)
    return (
      <RoleFrame title={t("common.loading")}>
        <div aria-busy="true" className="grid gap-2">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      </RoleFrame>
    );

  if (roles.isError)
    return (
      <RoleFrame title={t("access.role.notFound")}>
        <Card className="p-0">
          <ErrorState onRetry={() => void roles.refetch()} />
        </Card>
      </RoleFrame>
    );

  if (!role)
    return (
      <RoleFrame title={t("access.role.notFound")}>
        <Card className="p-0">
          <EmptyState
            icon={ShieldCheck}
            title={t("access.role.notFound")}
            description={t("access.roles.emptyHint")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/akses">{t("access.role.back")}</Link>
              </Button>
            }
          />
        </Card>
      </RoleFrame>
    );

  if (role.isTemplate) return <TemplateRole role={role} access={access} />;
  return (
    <CustomRoleEditor
      role={role}
      canManage={canManage}
      viewerUserId={viewerUserId}
    />
  );
}

export function CreateCustomRolePage({
  access,
  viewerUserId,
}: {
  access: AreaAccess;
  viewerUserId?: string;
}) {
  const t = useT();
  if (!holdsAny(access, ["access.role.manage"]))
    return (
      <RoleFrame title={t("access.role.createTitle")}>
        <Card className="p-0">
          <EmptyState
            title={t("access.errors.forbid")}
            description={t("access.roles.readOnlyTemplate")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/akses">{t("access.role.back")}</Link>
              </Button>
            }
          />
        </Card>
      </RoleFrame>
    );
  return <CustomRoleEditor canManage viewerUserId={viewerUserId} />;
}

function TemplateRole({ role, access }: { role: Role; access: AreaAccess }) {
  const t = useT();
  const template = role.templateKey ? roleTemplate(role.templateKey) : null;
  return (
    <RoleFrame
      title={role.name}
      actions={
        holdsAny(access, ["access.role.manage"]) && (
          <Button asChild variant="outline" size="sm">
            <Link to="/kelola/akses/baru">
              <Plus aria-hidden="true" />
              {t("access.roles.create")}
            </Link>
          </Button>
        )
      }
    >
      <Card className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{t("access.roles.kindTemplate")}</Badge>
          <Badge tone={role.mfaRequired ? "success" : "neutral"}>
            {t(
              role.mfaRequired
                ? "access.roles.mfaRequired"
                : "access.roles.mfaOptional",
            )}
          </Badge>
        </div>
        <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
          {t("access.role.templateNote")}
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="type-eyebrow text-muted-foreground">
              {t("access.role.scopeTitle")}
            </dt>
            <dd className="text-sm text-muted-foreground">
              {role.allowedScopeTypes
                .map((type) => t(SCOPE_LABEL_KEY[type]))
                .join(" · ")}
            </dd>
          </div>
          {template && (
            <div className="grid gap-1">
              <dt className="type-eyebrow text-muted-foreground">
                {t("access.role.accessLimit")}
              </dt>
              <dd className="text-sm text-muted-foreground">
                {template.prdAccessLimit}
              </dd>
            </div>
          )}
        </dl>
      </Card>
      <Card className="grid gap-3">
        <div className="grid gap-1">
          <h2 className="type-heading">{t("access.role.permissionsTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("access.role.permissionsReadOnlyHint")}
          </p>
        </div>
        <PermissionReadOnlyList codes={role.permissions} />
      </Card>
    </RoleFrame>
  );
}

function CustomRoleEditor({
  role,
  canManage,
  viewerUserId,
}: {
  role?: Role;
  canManage: boolean;
  viewerUserId?: string;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const createRole = useCreateCustomRole();
  const updateRole = useUpdateCustomRole(role?.id ?? "");
  const mutation = role ? updateRole : createRole;
  const now = useNow();
  const allRoles = useRoles();
  const viewerAssignments = useViewerAssignments(viewerUserId);
  const verify = useVerifyMfaFactor();

  const [name, setName] = React.useState(role?.name ?? "");
  const [scopes, setScopes] = React.useState<ScopeType[]>(
    role ? [...role.allowedScopeTypes] : ["outlet"],
  );
  const [permissions, setPermissions] = React.useState<PermissionCode[]>(
    role ? [...role.permissions] : [],
  );
  const [mfaRequested, setMfaRequested] = React.useState(
    role?.mfaRequired ?? false,
  );
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [reauthAt, setReauthAt] = React.useState<Date | null>(null);
  // Bumped on every request to show the block, so a block that is already open
  // is scrolled to and focused again.
  const [reauthTick, setReauthTick] = React.useState(0);
  // Permissions added by the save that failed, kept so the error text does not
  // change while the form is edited afterwards.
  const [failedAdded, setFailedAdded] = React.useState<
    PermissionCode[] | undefined
  >(undefined);
  const reauthRef = React.useRef<HTMLDivElement>(null);
  const codeInputRef = React.useRef<HTMLInputElement>(null);
  const noticeRef = React.useRef<HTMLParagraphElement>(null);
  const [otpCode, setOtpCode] = React.useState("");
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const factors = useMfaFactors(reauthOpen);
  const totpFactor = factors.data?.data.find((row) => row.type === "totp");

  const mfaForced = customRoleMfaRequired(permissions);
  const readOnly = !canManage;

  // Only offer what the API will accept (assertCanEditCustomRole, legend-tj8o):
  // permissions the editor holds at tenant scope, or every tenant permission
  // for a tenant Owner / Admin Tenant (who must re-authenticate on save).
  // While the viewer's own assignments load or failed nothing is held, which
  // fails closed.
  const checkState: "ready" | "loading" | "error" =
    viewerAssignments.isError || allRoles.isError
      ? "error"
      : viewerUserId === undefined ||
          (viewerAssignments.isSuccess && allRoles.isSuccess)
        ? "ready"
        : "loading";
  const check = React.useMemo(
    () => ({
      viewerUserId,
      viewerAssignments:
        checkState === "ready" ? (viewerAssignments.data?.data ?? []) : [],
      roles: checkState === "ready" ? (allRoles.data?.data ?? []) : [],
      now,
    }),
    [checkState, viewerUserId, viewerAssignments.data, allRoles.data, now],
  );
  const held = React.useMemo(() => heldAtTenantScope(check), [check]);
  const topAuthority = React.useMemo(
    () => viewerHoldsTopAuthority(check),
    [check],
  );
  const addable = React.useMemo(
    () => permissionsViewerMayAdd({ held, topAuthority }),
    [held, topAuthority],
  );
  const original = role?.permissions ?? [];
  // The API refuses to drop MFA from a role the editor holds themselves
  // (SELF_ELEVATION_FORBIDDEN), so the switch stays on for that role.
  const mfaHeldSelf =
    role !== undefined &&
    role.mfaRequired &&
    viewerHoldsRole(check.viewerAssignments, role.id, now);
  const mfaRequired = mfaForced || mfaHeldSelf || mfaRequested;
  const limited = !topAuthority;
  const reauthMinutes = Math.round(ROLE_GRANT_REAUTH_MAX_AGE_MS / 60_000);

  const blockReason = (code: PermissionCode) => {
    if (readOnly) return null;
    const state = { selected: permissions, addable, original };
    if (checkState !== "ready")
      return canSelectPermission(code, state) ? null : ("checking" as const);
    return permissionBlockReason(code, state);
  };

  const openReauth = () => {
    setReauthAt(null);
    setReauthOpen(true);
    setReauthTick((tick) => tick + 1);
  };

  const askReauth = () => {
    mutation.reset();
    openReauth();
  };

  // A fresh verification only counts for ROLE_GRANT_REAUTH_MAX_AGE_MS: drop it
  // (and its status text) when it runs out.
  React.useEffect(() => {
    if (reauthAt === null) return;
    const timer = window.setTimeout(
      () => setReauthAt(null),
      Math.max(
        0,
        reauthAt.getTime() + ROLE_GRANT_REAUTH_MAX_AGE_MS - Date.now(),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [reauthAt]);

  // Bring the re-verify block into view and put focus where the next step is:
  // the code field, or the text when there is no factor or loading failed.
  React.useEffect(() => {
    if (reauthTick === 0 || !reauthOpen || factors.isPending) return;
    const block = reauthRef.current;
    if (!block) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    block.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    (totpFactor ? codeInputRef.current : noticeRef.current)?.focus({
      preventScroll: true,
    });
  }, [reauthTick, reauthOpen, factors.isPending, factors.isError, totpFactor]);

  const afterSave = () => {
    setReauthOpen(false);
    setReauthAt(null);
    setOtpCode("");
    setVerifyError(null);
    setFailedAdded(undefined);
  };

  const verifyCode = () => {
    if (!totpFactor) return;
    if (!/^\d{6}$/.test(otpCode)) {
      setVerifyError(t("access.grant.reauthCodeError"));
      return;
    }
    setVerifyError(null);
    verify.mutate(
      { factorId: totpFactor.id, code: otpCode },
      {
        onSuccess: () => {
          setReauthAt(new Date());
          setOtpCode("");
        },
        onError: (failure) => setVerifyError(accessErrorMessage(failure, t)),
      },
    );
  };

  const onSaveError = (failure: unknown, added: readonly PermissionCode[]) => {
    setFailedAdded([...added]);
    // The held roles may have changed since the page loaded.
    void viewerAssignments.refetch();
    void allRoles.refetch();
    // SELF_ELEVATION_FORBIDDEN asks for a re-auth only when the edit adds a
    // permission the editor does not hold; with none added it is the MFA rule.
    if (
      topAuthority &&
      failure instanceof ApiError &&
      failure.code === "SELF_ELEVATION_FORBIDDEN" &&
      added.some((code) => !held.includes(code))
    )
      openReauth();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: FormErrors = {};
    if (name.trim() === "") next.name = t("access.role.noName");
    if (permissions.length === 0)
      next.permissions = t("access.role.noPermissions");
    if (scopes.length === 0) next.scope = t("access.role.noScope");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Owner / Admin Tenant adding permissions they do not hold: the API wants a
    // re-authentication within ROLE_GRANT_REAUTH_MAX_AGE_MS first.
    const added = permissions.filter((code) => !original.includes(code));
    if (
      roleEditNeedsReauth({
        topAuthority,
        held,
        added,
        reauthenticatedAt: reauthAt,
        now: new Date(),
      })
    ) {
      askReauth();
      return;
    }

    const body = {
      name: name.trim(),
      permissions,
      allowedScopeTypes: scopes,
      mfaRequired,
    };
    if (role) {
      updateRole.mutate(body, {
        onSuccess: () => {
          afterSave();
          toast({ title: t("access.role.saved") });
        },
        onError: (failure) => onSaveError(failure, added),
      });
      return;
    }
    createRole.mutate(body, {
      onSuccess: (created) => {
        afterSave();
        toast({ title: t("access.role.created") });
        void navigate({
          to: "/kelola/akses/role/$roleId",
          params: { roleId: created.data.id },
        });
      },
      onError: (failure) => onSaveError(failure, added),
    });
  };

  return (
    <RoleFrame title={role ? role.name : t("access.role.createTitle")}>
      <form className="grid min-w-0 gap-4" onSubmit={submit} noValidate>
        <Card className="grid gap-4">
          <div className="grid gap-1">
            <h2 className="type-heading">{t("access.role.identity")}</h2>
            <p className="text-sm text-muted-foreground">
              {role
                ? t("access.role.customNote")
                : t("access.role.createSubtitle")}
            </p>
          </div>
          <FormField
            label={t("access.role.name")}
            hint={t("access.role.nameHint")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              disabled={readOnly}
              autoComplete="off"
            />
          </FormField>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              {t("access.role.scopeTitle")}
            </legend>
            <p className="text-sm text-muted-foreground">
              {t("access.role.scopeHint")}
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {SCOPE_TYPES.map((type) => {
                const id = `scope-${type}`;
                const checked = scopes.includes(type);
                return (
                  <label
                    key={type}
                    htmlFor={id}
                    className="flex min-h-control-sm cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 hover:bg-surface-2"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={readOnly}
                      onCheckedChange={() =>
                        setScopes((current) =>
                          current.includes(type)
                            ? current.filter((row) => row !== type)
                            : [...current, type],
                        )
                      }
                    />
                    <span className="text-(length:--density-text)">
                      {t(SCOPE_LABEL_KEY[type])}
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.scope && (
              <p className="text-sm text-danger" role="alert">
                {errors.scope}
              </p>
            )}
          </fieldset>

          <div className="flex items-start justify-between gap-4 rounded-container bg-surface-2 p-3">
            <div className="grid gap-1">
              <Label htmlFor="role-mfa">{t("access.role.mfaTitle")}</Label>
              <p id="role-mfa-hint" className="text-sm text-muted-foreground">
                {mfaHeldSelf
                  ? t("access.role.mfaHeldSelf")
                  : mfaForced
                    ? t("access.role.mfaForced")
                    : t("access.role.mfaHint")}
              </p>
            </div>
            <Switch
              id="role-mfa"
              checked={mfaRequired}
              disabled={readOnly || mfaForced || mfaHeldSelf}
              onCheckedChange={setMfaRequested}
              aria-describedby={mfaHeldSelf ? "role-mfa-hint" : undefined}
            />
          </div>
        </Card>

        <Card className="grid gap-3">
          <div className="grid gap-1">
            <h2 className="type-heading">
              {t("access.role.permissionsTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("access.role.permissionsHint")}
            </p>
            {!readOnly && checkState === "loading" && (
              <p className="text-sm text-muted-foreground" role="status">
                {t("access.role.permissionsChecking")}
              </p>
            )}
            {!readOnly && checkState === "error" && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-danger" role="alert">
                  {t("access.role.permissionsCheckError")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (viewerAssignments.isError)
                      void viewerAssignments.refetch();
                    if (allRoles.isError) void allRoles.refetch();
                  }}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {!readOnly && checkState === "ready" && limited && (
              <p className="text-sm text-muted-foreground">
                {t("access.role.permissionsLimitedHint")}
              </p>
            )}
          </div>
          <PermissionChecklist
            selected={permissions}
            blockReason={blockReason}
            onToggle={(code) =>
              blockReason(code) !== null
                ? undefined
                : setPermissions((current) => togglePermission(current, code))
            }
          />
          {reauthOpen && (
            <div ref={reauthRef} className="grid gap-2 rounded-md border p-3">
              <p className="text-sm text-muted-foreground">
                {t("access.role.reauthHint", { minutes: reauthMinutes })}
              </p>
              {reauthAt === null && !mutation.isError && (
                <p className="text-sm text-danger" role="alert">
                  {t("access.errors.reauthRequired")}
                </p>
              )}
              {factors.isPending ? (
                <div aria-busy="true" className="grid gap-2">
                  <span className="sr-only">{t("common.loading")}</span>
                  <Skeleton className="h-control" />
                </div>
              ) : factors.isError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    ref={noticeRef}
                    tabIndex={-1}
                    className="text-sm text-danger focus-visible:outline-none"
                    role="alert"
                  >
                    {t("access.grant.reauthUnavailable")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void factors.refetch()}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              ) : totpFactor ? (
                <div className="grid gap-2">
                  <FormField
                    label={t("access.grant.reauthCode")}
                    error={verifyError ?? undefined}
                    required
                  >
                    <Input
                      ref={codeInputRef}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={otpCode}
                      onChange={(event) =>
                        setOtpCode(
                          event.target.value.replace(/\D/g, "").slice(0, 6),
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        verifyCode();
                      }}
                      disabled={reauthAt !== null}
                      className="tabular tracking-[0.3em]"
                    />
                  </FormField>
                  {reauthAt === null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={verify.isPending}
                      disabled={otpCode.length !== 6}
                      onClick={verifyCode}
                    >
                      {t("access.grant.reauthSend")}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid gap-1">
                  <p
                    ref={noticeRef}
                    tabIndex={-1}
                    className="text-sm font-semibold focus-visible:outline-none"
                  >
                    {t("access.grant.reauthNoFactor")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("access.role.reauthNoFactorHint")}
                  </p>
                </div>
              )}
            </div>
          )}
          {/* Live region stays mounted (empty) so the text is announced. */}
          <div role="status" className="empty:hidden">
            {reauthOpen && reauthAt !== null && (
              <p className="text-sm text-success">
                {t("access.role.reauthDone")}
              </p>
            )}
          </div>
          {errors.permissions && (
            <p className="text-sm text-danger" role="alert">
              {errors.permissions}
            </p>
          )}
        </Card>

        {mutation.isError && (
          <p className="text-sm text-danger" role="alert">
            {roleEditorErrorMessage(mutation.error, t, {
              topAuthority,
              added: failedAdded,
            })}
          </p>
        )}

        <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-3 sm:-mx-6 sm:px-6">
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={readOnly}
          >
            {role ? t("access.role.save") : t("access.role.create")}
          </Button>
          <Button asChild variant="outline" type="button">
            <Link to="/kelola/akses">{t("access.role.back")}</Link>
          </Button>
        </div>
      </form>
    </RoleFrame>
  );
}
