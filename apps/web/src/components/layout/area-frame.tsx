// The shell of an area, chosen by its definition (lib/areas/definitions.ts):
// Hangat → CustomerShell, Kontras Tinggi → OperationsShell, Padat →
// ManagementShell. Route layouts render <AreaFrame> around their <Outlet />.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useLocation,
  useParams,
  useRouteContext,
} from "@tanstack/react-router";
import type { MyOutlet } from "@starter/shared/access";
import type { BusinessDayCutoff } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { AreaGateScreen } from "@/components/layout/area-gate-screen";
import { AREA_ICONS } from "@/components/layout/area-icons";
import { OfflineBannerSlot } from "@/components/layout/offline-banner-slot";
import { OutletList, OutletPicker } from "@/components/layout/outlet-picker";
import { RouterShellLink } from "@/components/layout/router-link";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CustomerShell } from "@/components/shells/customer-shell";
import { ManagementShell } from "@/components/shells/management-shell";
import {
  OperationsScreenProvider,
  resolveOperationsTitle,
  useOperationsScreenValue,
} from "@/components/shells/operations-screen";
import { OperationsShell } from "@/components/shells/operations-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { AreaAccess } from "@/lib/areas/access";
import { AREAS, type AreaKey } from "@/lib/areas/definitions";
import type { AreaGate } from "@/lib/areas/guard";
import { buildAreaNav } from "@/lib/areas/nav";
import { registeredNav } from "@/lib/areas/nav-registry";
import {
  kelolaUsesOutletContext,
  noOutletNext,
  outletChoice,
  outletPickPending,
  readSavedOutletId,
  resolveSelectedOutlet,
  saveOutletId,
} from "@/lib/areas/outlet-selection";
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  resolveMockOutlets,
  resolveMockTenantContext,
  savedOutletCutoff,
} from "@/lib/mock/tenant-context";
import { ORG_OUTLET_STORE_EVENT } from "@/features/ws01-org/outlet-store";
import { TenantProvider, useTenantContext } from "@/lib/tenant-context";
import { useCloudConnection } from "@/features/ws02-edge/hooks";
import { TableCustomerFrame } from "@/features/ws03-qr-order/components/table-frame";
import { PushAutoRegister } from "@/features/ws05-notifications/components/push-auto-register";
import { IdleSessionWarning } from "@/features/ws01-auth/components/idle-session-warning";
import { ApprovalInboxBadge } from "@/features/ws01-approvals/components/inbox-badge";
import { SupportSessionBar } from "@/features/ws01-support-access/components/session-banner";
import { SupportReadOnlyProvider } from "@/features/ws01-support-access/read-only";
import { holdsAny } from "@/lib/areas/guard";

type SessionLike = { user: { name: string } } | null;

type AreaFrameProps = {
  area: AreaKey;
  access: AreaAccess;
  gate: AreaGate;
  session: SessionLike;
  children: ReactNode;
};

/**
 * Resolves the tenant/outlet config for this navigation and mounts it around
 * the shell. The outlet comes from the session's assigned outlets
 * (`access.outlets`, GET /api/me/access, legend-2aqp): the saved pick
 * (localStorage, validated against that list) or the first one. Mock mode
 * reads the Cafe Legend fixtures instead; with no outlet the provider fails
 * closed (catalog brand, no outlet → the shell keeps its neutral copy).
 *
 * legend-5kop: the saved business-day cutoff lives in sessionStorage, which
 * the SSR server does not have. The first render (server HTML and the hydration
 * pass) therefore uses the fixture config; a client effect then reads the saved
 * rows and replaces the cutoff, so the two renders that React compares are
 * identical and no hydration mismatch is possible. The effect also re-reads on
 * navigation and on ORG_OUTLET_STORE_EVENT (a save in this tab), so
 * `useOutletClock()` anywhere follows what the outlet settings screen
 * persisted. `?tenant=none` still resolves to no outlet in both passes.
 * The saved outlet pick lives in localStorage and follows the same rule: the
 * first render has not read it (`savedId` undefined) and an effect applies it.
 * With 2+ outlets the screen itself (`children`) is held behind a skeleton
 * until then, so no request goes out for the wrong outlet; server HTML and the
 * hydration pass both render the skeleton, so they match.
 */
