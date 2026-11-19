import { Plug } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: AI and MCP admin (service switches, clients, quota). The
// page guard re-checks the permissions; the API authorizes every request.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.aiAdmin",
    to: "/kelola/pengaturan/mcp-ai",
    icon: Plug,
    order: 94,
    anyPermission: ["ai.governance.manage", "mcp.client.manage"],
  },
];

export default nav;
