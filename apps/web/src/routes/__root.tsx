import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Providers } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { loadAreaAccess } from "@/lib/areas/load-access";
import type { AreaAccess } from "@/lib/areas/access";
import { getSessionFn, type Session } from "@/lib/session";
import globalsCss from "@/styles/globals.css?url";

// Head and the document shell render outside I18nProvider: default catalog.
const staticT = createTranslator();

export type RouterContext = {
  queryClient: QueryClient;
  session: Session | null;
  /** What the visitor may reach; presentation only (see lib/areas). */
  access: AreaAccess;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  // One session read per navigation (the API, via the auth middleware), shared
  // with every route as context. Layouts decide what to do with it; the API
  // still authenticates every request on its own.
  beforeLoad: async () => {
    const session = await getSessionFn();
    return { session, access: await loadAreaAccess(session) };
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
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers>
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

function NotFound() {
  const t = useT();
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
        <Link to="/">{t("errorPage.goHome")}</Link>
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
