// Step 1 and 2 of the guest booking flow (PRD v1.7 §3.22 "Reservasi Online":
// date, time, pax, zone and note; §4 Alur H steps 1–2): the availability search
// (RSV-01 read model) and the guest details with the optional event pre-order.
// Submitting books the slot (RSV-02) with one Idempotency-Key per attempt.
import * as React from "react";
import { CalendarX, TriangleAlert, WifiOff } from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { normalizeWhatsAppNumber } from "@starter/shared/identity";
import { floorZoneIdSchema } from "@starter/shared/qr-order";
import type { ReservationAvailabilitySlot } from "@starter/shared/reservation";
import type { PublicSite } from "@starter/shared/website";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useOnline } from "@/lib/use-online";
import { useT } from "@/components/i18n";
import { businessDateInZone } from "@/features/ws08-website/lib/hours.ts";
import {
  useAvailability,
  useCreateBooking,
  useReservationPackages,
} from "../hooks";
import type { ReservationCreated } from "@starter/shared/reservation";
import {
  DEFAULT_DURATION,
  DURATION_OPTIONS,
  MAX_NOTE,
  MAX_PAX,
  eligiblePackages,
  formatClock,
  formatDayLabel,
  isBusinessDate,
  packageTotal,
  shiftBusinessDate,
  validateGuestDetails,
} from "../lib";
import { zoneOptions } from "../zones";

/** A Radix Select item always needs a value, so "none" is a sentinel. */
const ANY_ZONE = "any";
const NO_PACKAGE = "none";

type GuestErrors = Partial<Record<"name" | "phone" | "note" | "slot", true>>;

