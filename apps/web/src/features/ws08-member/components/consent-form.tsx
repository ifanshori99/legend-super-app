import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert } from "lucide-react";
import type { ConsentPurpose, MemberOverview } from "@starter/shared/crm";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import {
  activeConsentFor,
  CONSENT_PURPOSES,
  policyVersionFor,
} from "../consent";
import { formatMemberDate } from "../format";
import { useUpdateConsent } from "../hooks";
import { MembershipRequirement, MembershipStatusBadge } from "./status-badge";

const COPY: Record<
  ConsentPurpose,
  { labelKey: MessageKey; hintKey: MessageKey }
> = {
  loyalty: {
    labelKey: "member.signup.loyaltyLabel",
    hintKey: "member.signup.loyaltyHint",
  },
  marketing: {
    labelKey: "member.signup.marketingLabel",
    hintKey: "member.signup.marketingHint",
  },
  ai: {
    labelKey: "member.signup.aiLabel",
    hintKey: "member.signup.aiHint",
  },
};

type Values = Record<ConsentPurpose, boolean>;

/**
 * Membership signup and versioned consents (PRD §2 "Persetujuan terpisah dan
 * berversi", §3.20 "Pendaftaran Member"). We save only the purposes the member
 * changed, with one POST per purpose; the overview refetch is the source of
 * truth for the badges.
 */
export function ConsentForm({ overview }: { overview: MemberOverview }) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateConsent();
  const initial: Values = {
    loyalty: activeConsentFor(overview.consents, "loyalty") !== undefined,
    marketing: activeConsentFor(overview.consents, "marketing") !== undefined,
    ai: activeConsentFor(overview.consents, "ai") !== undefined,
  };
  const [values, setValues] = useState<Values>(initial);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const changed = CONSENT_PURPOSES.filter(
    (purpose) => values[purpose] !== initial[purpose],
  );
  const verified = overview.profile.whatsappVerifiedAt !== null;
  const membershipActive = overview.profile.membershipStatus === "active";

  async function save() {
    setSaving(true);
    setFailed(false);
    try {
      for (const purpose of changed)
        await update.mutateAsync({
          purpose,
          granted: values[purpose],
          policyVersion: policyVersionFor(overview.consents, purpose),
        });
      toast({ title: t("member.signup.saved"), tone: "success" });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Card className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-brand type-title">
            {t("member.overview.membershipTitle")}
          </h2>
          <MembershipStatusBadge status={overview.profile.membershipStatus} />
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {membershipActive
            ? t("member.overview.membershipActive")
            : t("member.overview.membershipPending")}
        </p>

        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="type-heading">{t("member.signup.whatsappTitle")}</p>
            <Badge tone={verified ? "success" : "warning"}>
              {verified ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <CircleAlert aria-hidden="true" />
              )}
              {verified
                ? t("member.status.verified")
                : t("member.status.unverified")}
            </Badge>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {verified && overview.profile.whatsappVerifiedAt !== null
              ? t("member.signup.whatsappVerifiedBody", {
                  date: formatMemberDate(overview.profile.whatsappVerifiedAt),
                })
              : t("member.signup.whatsappUnverifiedBody")}
          </p>
          {!verified && (
            <Button asChild variant="outline" size="sm" className="w-fit">
              {/* legend-yoo9: finish signup here after /masuk. */}
              <Link to="/masuk" search={{ redirect: "/member/daftar" }}>
                {t("member.signup.whatsappUnverifiedAction")}
              </Link>
            </Button>
          )}
        </div>

        <div className="grid gap-1.5">
          <p className="type-heading">{t("member.signup.requirements")}</p>
          <ul className="grid gap-1.5">
            <MembershipRequirement met={verified}>
              {t("member.signup.requirementVerified")}
            </MembershipRequirement>
            <MembershipRequirement met={values.loyalty}>
              {t("member.signup.requirementLoyalty")}
            </MembershipRequirement>
          </ul>
        </div>
      </Card>

      <Card className="gap-4">
        <div className="grid gap-1">
          <h2 className="font-brand type-title">
            {t("member.signup.consentTitle")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("member.signup.consentIntro")}
          </p>
        </div>

        <div className="grid gap-4">
          {CONSENT_PURPOSES.map((purpose) => {
            const id = `member-consent-${purpose}`;
            return (
              <div key={purpose} className="flex min-h-11 items-start gap-3">
                <Checkbox
                  id={id}
                  checked={values[purpose]}
                  onCheckedChange={(checked) =>
                    setValues((current) => ({
                      ...current,
                      [purpose]: checked === true,
                    }))
                  }
                />
                <div className="grid gap-1">
                  <Label htmlFor={id}>{t(COPY[purpose].labelKey)}</Label>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t(COPY[purpose].hintKey)}
                  </p>
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t("member.signup.policyVersion", {
                      version: policyVersionFor(overview.consents, purpose),
                    })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {!values.loyalty && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-container bg-warning-subtle px-3 py-2 text-sm leading-5 text-warning"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("member.signup.withdrawalWarning")}
          </p>
        )}

        {failed && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {t("member.signup.saveError")}
          </p>
        )}

        <Button
          onClick={save}
          loading={saving}
          disabled={changed.length === 0}
          className="w-fit"
        >
          {t("member.signup.save")}
        </Button>
      </Card>
    </div>
  );
}
