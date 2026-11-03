// Who acted: the actor kind as an icon + text badge (never colour alone).
import { Bot, Cog, Plug, Tablet, User, type LucideIcon } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import type { AuditActorType } from "@starter/shared/audit";
import { ACTOR_LABEL_KEYS } from "../labels";

const ICONS: Record<AuditActorType, LucideIcon> = {
  user: User,
  ai: Bot,
  mcp_client: Plug,
  system: Cog,
  device: Tablet,
};

const TONES = {
  user: "neutral",
  ai: "info",
  mcp_client: "brand",
  system: "neutral",
  device: "neutral",
} as const satisfies Record<AuditActorType, string>;

export function ActorBadge({ type }: { type: AuditActorType }) {
  const t = useT();
  const Icon = ICONS[type];
  return (
    <Badge tone={TONES[type]}>
      <Icon aria-hidden="true" />
      {t(ACTOR_LABEL_KEYS[type])}
    </Badge>
  );
}
