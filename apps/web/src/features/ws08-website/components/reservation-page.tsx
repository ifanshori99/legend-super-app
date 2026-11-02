// Reservation & member entry (PRD v1.7 §3.24 "Reservasi & Member"): the public
// site's reservation request form and the member sign-in/sign-up doors.
//
// The booking flow with table availability and the DP handoff belongs to
// legend-xm4y (/reservasi). This page collects a request and hands it to the
// venue's WhatsApp with every field prefilled, so it invents no policy and
// works before the reservation API exists.
import { useState, type FormEvent, type MouseEvent } from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { MessageKey } from "@starter/shared/i18n";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import type { PublicSite } from "@starter/shared/website";
import {
  businessDateInZone,
  formatBusinessDate,
  formatHoursRange,
} from "../lib/hours.ts";
import {
  buildWhatsAppUrl,
  validateReservationRequest,
  type ReservationFormValues,
} from "../lib/reservation.ts";
import {
  AddressBlock,
  MemberEntryCard,
  OpeningHoursList,
  SiteSection,
  WhatsAppLink,
} from "./blocks.tsx";
import { SiteFrame } from "./site-frame.tsx";

type ReservationField = keyof ReservationFormValues;

const ERROR_KEY: Record<ReservationField, MessageKey> = {
  name: "website.reservation.errorName",
  date: "website.reservation.errorDate",
  time: "website.reservation.errorTime",
  pax: "website.reservation.errorPax",
  notes: "website.reservation.errorNotes",
};

const EMPTY: ReservationFormValues = {
  name: "",
  date: "",
  time: "",
  pax: "2",
  notes: "",
};

export function ReservationPage({
  site,
  signedIn,
}: {
  site: PublicSite;
  signedIn: boolean;
}) {
  const t = useT();
  const [values, setValues] = useState<ReservationFormValues>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<ReservationField, true>>>(
    {},
  );

  const set = (field: ReservationField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field])
      setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const dateLabel =
    formatBusinessDate(values.date.trim()) || values.date.trim() || "-";
  const details = t("website.reservation.whatsappDetails", {
    name: values.name.trim() || "-",
    date: dateLabel,
    time: values.time.trim() || "-",
    pax: values.pax.trim() || "-",
  });
  const notes = values.notes.trim();
  const message = [
    t("website.reservation.whatsappIntro", { brand: site.brand.name }),
    details,
    notes ? t("website.reservation.whatsappNotes", { notes }) : "",
  ]
    .filter(Boolean)
    .join("\n");
  const whatsappUrl = buildWhatsAppUrl(site.contact.whatsapp, message);

  const handleSubmit = (event: MouseEvent<HTMLAnchorElement>) => {
    const today = businessDateInZone(new Date(), site.outlet.timeZone);
    const result = validateReservationRequest(values, today);
    if (!result.ok) {
      event.preventDefault();
      setErrors(result.errors);
      return;
    }
    setErrors({});
  };

  // The form posts nowhere: the anchor opens WhatsApp with the message.
  const stopSubmit = (event: FormEvent<HTMLFormElement>) =>
    event.preventDefault();

  return (
    <SiteFrame site={site} signedIn={signedIn}>
      <SiteSection innerClassName="pb-4 sm:pb-2">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display-xl">
              {t("website.reservation.title")}
            </h1>
            {API_MOCK && <Badge>{t("common.sampleData")}</Badge>}
          </div>
          <p className="max-w-2xl text-lg leading-7 text-muted-foreground">
            {t("website.reservation.lead")}
          </p>
        </div>
      </SiteSection>

      {site.acceptsReservations ? (
        <SiteSection innerClassName="grid gap-6 pt-0 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardContent className="grid gap-5">
              <div className="grid gap-1">
                <CardTitle>{t("website.reservation.formTitle")}</CardTitle>
                <CardDescription>
                  {t("website.reservation.formHint")}
                </CardDescription>
              </div>
              <form className="grid gap-4" onSubmit={stopSubmit} noValidate>
                <FormField
                  label={t("website.reservation.name")}
                  required
                  error={errors.name ? t(ERROR_KEY.name) : undefined}
                >
                  <Input
                    name="name"
                    value={values.name}
                    onChange={(event) => set("name", event.target.value)}
                    placeholder={t("website.reservation.namePlaceholder")}
                    autoComplete="name"
                  />
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label={t("website.reservation.date")}
                    required
                    error={errors.date ? t(ERROR_KEY.date) : undefined}
                  >
                    <Input
                      name="date"
                      type="date"
                      value={values.date}
                      onChange={(event) => set("date", event.target.value)}
                    />
                  </FormField>
                  <FormField
                    label={t("website.reservation.time")}
                    required
                    error={errors.time ? t(ERROR_KEY.time) : undefined}
                  >
                    <Input
                      name="time"
                      type="time"
                      value={values.time}
                      onChange={(event) => set("time", event.target.value)}
                    />
                  </FormField>
                </div>
                <FormField
                  label={t("website.reservation.pax")}
                  required
                  error={errors.pax ? t(ERROR_KEY.pax) : undefined}
                >
                  <Input
                    name="pax"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={20}
                    value={values.pax}
                    onChange={(event) => set("pax", event.target.value)}
                    placeholder={t("website.reservation.paxPlaceholder")}
                  />
                </FormField>
                <FormField
                  label={t("website.reservation.notes")}
                  error={errors.notes ? t(ERROR_KEY.notes) : undefined}
                >
                  <Textarea
                    name="notes"
                    value={values.notes}
                    onChange={(event) => set("notes", event.target.value)}
                    placeholder={t("website.reservation.notesPlaceholder")}
                    maxLength={300}
                  />
                </FormField>
                <div className="grid gap-2 pt-1">
                  {whatsappUrl ? (
                    <Button asChild size="lg">
                      <a
                        href={whatsappUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={handleSubmit}
                      >
                        {t("website.reservation.submit")}
                      </a>
                    </Button>
                  ) : (
                    <Button size="lg" disabled>
                      {t("website.reservation.submit")}
                    </Button>
                  )}
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("website.reservation.submitHint")}
                  </p>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="grid content-start gap-4">
            <Card>
              <CardContent className="grid gap-4">
                <div className="grid gap-1">
                  <CardTitle>{t("website.reservation.hoursTitle")}</CardTitle>
                  <CardDescription>
                    {t("website.reservation.hoursBody", {
                      hours: formatHoursRange(site.outlet.openingHours[0]),
                    })}
                  </CardDescription>
                </div>
                <OpeningHoursList outlet={site.outlet} />
                <AddressBlock outlet={site.outlet} />
                <WhatsAppLink
                  contact={site.contact}
                  brandName={site.brand.name}
                  variant="outline"
                  label={t("website.reservation.whatsappTitle")}
                />
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("website.reservation.whatsappBody")}
                </p>
              </CardContent>
            </Card>
            <MemberEntryCard
              brandName={site.brand.name}
              signedIn={signedIn}
              className="bg-card"
            />
          </div>
        </SiteSection>
      ) : (
        <SiteSection innerClassName="pt-0">
          <EmptyState
            title={t("website.reservation.closedTitle")}
            description={t("website.reservation.closedHint")}
            action={
              <WhatsAppLink
                contact={site.contact}
                brandName={site.brand.name}
              />
            }
          />
        </SiteSection>
      )}
    </SiteFrame>
  );
}