export function BookingPanel({
  site,
  onCreated,
  onJoinWaitlist,
}: {
  site: PublicSite;
  onCreated: (created: ReservationCreated) => void;
  /** The empty availability state offers the walk-in waitlist instead. */
  onJoinWaitlist: () => void;
}) {
  const t = useT();
  const online = useOnline();
  const timeZone = site.outlet.timeZone;
  const zoneChoices = zoneOptions();

  // The page is server rendered: the business date and the clock are filled in
  // after mount, so the server and the browser render the same markup.
  const [today, setToday] = React.useState<string | null>(null);
  const [date, setDate] = React.useState("");
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    const businessDate = businessDateInZone(new Date(), timeZone);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock and the outlet-local business date are browser-only, so filling them after mount is what keeps SSR and hydration identical.
    setToday(businessDate);
    setDate((current) => current || shiftBusinessDate(businessDate, 1));
    setNowMs(Date.now());
  }, [timeZone]);

  const [pax, setPax] = React.useState(2);
  const [zoneId, setZoneId] = React.useState<string>(ANY_ZONE);
  const [duration, setDuration] = React.useState<number>(DEFAULT_DURATION);
  const [startsAt, setStartsAt] = React.useState<string | null>(null);

  const paxValid = Number.isInteger(pax) && pax >= 1 && pax <= MAX_PAX;
  /** Availability only runs once the form holds a date and a valid party. */
  const dateReady = isBusinessDate(date) && paxValid;
  // The zone picker's value is a plain string; the availability query needs the
  // contract's branded id, so it is validated at this boundary (a stale option
  // from a reloaded fixture is dropped rather than sent).
  const parsedZone =
    zoneId === ANY_ZONE ? null : floorZoneIdSchema.safeParse(zoneId).data ?? null;
  const availability = useAvailability(site.outlet.id, {
    date,
    pax: paxValid ? pax : 1,
    ...(parsedZone === null ? {} : { zoneId: parsedZone }),
    durationMinutes: duration,
  });
  const slots = React.useMemo(
    () =>
      [...(availability.data?.slots ?? [])].sort(
        (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
      ),
    [availability.data],
  );
  const selectedSlot = startsAt
    ? slots.find((slot) => slot.startsAt === startsAt)
    : undefined;

  // A new date, party, zone or length invalidates the chosen slot.
  const changeFilters = (apply: () => void) => {
    apply();
    setStartsAt(null);
  };

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [note, setNote] = React.useState("");
  const [packageId, setPackageId] = React.useState<string>(NO_PACKAGE);
  const [errors, setErrors] = React.useState<GuestErrors>({});
  const [submitFailed, setSubmitFailed] = React.useState(false);

  const packages = useReservationPackages(site.outlet.id);
  const eligible = React.useMemo(() => {
    if (!selectedSlot) return [];
    return eligiblePackages(
      packages.data ?? [],
      pax,
      selectedSlot.startsAt,
      nowMs,
    );
  }, [packages.data, pax, selectedSlot, nowMs]);
  const selectedPackage = eligible.find((pack) => pack.id === packageId);
  // A package that no longer fits the party or the lead time drops out of the
  // list; the field falls back to "no package" without a state reset.
  const effectivePackageId = selectedPackage ? selectedPackage.id : NO_PACKAGE;

  const create = useCreateBooking(site.outlet.id);
  /**
   * One Idempotency-Key per attempt (contracts.md "Typed web client &
   * idempotency headers"): a retry of the same form reuses it, an edited form
   * mints a new one. Written only in the submit handler, never during render.
   */
  const attempt = React.useRef<{ fingerprint: string; key: string } | null>(
    null,
  );

  const clearError = (field: keyof GuestErrors) => {
    setErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const phoneIsValid = normalizeWhatsAppNumber(phone) !== null;
    const check = validateGuestDetails({ name, phone, note }, { phoneIsValid });
    const slotMissing = selectedSlot === undefined;
    if (!check.ok || slotMissing) {
      setErrors({
        ...(check.ok ? {} : check.errors),
        ...(slotMissing ? { slot: true } : {}),
      });
      setSubmitFailed(false);
      return;
    }
    if (!selectedSlot) return;
    setErrors({});
    setSubmitFailed(false);
    const body = {
      reservedFor: selectedSlot.startsAt,
      durationMinutes: duration,
      pax,
      zoneId: parsedZone,
      guestName: name.trim(),
      contactPhone: phone.trim(),
      note: note.trim() === "" ? null : note.trim(),
      preOrderPackageId:
        effectivePackageId === NO_PACKAGE ? null : effectivePackageId,
    };
    const fingerprint = JSON.stringify(body);
    const key =
      attempt.current?.fingerprint === fingerprint
        ? attempt.current.key
        : newIdempotencyKey();
    attempt.current = { fingerprint, key };
    create.mutate(
      { body, idempotencyKey: key },
      {
        onSuccess: (created) => onCreated(created),
        onError: () => setSubmitFailed(true),
      },
    );
  };

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      onSubmit={submit}
      noValidate
    >
      <Card>
        <CardContent className="grid gap-5">
          <div className="grid gap-1">
            <CardTitle>{t("reservationBooking.step.slot")}</CardTitle>
            <CardDescription>
              {t("reservationBooking.slot.hint", {
                pax: paxValid ? pax : 1,
              })}
            </CardDescription>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("reservationBooking.slot.date")} required>
              <Input
                name="date"
                type="date"
                min={today ?? undefined}
                value={date}
                onChange={(event) =>
                  changeFilters(() => setDate(event.target.value))
                }
              />
            </FormField>
            <FormField
              label={t("reservationBooking.slot.pax")}
              required
              hint={t("reservationBooking.slot.paxHint", { max: MAX_PAX })}
            >
              <Input
                name="pax"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_PAX}
                value={pax === 0 ? "" : String(pax)}
                onChange={(event) =>
                  changeFilters(() => {
                    const next = Number(event.target.value);
                    setPax(Number.isFinite(next) ? next : 0);
                  })
                }
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {zoneChoices.length > 0 && (
              <SelectField
                label={t("reservationBooking.slot.zone")}
                value={zoneId}
                onValueChange={(value) => changeFilters(() => setZoneId(value))}
                options={[
                  {
                    value: ANY_ZONE,
                    label: t("reservationBooking.slot.zoneAll"),
                  },
                  ...zoneChoices.map((zone) => ({
                    value: zone.id,
                    label: zone.name,
                  })),
                ]}
              />
            )}
            <SelectField
              label={t("reservationBooking.slot.duration")}
              value={String(duration)}
              onValueChange={(value) =>
                changeFilters(() => setDuration(Number(value)))
              }
              options={DURATION_OPTIONS.map((minutes) => ({
                value: String(minutes),
                label: t("reservationBooking.slot.durationValue", { minutes }),
              }))}
            />
          </div>

          <section aria-labelledby="slot-heading" className="grid gap-2">
            <h4
              id="slot-heading"
              className="type-eyebrow text-muted-foreground"
            >
              {t("reservationBooking.slot.title")}
            </h4>
            {!online ? (
              <EmptyState
                icon={WifiOff}
                title={t("website.state.offlineTitle")}
                description={t("website.state.offlineHint")}
              />
            ) : !dateReady ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.slot.pickPrompt")}
              </p>
            ) : availability.isPending ? (
              <div aria-busy="true" className="grid gap-2">
                <span role="status" className="sr-only">
                  {t("reservationBooking.slot.loading")}
                </span>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} className="h-14 rounded-control" />
                  ))}
                </div>
              </div>
            ) : availability.isError ? (
              <ErrorState
                title={t("reservationBooking.slot.errorTitle")}
                description={t("reservationBooking.slot.errorHint")}
                onRetry={() => void availability.refetch()}
              />
            ) : slots.length === 0 ? (
              <EmptyState
                icon={CalendarX}
                title={t("reservationBooking.slot.emptyTitle")}
                description={t("reservationBooking.slot.emptyHint")}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onJoinWaitlist}
                  >
                    {t("reservationBooking.slot.emptyAction")}
                  </Button>
                }
              />
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((slot) => (
                  <SlotButton
                    key={slot.startsAt}
                    slot={slot}
                    timeZone={timeZone}
                    selected={slot.startsAt === startsAt}
                    onSelect={() => {
                      setStartsAt(slot.startsAt);
                      clearError("slot");
                    }}
                  />
                ))}
              </ul>
            )}
            {errors.slot && (
              <p
                role="alert"
                className="text-sm leading-5 font-medium text-danger"
              >
                {t("reservationBooking.guest.errorSlot")}
              </p>
            )}
          </section>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-5">
          <div className="grid gap-1">
            <CardTitle>{t("reservationBooking.guest.title")}</CardTitle>
            <CardDescription>
              {t("reservationBooking.guest.hint")}
            </CardDescription>
          </div>

          <FormField
            label={t("reservationBooking.guest.name")}
            required
            error={
              errors.name ? t("reservationBooking.guest.errorName") : undefined
            }
          >
            <Input
              name="guestName"
              value={name}
              autoComplete="name"
              placeholder={t("reservationBooking.guest.namePlaceholder")}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => {
                setName(event.target.value);
                clearError("name");
              }}
            />
          </FormField>

          <FormField
            label={t("reservationBooking.guest.phone")}
            required
            hint={t("reservationBooking.guest.phoneHint")}
            error={
              errors.phone
                ? t("reservationBooking.guest.errorPhone")
                : undefined
            }
          >
            <Input
              name="contactPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              placeholder={t("reservationBooking.guest.phonePlaceholder")}
              aria-invalid={errors.phone ? true : undefined}
              onChange={(event) => {
                setPhone(event.target.value);
                clearError("phone");
              }}
            />
          </FormField>

          <FormField
            label={t("reservationBooking.guest.note")}
            hint={t("reservationBooking.guest.noteHint", { max: MAX_NOTE })}
            error={
              errors.note
                ? t("reservationBooking.guest.errorNote", {
                    max: MAX_NOTE,
                  })
                : undefined
            }
          >
            <Textarea
              name="note"
              value={note}
              maxLength={MAX_NOTE}
              placeholder={t("reservationBooking.guest.notePlaceholder")}
              onChange={(event) => {
                setNote(event.target.value);
                clearError("note");
              }}
            />
          </FormField>

          {selectedSlot &&
            (packages.isPending ? (
              <div className="grid gap-1.5">
                <span className="text-sm leading-5 font-medium">
                  {t("reservationBooking.package.label")}
                </span>
                <Skeleton className="h-control rounded-field" />
              </div>
            ) : packages.isError ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("reservationBooking.package.error")}
              </p>
            ) : eligible.length === 0 ? (
              <div className="grid gap-1.5">
                <span className="text-sm leading-5 font-medium">
                  {t("reservationBooking.package.label")}
                </span>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("reservationBooking.package.empty", { pax })}
                </p>
              </div>
            ) : (
              <SelectField
                label={t("reservationBooking.package.label")}
                hint={
                  selectedPackage
                    ? t("reservationBooking.package.hint", {
                        price: formatRupiah(selectedPackage.pricePerPaxIdr),
                        hours: selectedPackage.leadTimeHours,
                      })
                    : undefined
                }
                value={effectivePackageId}
                onValueChange={(value) => setPackageId(value)}
                options={[
                  {
                    value: NO_PACKAGE,
                    label: t("reservationBooking.package.none"),
                  },
                  ...eligible.map((pack) => ({
                    value: pack.id,
                    label: t("reservationBooking.package.option", {
                      name: pack.name,
                      price: formatRupiah(pack.pricePerPaxIdr),
                    }),
                  })),
                ]}
              />
            ))}

          {selectedPackage && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("reservationBooking.package.estimate", {
                total: formatRupiah(packageTotal(selectedPackage, pax)),
                pax,
              })}
            </p>
          )}

          <div className="grid gap-3 border-t-(length:--border-w) pt-4">
            {selectedSlot && (
              <div className="grid gap-0.5">
                <p className="type-eyebrow text-muted-foreground">
                  {t("reservationBooking.submit.summary")}
                </p>
                <p className="text-sm leading-5">
                  {[
                    t("reservationBooking.submit.when", {
                      date: formatDayLabel(date),
                      time: formatClock(selectedSlot.startsAt, timeZone),
                    }),
                    t("reservationBooking.submit.pax", { pax }),
                  ].join(" · ")}
                </p>
              </div>
            )}
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
                    {t("reservationBooking.submit.errorTitle")}
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("reservationBooking.submit.errorHint")}
                  </p>
                </div>
              </div>
            )}
            <Button type="submit" size="lg" loading={create.isPending}>
              {create.isPending
                ? t("reservationBooking.submit.pending")
                : t("reservationBooking.submit.action")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

function SlotButton({
  slot,
  timeZone,
  selected,
  onSelect,
}: {
  slot: ReservationAvailabilitySlot;
  timeZone: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "grid w-full gap-0.5 rounded-control border-(length:--border-w) px-3 py-2 text-left transition-colors duration-(--duration-fast) pressable",
          selected
            ? "border-primary bg-primary-tint"
            : "border-border bg-background hover:bg-surface-2",
        )}
      >
        <span className="text-base leading-6 font-semibold tabular">
          {formatClock(slot.startsAt, timeZone)}
        </span>
        <span className="text-xs leading-4 text-muted-foreground">
          {t("reservationBooking.slot.seats", {
            seats: slot.seatsAvailable,
          })}
        </span>
      </button>
    </li>
  );
}

type SelectOption = { value: string; label: string };

/**
 * Label + Select + hint, wired like FormField. FormField clones its single
 * child onto the control, but a Radix Select root is not a DOM element, so the
 * trigger carries the id and the description itself.
 */
function SelectField({
  label,
  hint,
  value,
  onValueChange,
  options,
}: {
  label: string;
  hint?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  return (
    <div data-slot="form-field" className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} aria-describedby={hint ? hintId : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && (
        <p id={hintId} className="text-sm leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
