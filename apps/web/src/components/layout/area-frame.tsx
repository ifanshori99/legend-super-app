// The shell of an area, chosen by its definition (lib/areas/definitions.ts):
// Hangat → CustomerShell, Kontras Tinggi → OperationsShell, Padat →
// ManagementShell. Route layouts render <AreaFrame> around their <Outlet />.
import { useMemo, type ReactNode } from "react";
import { useLocation, useParams } from "@tanstack/react-router";
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
import { resolveMockTenantContext } from "@/lib/mock/tenant-context";
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
 */
export function AreaFrame(props: AreaFrameProps) {
  const { searchStr } = useLocation();
  const config = resolveMockTenantContext(searchStr);
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
