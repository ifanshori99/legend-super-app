// Walk-in waitlist mode (?mode=antre; PRD v1.7 §3.22 "Waitlist Walk-in"): the
// guest joins the queue from the website, sees the quoted wait, and is told the
// staff will call their name. There is no public waitlist status or push
// endpoint yet — the staff device makes the call — so the screen promises only
// the on-site call (follow-up bead: guest waitlist status/push).
import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { normalizeWhatsAppNumber } from "@starter/shared/identity";
import type { JoinWaitlistResult } from "@starter/shared/reservation";
import type { PublicSite } from "@starter/shared/website";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
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
import { newIdempotencyKey } from "@/lib/idempotency";
import { useT } from "@/components/i18n";
import { useJoinWaitlist } from "../hooks";
import { MAX_PAX, validateGuestDetails } from "../lib";
import { zoneOptions } from "../zones";

const ANY_ZONE = "any";

type WaitlistErrors = Partial<Record<"name" | "phone", true>>;

export function WaitlistPanel({
  site,
  onBooking,
}: {
  site: PublicSite;
  onBooking: () => void;
}) {
  const t = useT();
  const zoneChoices = zoneOptions();
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [pax, setPax] = React.useState(2);
  const [zoneId, setZoneId] = React.useState(ANY_ZONE);
  const [errors, setErrors] = React.useState<WaitlistErrors>({});
  const [submitFailed, setSubmitFailed] = React.useState(false);
  const [result, setResult] = React.useState<JoinWaitlistResult | null>(null);
  /**
   * One Idempotency-Key per attempt: a retry of the same form reuses it, an
   * edited form mints a new one. Written only in the submit handler.
   */
  const attempt = React.useRef<{ fingerprint: string; key: string } | null>(
    null,
  );

  const join = useJoinWaitlist(site.outlet.id);
  /** `joinWaitlistInputSchema`: pax 1–60; the API re-checks it. */
  const paxValid = Number.isInteger(pax) && pax >= 1 && pax <= MAX_PAX;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const phoneIsValid = normalizeWhatsAppNumber(phone) !== null;
    const check = validateGuestDetails(
      { name, phone, note: "" },
      { phoneIsValid },
    );
    if (!check.ok) {
      setErrors({ name: check.errors.name, phone: check.errors.phone });
      setSubmitFailed(false);
      return;
    }
    setErrors({});
    setSubmitFailed(false);
    const body = {
      name: name.trim(),
      pax,
      contactPhone: phone.trim(),
      zoneId: zoneId === ANY_ZONE ? null : zoneId,
    };
    const fingerprint = JSON.stringify(body);
    const key =
      attempt.current?.fingerprint === fingerprint
        ? attempt.current.key
        : newIdempotencyKey();
    attempt.current = { fingerprint, key };
    join.mutate(
      { body, idempotencyKey: key },
      {
        onSuccess: (created) => setResult(created),
        onError: () => setSubmitFailed(true),
      },
    );
  };

  if (result)
    return (
      <Card>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <CardTitle>
              {t("reservationBooking.waitlist.resultTitle")}
            </CardTitle>
            <CardDescription>
              {t("reservationBooking.waitlist.call")}
            </CardDescription>
          </div>
          <p className="type-title">
            {t("reservationBooking.waitlist.estimate", {
              minutes: result.estimatedWaitMinutes,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setResult(null)}>
              {t("reservationBooking.waitlist.again")}
            </Button>
            <Button variant="outline" onClick={onBooking}>
              {t("reservationBooking.waitlist.toBooking")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );

  return (
    <form className="grid max-w-2xl gap-4" onSubmit={submit} noValidate>
      <Card>
        <CardContent className="grid gap-5">
          <div className="grid gap-1">
            <CardTitle>{t("reservationBooking.waitlist.title")}</CardTitle>
            <CardDescription>
              {t("reservationBooking.waitlist.lead")}
            </CardDescription>
          </div>

          <FormField
            label={t("reservationBooking.waitlist.name")}
            required
            error={
              errors.name ? t("reservationBooking.guest.errorName") : undefined
            }
          >
            <Input
              name="waitlistName"
              value={name}
              autoComplete="name"
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
            />
          </FormField>

          <FormField
            label={t("reservationBooking.waitlist.phone")}
            required
            hint={t("reservationBooking.guest.phoneHint")}
            error={
              errors.phone
                ? t("reservationBooking.guest.errorPhone")
                : undefined
            }
          >
            <Input
              name="waitlistPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              placeholder={t("reservationBooking.guest.phonePlaceholder")}
              onChange={(event) => {
                setPhone(event.target.value);
                setErrors((current) => ({ ...current, phone: undefined }));
              }}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("reservationBooking.waitlist.pax")}
              required
              hint={t("reservationBooking.slot.paxHint", { max: MAX_PAX })}
            >
              <Input
                name="waitlistPax"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_PAX}
                value={pax === 0 ? "" : String(pax)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPax(Number.isFinite(next) ? next : 0);
                }}
              />
            </FormField>
            {zoneChoices.length > 0 && (
              <div data-slot="form-field" className="grid gap-1.5">
                <Label htmlFor="waitlist-zone">
                  {t("reservationBooking.waitlist.zone")}
                </Label>
                <Select value={zoneId} onValueChange={setZoneId}>
                  <SelectTrigger id="waitlist-zone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_ZONE}>
                      {t("reservationBooking.slot.zoneAll")}
                    </SelectItem>
                    {zoneChoices.map((zone) => (
                      <SelectItem key={zone.id} value={zone.id}>
                        {zone.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {submitFailed && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-field bg-danger-subtle px-3 py-2"
            >
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-danger"
                aria-hidden="true"
              />
              <div className="grid gap-0.5">
                <p className="text-sm leading-5 font-semibold">
                  {t("reservationBooking.waitlist.errorTitle")}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("reservationBooking.waitlist.errorHint")}
                </p>
              </div>
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            loading={join.isPending}
            disabled={!paxValid}
          >
            {join.isPending
              ? t("reservationBooking.waitlist.pending")
              : t("reservationBooking.waitlist.submit")}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
