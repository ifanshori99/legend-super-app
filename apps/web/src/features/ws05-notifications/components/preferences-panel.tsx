import { cn } from "cn";
import { useMemo, useState, type FormEvent } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import type { MessageKey } from "@starter/shared/i18n";
import {
  effectiveChannelPreference,
  isEmailMandatory,
  type ChannelPreference,
  type NotificationCategory,
  type NotificationPreference,
} from "@starter/shared/notification";
import type { NotificationPreferenceInput } from "../api";
import { categoryLabelKey, STAFF_NOTIFICATION_CATEGORIES } from "../format";
import {
  useNotificationPolicy,
  useNotificationPreferences,
  useSaveNotificationPreferences,
} from "../hooks";
import { PushPanel } from "./push-panel";

const CHANNELS = [
  {
    key: "web_push",
    labelKey: "notification.preferences.channelWebPush",
  },
  { key: "email", labelKey: "notification.preferences.channelEmail" },
  { key: "whatsapp", labelKey: "notification.preferences.channelWhatsapp" },
] as const satisfies readonly {
  key: keyof ChannelPreference;
  labelKey: MessageKey;
}[];

// Only the zones of one country; the preference stores the user's own zone
// and the API validates any IANA name.
const COMMON_TIME_ZONES = [
  "Asia/Jakarta",
  "Asia/Pontianak",
  "Asia/Makassar",
  "Asia/Jayapura",
];

const DEFAULT_QUIET_START = "22:00";
const DEFAULT_QUIET_END = "07:00";

type ChannelMap = Record<string, ChannelPreference>;

function initialChannels(preference: NotificationPreference): ChannelMap {
  const channels: ChannelMap = {};
  for (const category of STAFF_NOTIFICATION_CATEGORIES) {
    const own = effectiveChannelPreference(preference, category);
    // Mandatory email is always on, even if the stored value says false.
    channels[category] = isEmailMandatory(category as NotificationCategory)
      ? { ...own, email: true }
      : own;
  }
  return channels;
}

function buildBody(
  channels: ChannelMap,
  quietHours: NotificationPreference["quietHours"],
  timeZone: string,
): NotificationPreferenceInput {
  const categories: NotificationPreferenceInput["categories"] = {};
  for (const category of STAFF_NOTIFICATION_CATEGORIES) {
    const channel = channels[category];
    categories[category as NotificationCategory] = isEmailMandatory(
      category as NotificationCategory,
    )
      ? { ...channel, email: true }
      : channel;
  }
  return { categories, quietHours, timeZone };
}

/** Preferences tab: per-category channels, quiet hours, this device's push. */
export function PreferencesPanel() {
  const t = useT();
  const preference = useNotificationPreferences();
  const policy = useNotificationPolicy();

  if (preference.isPending) return <PreferencesSkeleton />;
  if (preference.isError)
    return (
      <Card>
        <ErrorState
          title={t("notification.preferences.errorTitle")}
          description={t("notification.preferences.errorHint")}
          onRetry={() => void preference.refetch()}
        />
      </Card>
    );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <PreferencesForm
        preference={preference.data.data}
        whatsappCategories={
          policy.data
            ? policy.data.data.whatsapp.enabled
              ? policy.data.data.whatsapp.allowedCategories
              : []
            : null
        }
      />
      <PushPanel />
    </div>
  );
}

