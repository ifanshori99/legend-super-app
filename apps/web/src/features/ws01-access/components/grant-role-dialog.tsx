// Grant a role: user, role, scope, validity, then a fresh second factor
// (PRD v1.7 §3 F7 "Pemberian Role — memerlukan autentikasi ulang"; AUTH-05).
// The dialog verifies the TOTP code through POST /api/auth/mfa/verify, which
// marks this session MFA-verified; the grant request itself carries no code
// (grantRoleSchema is strict), so the API reads the session state.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_GRANT_REAUTH_MAX_AGE_MS } from "@starter/shared/access";
import type {
  AssignmentScope,
  Role,
  RoleId,
  ScopeType,
} from "@starter/shared/access";
import type { UserId } from "@starter/shared/core";
import { accessErrorMessage } from "../errors";
import {
  grantableRoles,
  scopeName,
  scopeOptionsForRole,
  SCOPE_LABEL_KEY,
  SCOPE_TYPES,
  validityIsOrdered,
  type ScopeLookup,
} from "../lib";
import {
  useGrantRole,
  useMfaFactors,
  useNow,
  useVerifyMfaFactor,
  useViewerAssignments,
} from "../hooks";
import type { AssignablePerson } from "../people";

type Step = 1 | 2 | 3;

function toIso(local: string): string | undefined {
  if (local === "") return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildScope(type: ScopeType, id: string): AssignmentScope {
  if (type === "tenant") return { type: "tenant", id: null };
  return { type, id } as unknown as AssignmentScope;
}

export function GrantRoleDialog({
  open,
  onOpenChange,
  roles,
  people,
  lookup,
  viewerUserId,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly Role[];
  people: readonly AssignablePerson[];
  lookup: ScopeLookup;
  /** The signed-in user's id (session), used to mirror the grant rules. */
  viewerUserId?: string;
  onGranted?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const grant = useGrantRole();
  const verify = useVerifyMfaFactor();
  const now = useNow();
  const viewerAssignments = useViewerAssignments(viewerUserId);

  const [step, setStep] = React.useState<Step>(1);
  const [userId, setUserId] = React.useState("");
  const [roleId, setRoleId] = React.useState("");
  const [scopeType, setScopeType] = React.useState<ScopeType>("tenant");
  const [scopeId, setScopeId] = React.useState("");
  const [validFrom, setValidFrom] = React.useState("");
  const [validUntil, setValidUntil] = React.useState("");
  const [code, setCode] = React.useState("");
  const [verified, setVerified] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);

  // Only offer roles the API accepts (assertCanGrantRole, legend-wc69d); while
  // the viewer's assignments load or failed nothing is held, which fails closed.
  const grantable = React.useMemo(
    () =>
      grantableRoles({
        roles,
        viewerUserId,
        viewerAssignments: viewerAssignments.data?.data ?? [],
        now,
      }),
    [roles, viewerUserId, viewerAssignments.data, now],
  );
  const role = roles.find((row) => row.id === roleId);
  const allowedScopes = role ? scopeOptionsForRole(role) : SCOPE_TYPES;
  const factors = useMfaFactors(open && step === 3);
  const totpFactor = factors.data?.data.find((row) => row.type === "totp");

  const targetOptions = React.useMemo(() => {
    if (scopeType === "tenant") return [];
    const map =
      scopeType === "brand"
        ? lookup.brands
        : scopeType === "outlet"
          ? lookup.outlets
          : lookup.stations;
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [scopeType, lookup]);

  const reset = () => {
    setStep(1);
    setUserId("");
    setRoleId("");
    setScopeType("tenant");
    setScopeId("");
    setValidFrom("");
    setValidUntil("");
    setCode("");
    setVerified(false);
    setError(null);
    setVerifyError(null);
  };

  const changeOpen = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const pickRole = (nextRoleId: string) => {
    setRoleId(nextRoleId);
    const nextRole = roles.find((row) => row.id === nextRoleId);
    const allowed = nextRole ? scopeOptionsForRole(nextRole) : SCOPE_TYPES;
    if (!allowed.includes(scopeType)) {
      setScopeType(allowed[0] ?? "tenant");
      setScopeId("");
    }
  };

  const next = () => {
    setError(null);
    if (step === 1) {
      if (userId === "" || roleId === "") {
        setError(t("access.grant.pickUser"));
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (scopeType !== "tenant" && scopeId === "") {
        setError(t("access.grant.pickScope"));
        return;
      }
      if (
        !validityIsOrdered(toIso(validFrom) ?? null, toIso(validUntil) ?? null)
      ) {
        setError(t("access.grant.invalidValidity"));
        return;
      }
      setStep(3);
    }
  };

  const verifyCode = () => {
    if (!totpFactor) return;
    if (!/^\d{6}$/.test(code)) {
      setVerifyError(t("access.grant.reauthCodeError"));
      return;
    }
    setVerifyError(null);
    verify.mutate(
      { factorId: totpFactor.id, code },
      {
        onSuccess: () => setVerified(true),
        onError: (failure) => setVerifyError(accessErrorMessage(failure, t)),
      },
    );
  };

  const submit = () => {
    if (!verified) {
      setError(t("access.grant.reauthRequired"));
      return;
    }
    setError(null);
    grant.mutate(
      {
        userId: userId as UserId,
        roleId: roleId as RoleId,
        scope: buildScope(scopeType, scopeId),
        validFrom: toIso(validFrom),
        validUntil: toIso(validUntil) ?? null,
      },
      {
        onSuccess: () => {
          toast({ title: t("access.grant.granted") });
          onGranted?.();
          changeOpen(false);
        },
        onError: (failure) => setError(accessErrorMessage(failure, t)),
      },
    );
  };

  const reauthMinutes = Math.round(ROLE_GRANT_REAUTH_MAX_AGE_MS / 60_000);
  const person = people.find((row) => row.id === userId);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("access.grant.title")}</DialogTitle>
          <DialogDescription>{t("access.grant.description")}</DialogDescription>
        </DialogHeader>

        <ol className="grid gap-1 text-sm sm:grid-cols-3">
          {(
            [
              [1, "access.grant.stepSubject"],
              [2, "access.grant.stepScope"],
              [3, "access.grant.stepReauth"],
            ] as const
          ).map(([index, key]) => (
            <li
              key={index}
              aria-current={step === index ? "step" : undefined}
              className={
                step === index
                  ? "flex items-center gap-2 rounded-control bg-primary-tint px-2 py-1.5 font-semibold"
                  : "flex items-center gap-2 px-2 py-1.5 text-muted-foreground"
              }
            >
              <span className="grid size-5 shrink-0 place-items-center rounded-full border text-xs tabular">
                {index}
              </span>
              {t(key)}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="grid gap-3">
            {people.length === 0 ? (
              <div className="grid gap-1 rounded-md border p-3">
                <p className="text-sm font-semibold">
                  {t("access.grant.usersUnavailable")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("access.grant.usersUnavailableHint")}
                </p>
              </div>
            ) : (
              <FormField label={t("access.grant.user")} required>
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("access.grant.userPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            <FormField label={t("access.grant.role")} required>
              <Select value={roleId} onValueChange={pickRole}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("access.grant.rolePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {grantable.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-3">
            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">
                {t("access.grant.scope")}
              </legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {SCOPE_TYPES.map((type) => {
                  const allowed = allowedScopes.includes(type);
                  const id = `grant-scope-${type}`;
                  return (
                    <label
                      key={type}
                      htmlFor={id}
                      className={
                        allowed
                          ? "flex min-h-control-sm cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 hover:bg-surface-2"
                          : "flex min-h-control-sm cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 opacity-50"
                      }
                    >
                      <input
                        id={id}
                        type="radio"
                        name="grant-scope"
                        className="size-check accent-primary"
                        checked={scopeType === type}
                        disabled={!allowed}
                        onChange={() => {
                          setScopeType(type);
                          setScopeId("");
                        }}
                      />
                      <span className="text-(length:--density-text)">
                        {t(SCOPE_LABEL_KEY[type])}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                {t("access.grant.roleScopeNote")}
              </p>
            </fieldset>

            {scopeType !== "tenant" && (
              <FormField label={t("access.grant.scopeTarget")} required>
                <Select value={scopeId} onValueChange={setScopeId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t("access.grant.scopeValue", {
                        type: t(SCOPE_LABEL_KEY[scopeType]),
                      })}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        {t("access.grant.scopeNone", {
                          type: t(SCOPE_LABEL_KEY[scopeType]),
                        })}
                      </SelectItem>
                    ) : (
                      targetOptions.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t("access.grant.validFrom")}>
                <Input
                  type="datetime-local"
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.target.value)}
                />
              </FormField>
              <FormField label={t("access.grant.validUntil")}>
                <Input
                  type="datetime-local"
                  value={validUntil}
                  onChange={(event) => setValidUntil(event.target.value)}
                />
              </FormField>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("access.grant.validityHint")}
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="grid gap-3">
            <div className="grid gap-1 rounded-md border p-3">
              <p className="text-sm font-semibold">
                {t("access.grant.reauthTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("access.grant.reauthHint", { minutes: reauthMinutes })}
              </p>
            </div>
            <dl className="grid gap-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("access.grant.user")}
                </dt>
                <dd className="font-semibold">{person?.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("access.grant.role")}
                </dt>
                <dd className="font-semibold">{role?.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {t("access.grant.scope")}
                </dt>
                <dd className="text-right font-semibold">
                  {scopeType === "tenant"
                    ? t("access.assignments.scopeTenant")
                    : (scopeName(buildScope(scopeType, scopeId), lookup) ??
                      t(SCOPE_LABEL_KEY[scopeType]))}
                </dd>
              </div>
            </dl>

            {factors.isPending ? (
              <div aria-busy="true" className="grid gap-2">
                <span className="sr-only">{t("common.loading")}</span>
                <Skeleton className="h-control" />
              </div>
            ) : totpFactor ? (
              <div className="grid gap-2">
                <FormField
                  label={t("access.grant.reauthCode")}
                  error={verifyError ?? undefined}
                  required
                >
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    disabled={verified}
                    className="tabular tracking-[0.3em]"
                  />
                </FormField>
                {verified ? (
                  <p className="text-sm text-success" role="status">
                    {t("access.grant.reauthDone")}
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={verify.isPending}
                    disabled={code.length !== 6}
                    onClick={verifyCode}
                  >
                    {t("access.grant.reauthSend")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid gap-1 rounded-md border p-3" role="status">
                <p className="text-sm font-semibold">
                  {t("access.grant.reauthNoFactor")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("access.grant.reauthNoFactorHint")}
                </p>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setError(null);
                setStep((step - 1) as Step);
              }}
            >
              {t("access.grant.back")}
            </Button>
          )}
          {step < 3 ? (
            <Button type="button" onClick={next}>
              {t("access.grant.next")}
            </Button>
          ) : (
            <Button
              type="button"
              loading={grant.isPending}
              disabled={!verified}
              onClick={submit}
            >
              {t("access.grant.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
