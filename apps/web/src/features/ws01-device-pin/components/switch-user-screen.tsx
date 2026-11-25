// Switch-user screen for the POS and kitchen shells (PRD v1.7 §3 F6 "PIN
// Perangkat"): pick a name, type the personal 6-digit PIN. The device stays
// signed in; only the working staff member changes. It also hosts a demo
// action that opens the reusable override modal.
import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { useToast } from "@/components/ui/toast";
import {
  rememberStaff,
  setActiveStaff,
  useActiveStaff,
  useRoster,
  type RosterEntry,
} from "../storage.ts";
import { usePinSession, type PosSessionStaff } from "../use-pin-session.ts";
import { LockoutNotice } from "./lockout-notice.tsx";
import {
  OverrideRequestModal,
  type OverrideResult,
} from "./override-request-modal.tsx";
import { PinPad } from "./pin-pad.tsx";

// Sample order the demo override points at (the POS beads pass their own).
const DEMO_OBJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export function SwitchUserScreen({
  shell,
  emergency = false,
  returnFacilityId,
}: {
  shell: "pos" | "kds";
  emergency?: boolean;
  /** Facility the emergency PIN came from; the return trip keeps it. */
  returnFacilityId?: string;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const active = useActiveStaff();
  const roster = useRoster();
  const [picked, setPicked] = useState<RosterEntry | "other" | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideDone, setOverrideDone] = useState<OverrideResult | null>(null);

  const pickedName = picked && picked !== "other" ? picked.displayName : null;

  const accept = useCallback(
    (result: PosSessionStaff) =>
      picked && picked !== "other" && result.user.id !== picked.userId
        ? t("devicePin.error.mismatch", { name: picked.displayName })
        : null,
    [picked, t],
  );
  const onVerified = useCallback(
    (result: PosSessionStaff) => {
      const entry = {
        userId: result.user.id,
        displayName: result.user.displayName,
      };
      rememberStaff(entry);
      if (emergency) {
        // Return only after the cookie was issued. Remounting the facility
        // receiver starts one fresh socket and restores open alerts.
        toast({
          title: t("devicePin.emergency.success", { name: entry.displayName }),
          tone: "success",
        });
        void navigate({
          to: "/fasilitas/darurat",
          search: returnFacilityId ? { facilityId: returnFacilityId } : {},
        });
        return;
      }
      setActiveStaff({ ...entry, outletId: result.outletId });
      setPicked(null);
      toast({
        title: t("devicePin.switch.success", { name: entry.displayName }),
        tone: "success",
      });
    },
    [emergency, navigate, returnFacilityId, t, toast],
  );
  // POS switch: the PIN also makes this person the device's active cashier
  // (token for X-Acting-Staff). The KDS station has no acting-staff support
  // yet, so it keeps the plain PIN check.
  const session = usePinSession({
    mode: emergency
      ? "emergency-session"
      : shell === "pos"
        ? "pos-session"
        : "verify",
    // The per-staff lockout counts misses for the tile the guest picked.
    userId: picked && picked !== "other" ? picked.userId : null,
    onVerified,
    accept,
  });

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 p-4 sm:p-6">
      <header className="grid gap-1">
        <h1 className="type-title">
          {t(emergency ? "devicePin.emergency.title" : "devicePin.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(emergency ? "devicePin.emergency.subtitle" : "devicePin.subtitle")}
        </p>
        {!emergency && (
          <p className="text-sm font-semibold" data-testid="active-staff">
            {active
              ? t("devicePin.activeNow", { name: active.displayName })
              : t("devicePin.activeNone")}
          </p>
        )}
      </header>

      <CardShell>
        <CardShellBody className="grid gap-5 p-4 sm:p-5">
          {session.lock.locked && (
            <LockoutNotice remainingMs={session.lock.remainingMs} />
          )}
          {picked === null && roster.length > 0 ? (
            <section aria-labelledby="pick-title" className="grid gap-3">
              <div>
                <h2 id="pick-title" className="type-heading">
                  {t("devicePin.switch.pickTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("devicePin.switch.pickHint")}
                </p>
              </div>
              <ul
                aria-label={t("devicePin.switch.pickLabel")}
                className="grid gap-2 sm:grid-cols-2"
              >
                {roster.map((entry) => (
                  <li key={entry.userId}>
                    <button
                      type="button"
                      onClick={() => setPicked(entry)}
                      className="flex min-h-16 w-full items-center gap-3 rounded-control border-(length:--border-w) bg-card px-4 text-left text-lg font-semibold shadow-hairline pressable hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <UserRound
                        className="size-6 shrink-0"
                        aria-hidden="true"
                      />
                      {entry.displayName}
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => setPicked("other")}
                    className="flex min-h-16 w-full items-center gap-3 rounded-control border-(length:--border-w) border-dashed bg-card px-4 text-left text-lg font-semibold pressable hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <UsersRound
                      className="size-6 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="grid">
                      {t("devicePin.switch.otherUser")}
                      <span className="text-sm font-normal text-muted-foreground">
                        {t("devicePin.switch.otherUserHint")}
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          ) : (
            <section className="grid gap-4">
              {roster.length === 0 && picked === null && (
                <EmptyState
                  icon={UsersRound}
                  title={t("devicePin.switch.emptyTitle")}
                  description={t("devicePin.switch.emptyHint")}
                  className="py-4"
                />
              )}
              {picked !== null && roster.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => setPicked(null)}
                >
                  <ArrowLeft aria-hidden="true" />
                  {t("devicePin.switch.back")}
                </Button>
              )}
              <PinPad
                {...session.padProps}
                active={!overrideOpen}
                label={
                  pickedName
                    ? t("devicePin.pad.forUser", { name: pickedName })
                    : t("devicePin.pad.label")
                }
              />
            </section>
          )}
          <p className="text-center text-xs text-muted-foreground">
            {t("devicePin.switch.stationNote")}
          </p>
          {active && !emergency && (
            <Button asChild variant="outline" className="justify-self-center">
              <Link to={shell === "pos" ? "/pos" : "/kds"}>
                {t(
                  shell === "pos"
                    ? "devicePin.switch.continuePos"
                    : "devicePin.switch.continueKds",
                )}
              </Link>
            </Button>
          )}
        </CardShellBody>
      </CardShell>

      {!emergency && (
        <CardShell>
          <CardShellBody className="grid gap-3 p-4 sm:p-5">
            <div>
              <h2 className="type-heading">{t("devicePin.demo.title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("devicePin.demo.description")}
              </p>
            </div>
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => setOverrideOpen(true)}
            >
              <ShieldCheck aria-hidden="true" />
              {t("devicePin.demo.action")}
            </Button>
            {overrideDone && (
              <p
                role="status"
                className="text-sm"
                data-testid="override-result"
              >
                <strong>{t("devicePin.demo.resultTitle")}. </strong>
                {t("devicePin.demo.resultBody", {
                  approver: overrideDone.approverName ?? "Supervisor",
                  method: t(
                    overrideDone.method === "supervisor_pin"
                      ? "devicePin.override.method.pin"
                      : "devicePin.override.method.phone",
                  ),
                })}
                <Money amount={overrideDone.valueIdr} size="sm" />
              </p>
            )}
          </CardShellBody>
        </CardShell>
      )}

      <OverrideRequestModal
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        action="refund"
        objectType="order"
        objectId={DEMO_OBJECT_ID}
        requesterId={active?.userId ?? null}
        outletId={active?.outletId}
        onRelogin={() => {
          setOverrideOpen(false);
          if (active)
            setPicked({
              userId: active.userId,
              displayName: active.displayName,
            });
        }}
        defaultValueIdr={350_000}
        onApproved={(result) => {
          setOverrideDone(result);
          setOverrideOpen(false);
        }}
      />
    </div>
  );
}
