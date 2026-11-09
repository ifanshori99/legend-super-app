// Pickup display (PRD §3 F12): the call numbers for takeaway and delivery, the
// numbers waiting to be called, the promotion slide, and the sound that reads a
// new number out loud. The same screen serves the wall display at 1440px and a
// staff phone at 390px.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Clock, Megaphone, Volume2, VolumeX } from "lucide-react";
import type { PickupCall } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand } from "@/components/ui/status-band";
import { useToast } from "@/components/ui/toast";
import { formatOutletTime } from "../format.ts";
import { useCallPickup, usePickupDisplay } from "../hooks.ts";
import {
  announcePickupNumber,
  getPickupSoundServerSnapshot,
  getPickupSoundSnapshot,
  getPickupSpeechServerSnapshot,
  getPickupSpeechSnapshot,
  newlyCalledCalls,
  setPickupSoundEnabled,
  subscribeNever,
  subscribePickupSound,
} from "../sound.ts";
import { ChannelBadge } from "./channel-badge.tsx";
import { PickupPromoCard } from "./pickup-promo.tsx";
import { KitchenScreenHeader } from "./screen-header.tsx";

/** How many already-picked-up numbers stay on the board. */
const PICKED_UP_SHOWN = 6;

export function PickupScreen() {
  const t = useT();
  const toast = useToast();
  const display = usePickupDisplay();
  const call = useCallPickup();
  const soundOn = useSyncExternalStore(
    subscribePickupSound,
    getPickupSoundSnapshot,
    getPickupSoundServerSnapshot,
  );
  const speechAvailable = useSyncExternalStore(
    subscribeNever,
    getPickupSpeechSnapshot,
    getPickupSpeechServerSnapshot,
  );
  /** Last snapshot, so only numbers that were just called are announced. */
  const snapshot = useRef<PickupCall[] | null>(null);
  /** Numbers already spoken, so a refetch does not repeat an announcement. */
  const announced = useRef<Set<string>>(new Set());

  const calls = display.data?.calls ?? [];

  useEffect(() => {
    if (!display.data) return;
    const fresh = newlyCalledCalls(snapshot.current, display.data.calls);
    snapshot.current = display.data.calls;
    if (fresh.length === 0) return;
    if (!soundOn) return;
    for (const freshCall of fresh) {
      if (announced.current.has(freshCall.id)) continue;
      announced.current.add(freshCall.id);
      announcePickupNumber(t("pickup.announce", { number: freshCall.code }));
    }
  }, [display.data, soundOn, t]);

  const called = calls
    .filter((row) => row.status === "called")
    .sort((left, right) => left.number - right.number);
  const waiting = calls
    .filter((row) => row.status === "assigned")
    .sort((left, right) => left.number - right.number);
  const pickedUp = calls
    .filter((row) => row.status === "picked_up" && row.pickedUpAt !== null)
    .sort((left, right) => (left.pickedUpAt! < right.pickedUpAt! ? 1 : -1))
    .slice(0, PICKED_UP_SHOWN);
  const promotions = display.data?.promotions ?? [];

  function handleCall(row: PickupCall) {
    call.mutate(row.id, {
      onSuccess: (updated) => {
        // This press announced it; the snapshot effect must not repeat it.
        announced.current.add(updated.id);
        if (soundOn)
          announcePickupNumber(t("pickup.announce", { number: updated.code }));
      },
      onError: () =>
        toast({
          title: t("pickup.callError"),
          description: t("pickup.callErrorHint"),
          tone: "danger",
        }),
    });
  }

  function toggleSound() {
    const next = !soundOn;
    setPickupSoundEnabled(next);
    if (next) announcePickupNumber(t("pickup.soundOn"));
  }

  const header = (
    <KitchenScreenHeader
      title={t("pickup.title")}
      intro={t("pickup.intro")}
      current="pickup"
      updatedAt={display.data?.generatedAt ?? null}
      refreshPending={display.isFetching}
      onRefresh={() => void display.refetch()}
      actions={
        <div className="flex flex-col items-start gap-1">
          <Button
            variant={soundOn ? "secondary" : "outline"}
            size="sm"
            aria-pressed={soundOn}
            onClick={toggleSound}
          >
            {soundOn ? (
              <Volume2 aria-hidden="true" />
            ) : (
              <VolumeX aria-hidden="true" />
            )}
            {soundOn ? t("pickup.soundOn") : t("pickup.soundOff")}
          </Button>
          {!speechAvailable && (
            <p className="max-w-56 text-xs leading-5 text-muted-foreground">
              {t("pickup.soundUnavailable")}
            </p>
          )}
        </div>
      }
    />
  );

  if (display.isPending) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t("pickup.loading")}</span>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3].map((tile) => (
              <Skeleton key={tile} className="h-40 w-full rounded-container" />
            ))}
          </div>
          <Skeleton className="h-20 w-full rounded-container" />
        </div>
      </div>
    );
  }

  if (display.isError && !display.data) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <ErrorState
          title={t("pickup.errorTitle")}
          description={t("pickup.errorHint")}
          onRetry={() => void display.refetch()}
        />
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5">
        {header}
        <EmptyState
          title={t("pickup.emptyTitle")}
          description={t("pickup.emptyHint")}
        />
        {promotions.length > 0 && <PickupPromoCard promotion={promotions[0]} />}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-5">
      {header}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {called.length > 0
          ? t("pickup.announced", { number: called[called.length - 1].code })
          : ""}
      </p>

      {called.length > 0 && (
        <section
          aria-labelledby="pickup-called"
          className="flex flex-col gap-3"
        >
          <div className="min-w-0">
            <h2 id="pickup-called" className="type-title tabular">
              {t("pickup.calledTitle")} · {called.length}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("pickup.calledHint")}
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {called.map((row) => (
              <li key={row.id} className="min-w-0">
                <article
                  data-slot="pickup-call"
                  data-call-status={row.status}
                  className="flex h-full min-w-0 flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card"
                >
                  <StatusBand
                    tone="info"
                    icon={Megaphone}
                    label={t("pickup.status.called")}
                    aside={<ChannelBadge channel={row.channel} />}
                  >
                    <p className="text-5xl leading-none font-bold text-foreground tabular sm:text-6xl">
                      {row.code}
                    </p>
                  </StatusBand>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    {row.calledAt !== null && (
                      <time
                        dateTime={row.calledAt}
                        className="text-sm leading-5 text-muted-foreground tabular"
                      >
                        {t("pickup.calledAt", {
                          time: formatOutletTime(row.calledAt),
                        })}
                      </time>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-auto w-full"
                      aria-label={t("pickup.callAgainFor", {
                        number: row.code,
                      })}
                      onClick={() => handleCall(row)}
                      disabled={call.isPending}
                    >
                      {t("pickup.callAgain")}
                    </Button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      )}

      {promotions.length > 0 && <PickupPromoCard promotion={promotions[0]} />}

      {waiting.length > 0 && (
        <section
          aria-labelledby="pickup-waiting"
          className="flex flex-col gap-3"
        >
          <div className="min-w-0">
            <h2 id="pickup-waiting" className="type-title tabular">
              {t("pickup.waitingTitle")} · {waiting.length}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("pickup.waitingHint")}
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {waiting.map((row) => (
              <li key={row.id} className="min-w-0">
                <article
                  data-slot="pickup-call"
                  data-call-status={row.status}
                  className="flex h-full min-w-0 flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card"
                >
                  <StatusBand
                    tone="neutral"
                    icon={Clock}
                    label={t("pickup.status.waiting")}
                    aside={<ChannelBadge channel={row.channel} />}
                  >
                    <p className="text-4xl leading-none font-bold tabular">
                      {row.code}
                    </p>
                  </StatusBand>
                  <div className="flex flex-1 flex-col p-4">
                    {/* Neutral fill: several numbers wait at once, so calling
                        one is not the screen's single accent action
                        (DESIGN.md §2, owner Q21). */}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-auto w-full"
                      aria-label={t("pickup.callFor", { number: row.code })}
                      loading={call.isPending && call.variables === row.id}
                      onClick={() => handleCall(row)}
                    >
                      {t("pickup.call")}
                    </Button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pickedUp.length > 0 && (
        <section
          aria-labelledby="pickup-picked-up"
          className="flex flex-col gap-3"
        >
          <h2 id="pickup-picked-up" className="type-title tabular">
            {t("pickup.pickedUpTitle")}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {pickedUp.map((row) => (
              <li
                key={row.id}
                className="inline-flex items-center gap-2 rounded-full border-(length:--border-w) bg-muted px-3 py-1"
              >
                <span className="text-sm font-semibold tabular">
                  {row.code}
                </span>
                <span className="text-xs text-muted-foreground tabular">
                  {row.pickedUpAt !== null
                    ? t("pickup.pickedUpAt", {
                        time: formatOutletTime(row.pickedUpAt),
                      })
                    : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
