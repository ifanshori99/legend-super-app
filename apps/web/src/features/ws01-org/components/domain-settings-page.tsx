// Custom-domain verification (bead legend-az8z5; mockup
// design/mockups/platform/domain-verification.html). Lists the tenant's custom
// domains (GET /api/org/domains), adds one (POST, brand from /api/org/brands)
// and checks ownership (POST /:domainId/verify) against the TXT record the API
// returns in `verification`. States: loading, empty, add form, pending (with
// reserved / taken / not-found notices), success, load error.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Clock,
  Globe,
} from "lucide-react";
import type { TenantDomain } from "@starter/shared/platform";
import type { Translate } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOnline } from "@/lib/use-online";
import {
  DOMAIN_COPY,
  classifyDomainError,
  customDomains,
  domainScreen,
  domainView,
  validateHostname,
  type DomainNotice,
} from "../domain-state";
import {
  useAddDomain,
  useDomains,
  useOrgBrands,
  useVerifyDomain,
} from "../hooks";

/** Translate request notices at the UI boundary; classification stays pure. */
function requestNotice(error: unknown, t: Translate): DomainNotice {
  const keys = {
    verification_failed: [
      "orgDomain.notices.verificationFailedTitle",
      "orgDomain.notices.verificationFailedMessage",
    ],
    reserved: [
      "orgDomain.notices.unusableTitle",
      "orgDomain.notices.reservedMessage",
    ],
    taken: [
      "orgDomain.notices.unusableTitle",
      "orgDomain.notices.takenMessage",
    ],
    network: [
      "orgDomain.notices.networkTitle",
      "orgDomain.notices.networkMessage",
    ],
    unknown: [
      "orgDomain.notices.unknownTitle",
      "orgDomain.notices.unknownMessage",
    ],
  } as const;
  const [title, message] = keys[classifyDomainError(error)];
  return { title: t(title), message: t(message) };
}

