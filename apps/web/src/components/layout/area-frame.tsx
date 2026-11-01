// The shell of an area, chosen by its definition (lib/areas/definitions.ts):
// Hangat → CustomerShell, Kontras Tinggi → OperationsShell, Padat →
// ManagementShell. Route layouts render <AreaFrame> around their <Outlet />.
import { useMemo, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
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
import { useOnline } from "@/lib/use-online";

/**
 * Outlet wall-clock zone until the outlet context bead supplies the outlet's
 * own IANA zone (PRD: business dates in the outlet time zone).
 */
const DEFAULT_OUTLET_TIME_ZONE = "Asia/Jakarta";

type SessionLike = { user: { name: string } } | null;

export function AreaFrame({
  area,
  access,
  gate,
  session,
  children,
}: {
  area: AreaKey;
  access: AreaAccess;
  gate: AreaGate;
  session: SessionLike;
  children: ReactNode;
}) {
  const t = useT();
  const online = useOnline();
  const { pathname } = useLocation();
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
  const brandName = t("app.defaultBrand");
  const signOut = session ? <SignOutButton /> : null;
  // Never offer sign-in to a visitor the guard already treats as signed in
  // (mock mode has access without a real session; the API still authorizes).
  const signIn =
    session || access.authenticated ? null : (
      <Button asChild variant="outline" size="sm">
        <Link to="/sign-in">{t("auth.signIn")}</Link>
      </Button>
    );

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
        {body}
      </ManagementShell>
    );
  }

  if (definition.shell === "operations") {
    return (
      <OperationsShell
        title={t(definition.nameKey)}
        outlet={t("area.ops.outletUnset")}
        staffName={session?.user.name}
        online={online}
        timeZone={DEFAULT_OUTLET_TIME_ZONE}
        mode={definition.forcedMode}
        actions={definition.forcedMode ? undefined : <ThemeToggle />}
      >
        <div className="h-full overflow-y-auto p-4">{body}</div>
      </OperationsShell>
    );
  }

  return (
    <CustomerShell
      brandName={brandName}
      nav={nav}
      LinkComponent={RouterShellLink}
      actions={
        <>
          <ThemeToggle />
          {signOut ?? signIn}
        </>
      }
    >
      {body}
    </CustomerShell>
  );
}