function PreferencesForm({
  preference,
  whatsappCategories,
}: {
  preference: NotificationPreference;
  /**
   * Categories the tenant policy lets WhatsApp carry (PRD §3.15: WhatsApp is
   * a paid channel, off unless allowed per category); [] = WhatsApp off,
   * null = the policy is unknown (not the user's to read, or offline).
   */
  whatsappCategories: readonly NotificationCategory[] | null;
}) {
  const whatsappAllowed =
    whatsappCategories === null ? null : whatsappCategories.length > 0;
  const t = useT();
  const toast = useToast();
  const save = useSaveNotificationPreferences();
  const [channels, setChannels] = useState<ChannelMap>(() =>
    initialChannels(preference),
  );
  const [quietEnabled, setQuietEnabled] = useState(
    preference.quietHours !== null,
  );
  const [quietStart, setQuietStart] = useState(
    preference.quietHours?.start ?? DEFAULT_QUIET_START,
  );
  const [quietEnd, setQuietEnd] = useState(
    preference.quietHours?.end ?? DEFAULT_QUIET_END,
  );
  const [timeZone, setTimeZone] = useState(preference.timeZone);
  const [timeError, setTimeError] = useState<string | null>(null);

  const zoneOptions = useMemo(
    () =>
      COMMON_TIME_ZONES.includes(preference.timeZone)
        ? COMMON_TIME_ZONES
        : [...COMMON_TIME_ZONES, preference.timeZone],
    [preference.timeZone],
  );
  const initialBody = useMemo(
    () =>
      buildBody(
        initialChannels(preference),
        preference.quietHours,
        preference.timeZone,
      ),
    [preference],
  );
  const body = buildBody(
    channels,
    quietEnabled ? { start: quietStart, end: quietEnd } : null,
    timeZone,
  );
  const dirty = JSON.stringify(body) !== JSON.stringify(initialBody);
  const untouched =
    Object.keys(preference.categories).length === 0 &&
    preference.quietHours === null;

  const setChannel = (
    category: NotificationCategory,
    channel: keyof ChannelPreference,
    value: boolean,
  ) => {
    if (channel === "email" && !value && isEmailMandatory(category)) return;
    setChannels((current) => ({
      ...current,
      [category]: { ...current[category], [channel]: value },
    }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (quietEnabled && quietStart === quietEnd) {
      setTimeError(t("notification.preferences.quietHoursSameTime"));
      return;
    }
    setTimeError(null);
    save.mutate(body, {
      onSuccess: () =>
        toast({
          title: t("notification.preferences.saved"),
          tone: "success",
        }),
    });
  };

  const discard = () => {
    setChannels(initialChannels(preference));
    setQuietEnabled(preference.quietHours !== null);
    setQuietStart(preference.quietHours?.start ?? DEFAULT_QUIET_START);
    setQuietEnd(preference.quietHours?.end ?? DEFAULT_QUIET_END);
    setTimeZone(preference.timeZone);
    setTimeError(null);
  };

  return (
    <form onSubmit={submit} className="grid gap-5">
      <section aria-labelledby="notification-channel-matrix">
        <CardShell>
          <Card>
            <h3 id="notification-channel-matrix" className="type-title">
              {t("notification.preferences.categoriesHeading")}
            </h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {t("notification.preferences.hint")}
            </p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {whatsappAllowed === false
                ? t("notification.preferences.whatsappPolicyOff")
                : t("notification.preferences.whatsappPolicyUnknown")}
            </p>
            {untouched && (
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {t("notification.preferences.untouchedHint")}
              </p>
            )}

            <div className="mt-4">
              <div
                aria-hidden="true"
                className="hidden gap-3 border-b pb-2 text-xs leading-4 font-semibold text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_repeat(3,6rem)]"
              >
                <span />
                {CHANNELS.map(({ key, labelKey }) => (
                  <span key={key} className="text-center">
                    {t(labelKey)}
                  </span>
                ))}
              </div>
              <ul className="grid">
                {STAFF_NOTIFICATION_CATEGORIES.map((category) => (
                  <li
                    key={category}
                    className="grid gap-2 border-b py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_repeat(3,6rem)] sm:items-center sm:gap-3"
                  >
                    <span className="text-sm leading-5 font-medium">
                      {t(categoryLabelKey(category))}
                    </span>
                    <div className="grid grid-cols-3 gap-2 sm:contents">
                      {CHANNELS.map(({ key, labelKey }) => {
                        const id = `notification-${category}-${key}`;
                        const emailLocked =
                          key === "email" &&
                          isEmailMandatory(category as NotificationCategory);
                        const noteId = `${id}-note`;
                        const disabled =
                          emailLocked ||
                          (key === "whatsapp" &&
                            whatsappCategories !== null &&
                            !whatsappCategories.includes(category));
                        return (
                          <div
                            key={key}
                            className={cn(
                              "flex min-h-11 flex-col items-start gap-1 rounded-md px-1 py-1 sm:min-h-0 sm:flex-row sm:items-center sm:justify-center sm:gap-2 sm:p-0",
                              emailLocked && "sm:flex-col sm:gap-1",
                            )}
                          >
                            <Label
                              htmlFor={id}
                              className="font-normal text-muted-foreground sm:sr-only"
                            >
                              {t(labelKey)}
                              <span className="sr-only">
                                {" "}
                                {t(categoryLabelKey(category))}
                              </span>
                            </Label>
                            <Switch
                              id={id}
                              checked={channels[category][key]}
                              disabled={disabled}
                              aria-describedby={
                                emailLocked ? noteId : undefined
                              }
                              onCheckedChange={(checked) =>
                                setChannel(category, key, checked)
                              }
                            />
                            {emailLocked && (
                              <span
                                id={noteId}
                                className="text-xs leading-4 text-muted-foreground"
                              >
                                {t("notification.preferences.emailMandatory")}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </CardShell>
      </section>

      <section aria-labelledby="notification-quiet-hours">
        <CardShell>
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 id="notification-quiet-hours" className="type-title">
                  {t("notification.preferences.quietHoursHeading")}
                </h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {t("notification.preferences.quietHoursHint")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="notification-quiet-hours-enabled"
                  checked={quietEnabled}
                  onCheckedChange={(checked) => {
                    setQuietEnabled(checked);
                    setTimeError(null);
                  }}
                />
                <Label
                  htmlFor="notification-quiet-hours-enabled"
                  className="font-normal"
                >
                  {t("notification.preferences.quietHoursEnable")}
                </Label>
              </div>
            </div>

            {quietEnabled && (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <FormField
                  label={t("notification.preferences.quietHoursStart")}
                  required
                >
                  <Input
                    type="time"
                    value={quietStart}
                    onChange={(event) => {
                      setQuietStart(event.target.value);
                      setTimeError(null);
                    }}
                  />
                </FormField>
                <FormField
                  label={t("notification.preferences.quietHoursEnd")}
                  required
                  error={timeError ?? undefined}
                >
                  <Input
                    type="time"
                    value={quietEnd}
                    onChange={(event) => {
                      setQuietEnd(event.target.value);
                      setTimeError(null);
                    }}
                  />
                </FormField>
                <FormField
                  label={t("notification.preferences.timeZone")}
                  required
                >
                  <Select value={timeZone} onValueChange={setTimeZone}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {zoneOptions.map((zone) => (
                        <SelectItem key={zone} value={zone}>
                          {zone}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
            )}
          </Card>
        </CardShell>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending} disabled={!dirty}>
          {t("notification.preferences.save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={discard}
          disabled={!dirty || save.isPending}
        >
          {t("notification.preferences.discard")}
        </Button>
        {save.isError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {save.error instanceof ApiError && save.error.status === 422
              ? save.error.message
              : t("notification.preferences.saveError")}
          </p>
        )}
      </div>
    </form>
  );
}

function PreferencesSkeleton() {
  const t = useT();
  return (
    <div
      className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start"
      aria-busy="true"
    >
      <span className="sr-only">{t("common.loading")}</span>
      <Card className="gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </Card>
      <Card className="gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-40" />
      </Card>
    </div>
  );
}
