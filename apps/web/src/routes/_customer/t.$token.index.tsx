import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MenuPage } from "@/features/ws03-qr-order/components/menu-page";

// "/t/[token]" — the QR menu. Filters live in the URL (?q=&cat=&labels=&item=)
// so a filtered view and an open item survive reload (PRD §3 F10).
const searchSchema = z.object({
  q: z.string().max(80).optional().catch(undefined),
  cat: z.string().max(60).optional().catch(undefined),
  labels: z.string().max(120).optional().catch(undefined),
  item: z.string().max(60).optional().catch(undefined),
});

export const Route = createFileRoute("/_customer/t/$token/")({
  validateSearch: searchSchema,
  component: Menu,
});

function Menu() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MenuPage
      search={search}
      onSearchChange={(patch) =>
        void navigate({
          search: (previous) => {
            const next = { ...previous, ...patch };
            return { ...next, q: next.q ? next.q : undefined };
          },
          replace: true,
        })
      }
    />
  );
}
