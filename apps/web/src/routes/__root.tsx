import { useEffect, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  notFound,
  Outlet,
  Scripts,
  rootRouteId,
  useMatch,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { createTranslator, type MessageOverrides } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Providers } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { PushOwnerGuard } from "@/features/ws05-notifications/components/push-owner-guard";
import { isScreenClosedOnSharedDevice } from "@/lib/areas/guard";
import { loadAreaAccess } from "@/lib/areas/load-access";
import type { AreaAccess } from "@/lib/areas/access";
import { getSessionFn, type Session } from "@/lib/session";
import { getTenantBrandFn } from "@/lib/tenant-brand-fn";
import { brandContextToThemeConfig } from "@/lib/tenant-brand";
import { TenantThemeStyle } from "@/lib/theme";
import type { TenantThemeConfig } from "@starter/shared/theme";
import globalsCss from "@/styles/globals.css?url";

// Head and the document shell render outside I18nProvider: default catalog.
const staticT = createTranslator();

// Browser-only memory of the last resolved tenant theme (see beforeLoad).
let lastTenantTheme: TenantThemeConfig | null = null;

export type RouterContext = {
  queryClient: QueryClient;
  session: Session | null;
  /** What the visitor may reach; presentation only (see lib/areas). */
  access: AreaAccess;
  /**
   * Theme of the brand the request host resolved to (D44); null on a host
   * with no tenant or no active theme, so the Base Theme applies.
   */
  tenantTheme: TenantThemeConfig | null;
  /** Public `terms.*` text overrides of the request host; empty when none. */
  textOverrides: MessageOverrides;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  // One session read per navigation (the API, via the auth middleware), shared
  // with every route as context. Layouts decide what to do with it; the API
  // still authenticates every request on its own.
  beforeLoad: async ({ location }) => {
    const [session, brand] = await Promise.all([
      getSessionFn(),
      getTenantBrandFn(),
    ]);
    const isBrowser = typeof window !== "undefined";
    let tenantTheme: TenantThemeConfig | null;
    if (brand.kind === "error") {
      // A transient API failure keeps the theme the browser already showed.
      // Browser only: a module variable on the server would leak across hosts.
      tenantTheme = isBrowser ? lastTenantTheme : null;
    } else {
      tenantTheme = brandContextToThemeConfig(
        brand.kind === "brand" ? brand.brand : null,
      );
      if (isBrowser) lastTenantTheme = tenantTheme;
    }
    const access = await loadAreaAccess(session);
    // Shared tablet (founder Q29): screens outside the allowlist do not exist
    // there, in every area. The API refuses their requests as well.
    if (isScreenClosedOnSharedDevice(access, location.pathname))
      throw notFound({ data: { sharedDevice: true } });
    return {
      session,
      access,
      tenantTheme,
      textOverrides: brand.overrides,
    };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: staticT("app.defaultBrand") },
      { name: "description", content: staticT("app.description") },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
});

function RootLayout() {
  const userId = useRouteContext({
    from: rootRouteId,
    select: (context) => context.session?.user.id ?? null,
  });
  return (
    <>
      <PushOwnerGuard userId={userId} />
      <Outlet />
    </>
  );
}

/**
 * Marks the document once React has hydrated and committed (`data-hydrated` on
 * <html>). Server HTML paints and accepts typing before handlers exist, so e2e
 * waits for this attribute before it interacts (legend-doykg).
 */
function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}

function RootDocument({ children }: { children: ReactNode }) {
  // The shell also renders when root beforeLoad failed, so the match may have
  // no tenant theme: the Base Theme applies then.
  const tenantTheme = useMatch({
    from: rootRouteId,
    shouldThrow: false,
    select: (match) => match.context.tenantTheme ?? null,
  });
  const overrides = useMatch({
    from: rootRouteId,
    shouldThrow: false,
    select: (match) => match.context.textOverrides,
  });
  return (
    <html lang="id" data-tenant={tenantTheme?.id} suppressHydrationWarning>
      <head>
        <HeadContent />
        {tenantTheme ? <TenantThemeStyle tenant={tenantTheme} /> : null}
      </head>
      <body>
        <HydrationMarker />
        <Providers overrides={overrides}>
          <a
            href="#main-content"
            className="sr-only z-50 rounded-md bg-foreground p-3 text-background focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
          >
            {staticT("shell.skipToContent")}
          </a>
          {children}
        </Providers>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound({ data }: { data?: unknown }) {
  const t = useT();
  // A shared tablet (founder Q29) has no public home: "go home" opens the POS.
  // The thrown notFound carries the flag (the root context is not built yet).
  const sharedDevice =
    typeof data === "object" &&
    data !== null &&
    (data as { sharedDevice?: unknown }).sharedDevice === true;
  return (
    <main id="main-content" className="mx-auto max-w-lg px-6 py-24">
      <p className="mb-3 font-mono text-sm text-primary">404</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {t("errorPage.notFoundTitle")}
      </h1>
      <p className="my-4 text-muted-foreground">
        {t("errorPage.notFoundHint")}
      </p>
      <Button asChild>
        <Link to={sharedDevice ? "/pos" : "/"}>{t("errorPage.goHome")}</Link>
      </Button>
    </main>
  );
}

function ErrorPage() {
  const t = useT();
  const router = useRouter();
  return (
    <main id="main-content" className="mx-auto max-w-lg px-6 py-24">
      <h1 className="text-2xl font-semibold">{t("errorPage.errorTitle")}</h1>
      <p className="my-4 leading-7 text-muted-foreground">
        {t("errorPage.errorHint")}
      </p>
      <Button onClick={() => router.invalidate()}>{t("common.retry")}</Button>
    </main>
  );
}
