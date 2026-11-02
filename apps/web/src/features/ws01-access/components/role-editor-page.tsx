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
import { roleTemplate } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useCreateCustomRole, useRoles, useUpdateCustomRole } from "../hooks";
import { accessErrorMessage } from "../errors";
import {
  customRoleMfaRequired,
  SCOPE_LABEL_KEY,
  SCOPE_TYPES,
  togglePermission,
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
}: {
  roleId: string;
  access: AreaAccess;
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
  return <CustomRoleEditor role={role} canManage={canManage} />;
}

export function CreateCustomRolePage({ access }: { access: AreaAccess }) {
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
  return <CustomRoleEditor canManage />;
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
}: {
  role?: Role;
  canManage: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const createRole = useCreateCustomRole();
  const updateRole = useUpdateCustomRole(role?.id ?? "");
  const mutation = role ? updateRole : createRole;

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

  const mfaForced = customRoleMfaRequired(permissions);
  const mfaRequired = mfaForced || mfaRequested;
  const readOnly = !canManage;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: FormErrors = {};
    if (name.trim() === "") next.name = t("access.role.noName");
    if (permissions.length === 0)
      next.permissions = t("access.role.noPermissions");
    if (scopes.length === 0) next.scope = t("access.role.noScope");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body = {
      name: name.trim(),
      permissions,
      allowedScopeTypes: scopes,
      mfaRequired,
    };
    if (role) {
      updateRole.mutate(body, {
        onSuccess: () => toast({ title: t("access.role.saved") }),
      });
      return;
    }
    createRole.mutate(body, {
      onSuccess: (created) => {
        toast({ title: t("access.role.created") });
        void navigate({
          to: "/kelola/akses/role/$roleId",
          params: { roleId: created.data.id },
        });
      },
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
              <p className="text-sm text-muted-foreground">
                {mfaForced
                  ? t("access.role.mfaForced")
                  : t("access.role.mfaHint")}
              </p>
            </div>
            <Switch
              id="role-mfa"
              checked={mfaRequired}
              disabled={readOnly || mfaForced}
              onCheckedChange={setMfaRequested}
              aria-describedby={undefined}
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
          </div>
          <PermissionChecklist
            selected={permissions}
            onToggle={(code) =>
              readOnly
                ? undefined
                : setPermissions((current) => togglePermission(current, code))
            }
          />
          {errors.permissions && (
            <p className="text-sm text-danger" role="alert">
              {errors.permissions}
            </p>
          )}
        </Card>

        {mutation.isError && (
          <p className="text-sm text-danger" role="alert">
            {accessErrorMessage(mutation.error, t)}
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
