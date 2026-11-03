// The shell of an area, chosen by its definition (lib/areas/definitions.ts):
// Hangat → CustomerShell, Kontras Tinggi → OperationsShell, Padat →
// ManagementShell. Route layouts render <AreaFrame> around their <Outlet />.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import type { BusinessDayCutoff } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { AreaGateScreen } from "@/components/layout/area-gate-screen";
import { AREA_ICONS } from "@/components/layout/area-icons";
import { OfflineBannerSlot } from "@/components/layout/offline-banner-slot";
import { RouterShellLink } from "@/components/layout/router-link";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CustomerShell } from "@/components/shells/customer-shell";
import { ManagementShell } from "@/components/shells/management-shell";
import { OperationsShell } from "@/components/shells/operations-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import type { AreaAccess } from "@/lib/areas/access";
import { AREAS, type AreaKey } from "@/lib/areas/definitions";
import type { AreaGate } from "@/lib/areas/guard";
import { buildAreaNav } from "@/lib/areas/nav";
import { registeredNav } from "@/lib/areas/nav-registry";
import {
  resolveMockTenantContext,
  savedOutletCutoff,
} from "@/lib/mock/tenant-context";
import { ORG_OUTLET_STORE_EVENT } from "@/features/ws01-org/outlet-store";
import { TenantProvider, useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { TableCustomerFrame } from "@/features/ws03-qr-order/components/table-frame";
import { IdleSessionWarning } from "@/features/ws01-auth/components/idle-session-warning";

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
 * the shell. Mock mode reads the Cafe Legend fixtures; outside mock mode there
 * is no config source yet, so the provider fails closed (catalog brand, no
 * outlet → the shell keeps its neutral copy).
 *
 * legend-5kop: the saved business-day cutoff lives in sessionStorage, which
 * the SSR server does not have. The first render (server HTML and the hydration
 * pass) therefore uses the fixture config; a client effect then reads the saved
 * rows and replaces the cutoff, so the two renders that React compares are
 * identical and no hydration mismatch is possible. The effect also re-reads on
 * navigation and on ORG_OUTLET_STORE_EVENT (a save in this tab), so
 * `useOutletClock()` anywhere follows what the outlet settings screen
 * persisted. `?tenant=none` still resolves to null in both passes.
 */
export function AreaFrame(props: AreaFrameProps) {
  const { pathname, searchStr } = useLocation();
  // Server-safe base: fixture outlet, or null (mock off / ?tenant=none).
  const baseConfig = resolveMockTenantContext(searchStr);
  const outletId = baseConfig?.outlet?.id ?? null;

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

  const config = useMemo(
    () => resolveMockTenantContext(searchStr, savedCutoff),
    [searchStr, savedCutoff],
  );
  return (
    <TenantProvider config={config}>
      <AreaFrameBody {...props} />
    </TenantProvider>
  );
}

function AreaFrameBody({
  area,
  access,
  gate,
  session,
  children,
}: AreaFrameProps) {
  const t = useT();
  const online = useOnline();
  const { brandName } = useTenantContext();
  const { href, pathname } = useLocation();
  const { token } = useParams({ strict: false }) as { token?: string };
  const definition = AREAS[area];
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

  const body = (
    <>
      <OfflineBannerSlot />
      {children}
    </>
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
      <OperationsShell
        title={t(definition.nameKey)}
        staffName={session?.user.name}
        online={online}
        mode={definition.forcedMode}
        actions={definition.forcedMode ? undefined : <ThemeToggle />}
      >
        <div className="h-full overflow-y-auto p-4">{body}</div>
      </OperationsShell>
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