export function AreaFrame(props: AreaFrameProps) {
  const { pathname, searchStr } = useLocation();
  // The signed-in user, for the push registration check below (null = none).
  const userId = useRouteContext({
    strict: false,
    select: (context) => context.session?.user.id ?? null,
  });
  const accessOutlets = props.access.outlets;
  // Server-safe list: the session's outlets, or the fixture outlet in mock
  // mode (none for ?tenant=none).
  const outlets = useMemo<readonly MyOutlet[]>(
    () => (API_MOCK ? resolveMockOutlets(searchStr) : accessOutlets),
    [searchStr, accessOutlets],
  );

  // undefined = localStorage not read yet (SSR and the hydration pass).
  const [savedId, setSavedId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setSavedId(readSavedOutletId());
    read();
    // A navigation re-reads the pick: another area's shell mounts fresh.
  }, [pathname]);
  const selected = useMemo(
    () => resolveSelectedOutlet(outlets, savedId),
    [outlets, savedId],
  );
  const selectOutlet = (outletId: string) => {
    saveOutletId(outletId);
    setSavedId(outletId);
  };

  const outletId = selected?.id ?? null;
  const [savedCutoff, setSavedCutoff] = useState<BusinessDayCutoff | null>(
    null,
  );
  useEffect(() => {
    const read = () =>
      setSavedCutoff(outletId === null ? null : savedOutletCutoff(outletId));
    read();
    window.addEventListener(ORG_OUTLET_STORE_EVENT, read);
    return () => window.removeEventListener(ORG_OUTLET_STORE_EVENT, read);
    // A navigation re-reads the store: the settings screen saves without
    // leaving its route, and another area's shell mounts fresh.
  }, [outletId, pathname]);

  const brandName = resolveMockTenantContext(searchStr)?.brandName;
  const config = useMemo(
    () => ({
      brandName,
      outlet: selected
        ? {
            ...selected,
            businessDayCutoff: savedCutoff ?? selected.businessDayCutoff,
          }
        : null,
    }),
    [brandName, selected, savedCutoff],
  );
  return (
    <TenantProvider config={config}>
      {/* Renews a push registration the server no longer lists (legend-xdlxa). */}
      {/* A shared tablet has no push registration (the API closes it). */}
      <PushAutoRegister userId={props.access.sharedDevice ? null : userId} />
      <AreaFrameBody
        {...props}
        outlets={outlets}
        pickPending={outletPickPending(outlets, savedId)}
        selectedOutletId={outletId}
        onSelectOutlet={selectOutlet}
      />
    </TenantProvider>
  );
}

/**
 * Operations shell fed by the screen: a screen that calls
 * useOperationsScreen names itself in the status bar and adds its actions
 * before the theme toggle; otherwise the status bar shows the area name.
 */
function OperationsFrame({
  areaTitle,
  staffName,
  online,
  forcedMode,
  outletControl,
  outletSheetControl,
  children,
}: {
  areaTitle: string;
  staffName?: string;
  online: boolean;
  forcedMode?: "dark";
  outletControl: ReactNode;
  outletSheetControl: ReactNode;
  children: ReactNode;
}) {
  const screen = useOperationsScreenValue();
  return (
    <OperationsShell
      title={resolveOperationsTitle(screen, areaTitle)}
      staffName={staffName}
      online={online}
      mode={forcedMode}
      outletControl={outletControl}
      outletSheetControl={outletSheetControl}
      actions={
        screen.actions || !forcedMode ? (
          <>
            {screen.actions}
            {forcedMode ? null : <ThemeToggle className="max-sm:size-11" />}
          </>
        ) : null
      }
    >
      <div className="h-full overflow-y-auto p-4">{children}</div>
    </OperationsShell>
  );
}

