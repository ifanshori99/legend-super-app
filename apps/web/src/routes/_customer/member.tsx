import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SESSION_GUARD } from "@/lib/areas/definitions";
import { runGuard } from "@/lib/areas/route";

// "/member/*" — signed-in customers only (PRD §5: dynamic, authorized). The
// manifest link makes the member pages installable as a PWA.
export const Route = createFileRoute("/_customer/member")({
  beforeLoad: ({ context }) => runGuard(SESSION_GUARD, context.access),
  head: () => ({ links: [{ rel: "manifest", href: "/manifest.webmanifest" }] }),
  component: Outlet,
});
