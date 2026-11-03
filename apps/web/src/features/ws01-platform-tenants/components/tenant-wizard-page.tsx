// Create-tenant wizard (PRD v1.7 §4 Alur R "Super Admin Menambah Tenant Baru";
// §3 F4 "Hierarki Organisasi"; TEN-06: all of it is data from the panel).
// Steps: tenant -> brand -> outlet -> legal entity -> first tenant admin ->
// review. Each step validates with the contract's own zod schemas.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell, CardShellBody } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ApiError } from "@/lib/api/errors";
import { ProvisionError, usePackages, useProvisionTenant } from "../hooks";
import {
  assignablePackages,
  EMPTY_DRAFT,
  firstInvalidStep,
  normalizeOutletCode,
  normalizeWhatsapp,
  slugify,
  validateStep,
  WIZARD_STEPS,
  type FieldErrors,
  type WizardDraft,
  type WizardStep,
} from "../logic";

const k = (key: string) => `platformTenants.wizard.${key}` as MessageKey;

function Stepper({ current }: { current: number }) {
  const t = useT();
  return (
    <ol
      aria-label={t(k("stepperLabel"))}
      className="grid grid-cols-6 gap-1 sm:gap-2"
    >
      {WIZARD_STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className="grid min-w-0 gap-1.5"
          >
            <span
              className={cn(
                "h-1 rounded-full bg-surface-3",
                (done || active) && "bg-primary",
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "flex items-center gap-1 text-xs",
                active ? "font-semibold" : "text-muted-foreground",
              )}
            >
              {done ? (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <span className="tabular" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span className={cn("truncate", !active && "max-sm:sr-only")}>
                {t(`platformTenants.wizard.steps.${step}` as MessageKey)}
              </span>
              <span className="sr-only">
                {done ? t(k("stepDone")) : active ? t(k("stepCurrent")) : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TenantWizardPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const packages = usePackages();
  const provision = useProvisionTenant();
  const [rawDraft, setDraft] = React.useState<WizardDraft>(EMPTY_DRAFT);
  const [index, setIndex] = React.useState(0);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const step = WIZARD_STEPS[index];
  const options = assignablePackages(packages.data?.data ?? []);
  // Until the visitor picks, the first active package is the selection.
  const draft: WizardDraft = rawDraft.tenant.plan
    ? rawDraft
    : {
        ...rawDraft,
        tenant: { ...rawDraft.tenant, plan: options[0]?.key ?? "" },
      };

  const update = <K extends keyof WizardDraft>(
    section: K,
    patch: Partial<WizardDraft[K]>,
  ) => setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }));

  const next = () => {
    const found = validateStep(step, draft, options);
    setErrors(found);
    if (Object.keys(found).length === 0) setIndex((i) => i + 1);
  };
  const back = () => {
    setErrors({});
    setIndex((i) => Math.max(0, i - 1));
  };

  const submit = () => {
    const invalid = firstInvalidStep(draft, options);
    if (invalid) {
      setErrors(validateStep(invalid, draft, options));
      setIndex(WIZARD_STEPS.indexOf(invalid));
      return;
    }
    const pkg = options.find((p) => p.key === draft.tenant.plan);
    if (!pkg) return;
    setFailure(null);
    provision.mutate(
      { draft, pkg },
      {
        onSuccess: ({ tenant }) => {
          toast({ title: t(k("created"), { name: tenant.name }) });
          void navigate({
            to: "/platform/tenant/$tenantId",
            params: { tenantId: tenant.id },
          });
        },
        onError: (error) => {
          const cause = error instanceof ProvisionError ? error.cause : error;
          if (
            error instanceof ProvisionError &&
            error.stage === "tenant" &&
            cause instanceof ApiError &&
            cause.code === "CONFLICT"
          ) {
            setErrors({
              slug: "platformTenants.errors.slugTaken" as MessageKey,
            });
            setIndex(0);
            return;
          }
          setFailure(
            cause instanceof ApiError && cause.code === "NETWORK_ERROR"
              ? t(k("failedOffline"))
              : error instanceof ProvisionError && provision.getCreated()
                ? t(k("failedPartial"), {
                    name: provision.getCreated()?.name ?? "",
                  })
                : t(k("failed")),
          );
        },
      },
    );
  };

  const err = (field: keyof FieldErrors) =>
    errors[field] ? t(errors[field] as MessageKey) : undefined;

  return (
    <div className="mx-auto grid w-full max-w-3xl min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="/platform/tenant" aria-label={t(k("backToList"))}>
              <ArrowLeft aria-hidden="true" />
            </Link>
          </Button>
          <h2 className="type-title">{t(k("title"))}</h2>
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
      </div>
      <Stepper current={index} />

      {packages.isError ? (
        <Card className="p-0">
          <ErrorState onRetry={() => void packages.refetch()} />
        </Card>
      ) : packages.isPending ? (
        <div aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <CardShell>
          <CardShellBody className="p-card">
            <form
              noValidate
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (step === "review") submit();
                else next();
              }}
            >
              <div>
                <h3 className="type-title">
                  {t(`platformTenants.wizard.steps.${step}` as MessageKey)}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(`platformTenants.wizard.hint.${step}` as MessageKey)}
                </p>
              </div>

              {step === "tenant" && (
                <>
                  <FormField
                    label={t(k("tenantName"))}
                    error={err("tenantName")}
                    required
                  >
                    <Input
                      value={draft.tenant.name}
                      maxLength={150}
                      autoComplete="off"
                      onChange={(e) => {
                        const name = e.target.value;
                        update("tenant", {
                          name,
                          ...(draft.tenant.slugTouched
                            ? {}
                            : { slug: slugify(name) }),
                        });
                      }}
                    />
                  </FormField>
                  <FormField
                    label={t(k("slug"))}
                    hint={t(k("slugHint"))}
                    error={err("slug")}
                    required
                  >
                    <Input
                      value={draft.tenant.slug}
                      maxLength={60}
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(e) =>
                        update("tenant", {
                          slug: e.target.value.toLowerCase(),
                          slugTouched: true,
                        })
                      }
                    />
                  </FormField>
                  <FormField label={t(k("plan"))} error={err("plan")} required>
                    <Select
                      value={draft.tenant.plan}
                      onValueChange={(plan) => update("tenant", { plan })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t(k("planPlaceholder"))} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((pkg) => (
                          <SelectItem key={pkg.key} value={pkg.key}>
                            {pkg.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <div className="grid gap-1.5">
                    <Label>{t(k("mode"))}</Label>
                    <SegmentedControl
                      label={t(k("mode"))}
                      value={draft.tenant.deploymentMode}
                      onValueChange={(deploymentMode) =>
                        update("tenant", { deploymentMode })
                      }
                      options={[
                        {
                          value: "dedicated",
                          label: t("platformTenants.mode.dedicated"),
                        },
                        {
                          value: "shared",
                          label: t("platformTenants.mode.shared"),
                        },
                      ]}
                    />
                  </div>
                </>
              )}

              {step === "brand" && (
                <>
                  <FormField
                    label={t(k("brandName"))}
                    error={err("brandName")}
                    required
                  >
                    <Input
                      value={draft.brand.name}
                      maxLength={150}
                      autoComplete="off"
                      onChange={(e) => {
                        const name = e.target.value;
                        update("brand", {
                          name,
                          ...(draft.brand.slugTouched
                            ? {}
                            : { slug: slugify(name) }),
                        });
                      }}
                    />
                  </FormField>
                  <FormField
                    label={t(k("brandSlug"))}
                    hint={t(k("brandSlugHint"))}
                    error={err("brandSlug")}
                    required
                  >
                    <Input
                      value={draft.brand.slug}
                      maxLength={60}
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(e) =>
                        update("brand", {
                          slug: e.target.value.toLowerCase(),
                          slugTouched: true,
                        })
                      }
                    />
                  </FormField>
                </>
              )}

              {step === "outlet" && (
                <>
                  <FormField
                    label={t(k("outletName"))}
                    error={err("outletName")}
                    required
                  >
                    <Input
                      value={draft.outlet.name}
                      maxLength={150}
                      autoComplete="off"
                      onChange={(e) =>
                        update("outlet", { name: e.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t(k("outletCode"))}
                    hint={t(k("outletCodeHint"))}
                    error={err("outletCode")}
                    required
                  >
                    <Input
                      value={draft.outlet.code}
                      maxLength={20}
                      autoCapitalize="characters"
                      spellCheck={false}
                      onChange={(e) =>
                        update("outlet", {
                          code: normalizeOutletCode(e.target.value),
                        })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t(k("outletAddress"))}
                    error={err("outletAddress")}
                    required
                  >
                    <Textarea
                      value={draft.outlet.address}
                      rows={3}
                      maxLength={500}
                      onChange={(e) =>
                        update("outlet", { address: e.target.value })
                      }
                    />
                  </FormField>
                  <p className="text-sm text-muted-foreground">
                    {t(k("outletEntityNote"))}
                  </p>
                </>
              )}

              {step === "legal" && (
                <>
                  <FormField
                    label={t(k("legalName"))}
                    error={err("legalName")}
                    required
                  >
                    <Input
                      value={draft.legal.name}
                      maxLength={150}
                      autoComplete="off"
                      onChange={(e) =>
                        update("legal", { name: e.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t(k("npwp"))}
                    hint={t(k("npwpHint"))}
                    error={err("npwp")}
                    required={draft.legal.isPkp}
                  >
                    <Input
                      value={draft.legal.npwp}
                      inputMode="numeric"
                      maxLength={24}
                      autoComplete="off"
                      onChange={(e) =>
                        update("legal", { npwp: e.target.value })
                      }
                    />
                  </FormField>
                  <div className="flex min-h-11 items-center gap-3">
                    <Checkbox
                      id="legal-pkp"
                      checked={draft.legal.isPkp}
                      onCheckedChange={(checked) =>
                        update("legal", { isPkp: checked === true })
                      }
                    />
                    <Label htmlFor="legal-pkp">{t(k("pkp"))}</Label>
                  </div>
                  <FormField
                    label={t(k("legalAddress"))}
                    error={err("legalAddress")}
                  >
                    <Textarea
                      value={draft.legal.address}
                      rows={3}
                      maxLength={500}
                      onChange={(e) =>
                        update("legal", { address: e.target.value })
                      }
                    />
                  </FormField>
                </>
              )}

              {step === "admin" && (
                <>
                  <FormField
                    label={t(k("adminName"))}
                    error={err("adminName")}
                    required
                  >
                    <Input
                      value={draft.admin.name}
                      maxLength={150}
                      autoComplete="off"
                      onChange={(e) =>
                        update("admin", { name: e.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t(k("whatsapp"))}
                    hint={t(k("whatsappHint"))}
                    error={err("whatsapp")}
                    required
                  >
                    <Input
                      type="tel"
                      value={draft.admin.whatsapp}
                      inputMode="tel"
                      autoComplete="off"
                      onChange={(e) =>
                        update("admin", { whatsapp: e.target.value })
                      }
                    />
                  </FormField>
                  <FormField label={t(k("email"))} error={err("email")}>
                    <Input
                      type="email"
                      value={draft.admin.email}
                      maxLength={254}
                      autoComplete="off"
                      onChange={(e) =>
                        update("admin", { email: e.target.value })
                      }
                    />
                  </FormField>
                </>
              )}

              {step === "review" && (
                <Review
                  draft={draft}
                  packageName={
                    options.find((p) => p.key === draft.tenant.plan)?.name ?? ""
                  }
                  onEdit={(target) => {
                    setErrors({});
                    setIndex(WIZARD_STEPS.indexOf(target));
                  }}
                />
              )}

              {failure && (
                <p
                  role="alert"
                  className="rounded-control bg-danger-subtle p-3 text-sm font-medium text-danger"
                >
                  {failure}
                </p>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="outline"
                  onClick={back}
                  disabled={index === 0 || provision.isPending}
                >
                  {t("common.back")}
                </Button>
                <Button
                  type="submit"
                  aria-busy={provision.isPending || undefined}
                  disabled={provision.isPending}
                >
                  {step === "review"
                    ? t(failure ? k("retry") : k("submit"))
                    : t(k("continue"))}
                </Button>
              </div>
            </form>
          </CardShellBody>
        </CardShell>
      )}
    </div>
  );
}

function Review({
  draft,
  packageName,
  onEdit,
}: {
  draft: WizardDraft;
  packageName: string;
  onEdit: (step: WizardStep) => void;
}) {
  const t = useT();
  const npwp = draft.legal.npwp.replace(/\D/g, "");
  const rows: Array<{
    step: WizardStep;
    items: Array<[string, string]>;
  }> = [
    {
      step: "tenant",
      items: [
        [t(k("tenantName")), draft.tenant.name],
        [t(k("slug")), draft.tenant.slug],
        [t(k("plan")), packageName],
        [
          t(k("mode")),
          t(
            `platformTenants.mode.${draft.tenant.deploymentMode}` as MessageKey,
          ),
        ],
      ],
    },
    {
      step: "brand",
      items: [
        [t(k("brandName")), draft.brand.name],
        [t(k("brandSlug")), draft.brand.slug],
      ],
    },
    {
      step: "outlet",
      items: [
        [t(k("outletName")), draft.outlet.name],
        [t(k("outletCode")), draft.outlet.code],
        [t(k("outletAddress")), draft.outlet.address],
      ],
    },
    {
      step: "legal",
      items: [
        [t(k("legalName")), draft.legal.name],
        [
          t(k("npwp")),
          npwp
            ? `••••${npwp.slice(-4)}`
            : t("platformTenants.detail.npwpMissing"),
        ],
        [
          t(k("pkp")),
          draft.legal.isPkp
            ? t("platformTenants.detail.pkp")
            : t("platformTenants.detail.nonPkp"),
        ],
      ],
    },
    {
      step: "admin",
      items: [
        [t(k("adminName")), draft.admin.name],
        [t(k("whatsapp")), normalizeWhatsapp(draft.admin.whatsapp)],
        [t(k("email")), draft.admin.email.trim() || "-"],
      ],
    },
  ];
  return (
    <div className="grid gap-4">
      {rows.map((group) => (
        <section
          key={group.step}
          className="grid gap-2 rounded-control border-(length:--border-w) p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">
              {t(`platformTenants.wizard.steps.${group.step}` as MessageKey)}
            </h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEdit(group.step)}
            >
              {t(k("edit"))}
              <span className="sr-only">
                {t(`platformTenants.wizard.steps.${group.step}` as MessageKey)}
              </span>
            </Button>
          </div>
          <dl className="grid gap-2 sm:grid-cols-2">
            {group.items.map(([label, value]) => (
              <div key={label} className="grid gap-0.5">
                <dt className="type-eyebrow text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