function AreaFrameBody({
  area,
  access,
  gate,
  session,
  children,
  outlets,
  pickPending,
  selectedOutletId,
  onSelectOutlet,
}: AreaFrameProps & {
  outlets: readonly MyOutlet[];
  pickPending: boolean;
  selectedOutletId: string | null;
  onSelectOutlet: (outletId: string) => void;
}) {
  const t = useT();
  const definition = AREAS[area];
  // Operations header badge = edge cloud link (legend-b0l9); other shells
  // render no badge, so they do not probe the edge node.
  const online = useCloudConnection({
    enabled: definition.shell === "operations",
  });
  const { brandName } = useTenantContext();
  const [announcement, setAnnouncement] = useState("");
  const { href, pathname } = useLocation();
  const { token } = useParams({ strict: false }) as { token?: string };
  const nav = useMemo(
    () =>
      buildAreaNav({
        area,
        entries: registeredNav,
        indexIcon: AREA_ICONS[area],
        access,
        pathname,
        t,
      }),
    [area, access, pathname, t],
  );

  if (gate.status === "forbidden" || gate.status === "mfa_required")
    return <AreaGateScreen area={area} gate={gate} />;

  // TEN-04: an impersonated session under a read_only grant sees a notice
  // and cannot submit forms (the API refuses the writes anyway). Platform
  // screens are the Super Admin's own and never read-only.
  const supportReadOnly =
    area !== "platform" && access.supportSession?.accessMode === "read_only";
  // PRD §3 F4 / TEN-04: one compact bar, sticky under the shell header, shows
  // a running support session (countdown; "Akhiri sesi" for the impersonator).
  // The customer shell only gets it for an impersonated session, so anonymous
  // guests never trigger the org grants request.
  const showSupportBar =
    area !== "platform" &&
    (access.supportSession != null || definition.shell !== "customer");
  // A staff account with no assigned outlet cannot work the outlet screens:
  // say so instead of calling outlet endpoints. Management screens stay open
  // (a new tenant creates its first outlet there).
  const noOutlet =
    definition.shell === "operations" &&
    access.authenticated &&
    outletChoice(outlets) === "none";
  // 2+ outlets: the operations shell offers the picker; one outlet needs no
  // control. The management shell offers it only on Kelola screens that work
  // in the selected outlet (legend-sp41n), never as a control that does nothing.
  const showOutletPicker =
    outletChoice(outlets) === "multiple" &&
    (definition.shell === "operations" ||
      (area === "kelola" && kelolaUsesOutletContext(pathname)));
  const pickOutlet = (outletId: string) => {
    onSelectOutlet(outletId);
    const name = outlets.find((row) => row.id === outletId)?.name;
    if (name) setAnnouncement(t("area.outletChanged", { name }));
  };
  // The operations shell hides the Select below `sm`; phones pick in a sheet.
  const outletPicker = showOutletPicker ? (
    <OutletPicker
      outlets={outlets}
      value={selectedOutletId}
      onChange={pickOutlet}
      className={
        definition.shell === "operations" ? "max-sm:hidden" : undefined
      }
    />
  ) : null;
  const outletSheetList =
    showOutletPicker && definition.shell === "operations" ? (
      <OutletList
        outlets={outlets}
        value={selectedOutletId}
        onChange={pickOutlet}
      />
    ) : null;
  // A Kelola screen that works in the selected outlet has nothing to load for
  // an account with no outlet (a new tenant): point to where the first outlet
  // is created instead of leaving a skeleton that never resolves.
  const kelolaNeedsOutlet =
    area === "kelola" &&
    access.authenticated &&
    outletChoice(outlets) === "none" &&
    kelolaUsesOutletContext(pathname);
  // Customer and public screens never depend on the staff outlet pick.
  const holdScreen = pickPending && definition.shell !== "customer";
  const noOutletAction =
    noOutletNext(access) === "kelola" ? (
      <Button asChild>
        <Link to={access.sharedDevice ? "/pos" : "/kelola"}>
          {t("area.noOutletKelola")}
        </Link>
      </Button>
    ) : (
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline">
          <Link to="/">{t("gate.backHome")}</Link>
        </Button>
        <SignOutButton />
      </div>
    );
  const body = (
    <SupportReadOnlyProvider value={supportReadOnly}>
      {showSupportBar ? (
        <SupportSessionBar
          supportSession={access.supportSession}
          className="mb-4 max-sm:mb-2"
        />
      ) : null}
      {area !== "platform" ? <OfflineBannerSlot /> : null}
      {outletPicker ? (
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      ) : null}
      {noOutlet ? (
        <EmptyState
          title={t("area.noOutletTitle")}
          description={t("area.noOutletHint")}
          action={noOutletAction}
        />
      ) : kelolaNeedsOutlet ? (
        <EmptyState
          title={t("area.noOutletTitle")}
          description={t("area.noOutletAddHint")}
          action={
            <Button asChild>
              <Link
                to={access.sharedDevice ? "/pos" : "/kelola/pengaturan/outlet"}
              >
                {t("area.noOutletAdd")}
              </Link>
            </Button>
          }
        />
      ) : holdScreen ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        children
      )}
    </SupportReadOnlyProvider>
  );
  const signOut = session ? <SignOutButton /> : null;

  if (definition.shell === "management") {
    const current = nav.find((item) => item.current);
    return (
      <ManagementShell
        brandName={brandName}
        nav={nav}
        pageTitle={current?.label ?? t(definition.nameKey)}
        LinkComponent={RouterShellLink}
        user={
          session && access.roleLabel
            ? { name: session.user.name, role: access.roleLabel }
            : undefined
        }
        actions={
          <>
            {outletPicker}
            <ApprovalInboxBadge
              enabled={
                area === "kelola" && holdsAny(access, ["approval.inbox.view"])
              }
            />
            <ThemeToggle />
            {signOut}
          </>
        }
      >
        {/* PRD §3 F6: management sessions end after 30 idle minutes; the
            warning rides the management shell so every screen shows it. */}
        <IdleSessionWarning />
        {body}
      </ManagementShell>
    );
  }

  if (definition.shell === "operations") {
    return (
      <OperationsScreenProvider>
        <OperationsFrame
          areaTitle={t(definition.nameKey)}
          staffName={session?.user.name}
          online={online}
          forcedMode={definition.forcedMode}
          outletControl={outletPicker}
          outletSheetControl={outletSheetList}
        >
          {body}
        </OperationsFrame>
      </OperationsScreenProvider>
    );
  }

  // Never offer sign-in to a visitor the guard already treats as signed in
  // (mock mode has access without a real session; the API still authorizes).
  const signIn =
    signOut ??
    (access.authenticated ? null : (
      <Button asChild variant="outline" size="sm">
        {/* legend-yoo9: a signed-out visitor returns to this page after /masuk. */}
        <Link to="/masuk" search={{ redirect: href }}>
          {t("auth.signIn")}
        </Link>
      </Button>
    ));

  // A table QR journey (/t/$token/*, PRD §3 F10) brings its own shell parts:
  // the tenant brand, "Meja A03 · 4 tamu" and the Menu/Keranjang/Pesanan/Tagihan nav.
  if (area === "customer" && token !== undefined && pathname.startsWith("/t/"))
    return (
      <TableCustomerFrame qrToken={token} pathname={pathname} signedIn={signIn}>
        {children}
      </TableCustomerFrame>
    );

  return (
    <CustomerShell
      brandName={brandName}
      pageTitle={
        nav.find((item) => item.current)?.label ?? t(definition.nameKey)
      }
      nav={nav}
      LinkComponent={RouterShellLink}
      actions={
        <>
          <ThemeToggle />
          {signIn}
        </>
      }
    >
      {body}
    </CustomerShell>
  );
}