export function DomainSettingsPage() {
  const t = useT();
  const online = useOnline();
  const domainsQuery = useDomains();
  const [adding, setAdding] = React.useState(false);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Link
        to="/kelola/pengaturan"
        className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t("orgDomain.settings")}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="type-title">{t("orgDomain.title")}</h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {t("orgDomain.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      {domainsQuery.isPending ? (
        <CardShell>
          <Card aria-busy="true">
            <CardHeader>
              <CardTitle>{t("orgDomain.loadingTitle")}</CardTitle>
              <CardDescription>
                {t("orgDomain.loadingDescription")}
              </CardDescription>
            </CardHeader>
            <span className="sr-only">{t("common.loading")}</span>
            <div className="grid gap-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          </Card>
        </CardShell>
      ) : domainsQuery.isError ? (
        <ErrorState
          error={domainsQuery.error}
          title={online ? undefined : t("orgDomain.notices.networkTitle")}
          description={
            online ? undefined : t("orgDomain.notices.networkMessage")
          }
          onRetry={() => void domainsQuery.refetch()}
        />
      ) : adding || domainScreen(domainsQuery.data.data) === "empty" ? (
        adding ? (
          <AddDomainForm
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardShell>
            <Card>
              <EmptyState
                icon={Globe}
                title={t("orgDomain.emptyTitle")}
                description={t("orgDomain.emptyDescription")}
                action={
                  <Button onClick={() => setAdding(true)}>
                    {t("orgDomain.actions.add")}
                  </Button>
                }
              />
            </Card>
          </CardShell>
        )
      ) : (
        <div className="grid min-w-0 gap-4">
          {customDomains(domainsQuery.data.data).map((domain) => (
            <DomainCard key={domain.id} domain={domain} />
          ))}
          <div>
            <Button variant="outline" onClick={() => setAdding(true)}>
              {t("orgDomain.actions.add")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NoticeBanner({
  tone,
  notice,
  silent,
}: {
  tone: "danger" | "success";
  notice: DomainNotice;
  /** Skip the own live role: the parent wraps it in a persistent live region. */
  silent?: boolean;
}) {
  const Icon = tone === "danger" ? CircleAlert : CircleCheck;
  return (
    <div
      role={silent ? undefined : tone === "danger" ? "alert" : "status"}
      className={[
        "flex min-w-0 items-start gap-2 rounded-control border-s-4 px-4 py-3 text-sm leading-5",
        tone === "danger"
          ? "border-danger bg-danger-subtle text-foreground"
          : "border-success bg-success-subtle text-foreground",
      ].join(" ")}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${tone === "danger" ? "text-danger" : "text-success"}`}
        aria-hidden="true"
      />
      <p className="min-w-0 [overflow-wrap:anywhere]">
        <strong>{notice.title}</strong> {notice.message}
      </p>
    </div>
  );
}

function AddDomainForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const brandsQuery = useOrgBrands();
  const addDomain = useAddDomain();
  const [hostname, setHostname] = React.useState("");
  const [brandId, setBrandId] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<DomainNotice | undefined>();

  const brands = brandsQuery.data?.data ?? [];
  const selectedBrand = brands.find((b) => b.id === brandId) ?? brands[0];

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setNotice(undefined);
    const check = validateHostname(hostname);
    if (!check.ok) {
      setFieldError(
        t(
          check.message === DOMAIN_COPY.hostnameRequired
            ? "orgDomain.form.required"
            : "orgDomain.form.invalid",
        ),
      );
      return;
    }
    if (!selectedBrand) return;
    setFieldError(undefined);
    addDomain.mutate(
      { brandId: selectedBrand.id, hostname: check.hostname },
      {
        onSuccess: onDone,
        onError: (error) => setNotice(requestNotice(error, t)),
      },
    );
  }

  if (brandsQuery.isPending)
    return (
      <CardShell>
        <Card aria-busy="true">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-11" />
        </Card>
      </CardShell>
    );
  if (brandsQuery.isError)
    return (
      <ErrorState
        error={brandsQuery.error}
        onRetry={() => void brandsQuery.refetch()}
      />
    );

  return (
    <div className="grid min-w-0 gap-4">
      {notice && <NoticeBanner tone="danger" notice={notice} />}
      <CardShell>
        <Card>
          <CardHeader>
            <CardTitle>{t("orgDomain.form.title")}</CardTitle>
            <CardDescription>{t("orgDomain.form.description")}</CardDescription>
          </CardHeader>
          <form
            onSubmit={submit}
            noValidate
            className="grid gap-4"
            aria-busy={addDomain.isPending || undefined}
          >
            {brands.length > 1 && (
              <FormField label={t("orgDomain.form.brand")} id="domain-brand">
                <Select
                  value={selectedBrand?.id ?? ""}
                  onValueChange={setBrandId}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            {brands.length === 0 && (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("orgDomain.form.noBrand")}
              </p>
            )}
            <FormField
              label={t("orgDomain.form.hostname")}
              id="domain-hostname"
              error={fieldError}
              required
            >
              <Input
                id="domain-hostname"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder={t("orgDomain.form.placeholder")}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
              />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                className="max-sm:w-full"
                disabled={addDomain.isPending || !selectedBrand}
              >
                {t("orgDomain.actions.continue")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="max-sm:w-full"
                onClick={onCancel}
              >
                {t("orgDomain.actions.cancel")}
              </Button>
            </div>
          </form>
        </Card>
      </CardShell>
    </div>
  );
}

function DomainCard({ domain }: { domain: TenantDomain }) {
  const t = useT();
  const verify = useVerifyDomain();
  const [notice, setNotice] = React.useState<DomainNotice | undefined>();
  const [justVerified, setJustVerified] = React.useState(false);
  const view = domainView(domain);

  function check() {
    setNotice(undefined);
    verify.mutate(domain.id, {
      onSuccess: () => setJustVerified(true),
      onError: (error) => setNotice(requestNotice(error, t)),
    });
  }

  const verified = view === "verified" || justVerified;

  return (
    <div className="grid min-w-0 gap-4">
      {/* Live region stays mounted so the success message is announced when it fills. */}
      <div role="status" aria-live="polite" className="empty:-mt-4">
        {justVerified && (
          <NoticeBanner
            silent
            tone="success"
            notice={{
              title: t("orgDomain.verification.successTitle"),
              message: t("orgDomain.verification.successMessage"),
            }}
          />
        )}
      </div>
      {verified ? (
        <CardShell>
          <Card>
            <DomainHeader domain={domain} verified />
            <div className="grid gap-1 border-t-(length:--border-w) border-border pt-4">
              <span className="text-sm font-semibold text-muted-foreground">
                {t("orgDomain.verification.title")}
              </span>
              <span className="font-semibold">
                {t("orgDomain.verification.found")}
              </span>
            </div>
          </Card>
        </CardShell>
      ) : (
        <>
          {notice && <NoticeBanner tone="danger" notice={notice} />}
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(15rem,0.8fr)] lg:items-start">
            <CardShell>
              <Card>
                <DomainHeader domain={domain} verified={false} />
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("orgDomain.verification.instruction")}
                </p>
                {!domain.verification && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("orgDomain.verification.noRecord")}
                  </p>
                )}
                {domain.verification && (
                  <dl className="grid min-w-0 gap-4 rounded-control border-(length:--border-w) border-border bg-surface-2 p-4">
                    <RecordRow
                      label={t("orgDomain.verification.type")}
                      value={domain.verification.type}
                    />
                    <RecordRow
                      label={t("orgDomain.verification.host")}
                      value={domain.verification.name}
                      copyLabel={t("orgDomain.actions.copyHost")}
                    />
                    <RecordRow
                      label={t("orgDomain.verification.value")}
                      value={domain.verification.value}
                      copyLabel={t("orgDomain.actions.copyValue")}
                    />
                  </dl>
                )}
                <div className="grid gap-2">
                  <Button
                    className="max-sm:w-full sm:w-fit"
                    onClick={check}
                    disabled={verify.isPending}
                    aria-busy={verify.isPending || undefined}
                  >
                    {t(
                      verify.isPending
                        ? "orgDomain.actions.checking"
                        : "orgDomain.actions.check",
                    )}
                  </Button>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("orgDomain.verification.propagation")}
                  </p>
                </div>
              </Card>
            </CardShell>
            <CardShell>
              <Card>
                <CardTitle>{t("orgDomain.help.title")}</CardTitle>
                <ol className="grid list-decimal gap-2 ps-5 text-sm leading-5">
                  <li>{t("orgDomain.help.openDns")}</li>
                  <li>{t("orgDomain.help.addRecord")}</li>
                  <li>
                    {t("orgDomain.help.saveAndCheck", {
                      action: t("orgDomain.actions.check"),
                    })}
                  </li>
                </ol>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("orgDomain.help.retry")}
                </p>
              </Card>
            </CardShell>
          </div>
        </>
      )}
    </div>
  );
}

function DomainHeader({
  domain,
  verified,
}: {
  domain: TenantDomain;
  verified: boolean;
}) {
  const t = useT();
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <h3 className="type-heading">{domain.hostname}</h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("orgDomain.title")}
        </p>
      </div>
      {verified ? (
        <Badge tone="success">
          <CircleCheck aria-hidden="true" />
          {t("orgDomain.verification.verified")}
        </Badge>
      ) : (
        <Badge tone="warning">
          <Clock aria-hidden="true" />
          {t("orgDomain.verification.pending")}
        </Badge>
      )}
    </div>
  );
}

function RecordRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  /** Accessible name of the copy button; omit for a row without one. */
  copyLabel?: string;
}) {
  const t = useT();
  const [feedback, setFeedback] = React.useState<string | undefined>();
  const clearTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  React.useEffect(() => () => clearTimeout(clearTimer.current), []);

  async function copy() {
    clearTimeout(clearTimer.current);
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(t("orgDomain.notices.copied"));
      clearTimer.current = setTimeout(() => setFeedback(undefined), 2000);
    } catch {
      setFeedback(t("orgDomain.notices.copyFailed"));
    }
  }

  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">
            {value}
          </span>
          {copyLabel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void copy()}
              aria-label={copyLabel}
            >
              {t("orgDomain.actions.copy")}
            </Button>
          )}
        </div>
        {copyLabel && (
          <p
            role="status"
            aria-live="polite"
            className="text-sm leading-5 text-muted-foreground empty:-mt-1"
          >
            {feedback}
          </p>
        )}
      </dd>
    </div>
  );
}
