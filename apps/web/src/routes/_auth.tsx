import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { publicSiteQuery } from "@/features/ws08-website/queries";
import { postLoginPath } from "@/lib/areas/post-login";

// Pathless layout: /sign-in and /sign-up. Signed-in visitors go to the app:
// the back-office dashboard for management sessions, else the customer home.
export const Route = createFileRoute("/_auth")({
  beforeLoad: ({ context }) => {
    if (context.session) throw redirect({ to: postLoginPath(context.access) });
  },
  // Fill the cache so SSR already has the tenant brand; an unrecognized host
  // fails the call and the layout falls back to the catalog brand.
  loader: ({ context }) =>
    context.queryClient
      .ensureQueryData({ ...publicSiteQuery(), retry: false })
      .catch(() => null),
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="min-h-svh">
      <header className="mx-auto max-w-6xl px-6 py-6 sm:px-10">
        <Brand />
      </header>
      <main
        id="main-content"
        className="mx-auto flex min-h-[75svh] max-w-6xl items-center justify-center px-6 py-12"
      >
        <Outlet />
      </main>
    </div>
  );
}
