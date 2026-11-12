// Status pill of a supervisor request: icon + text, never color alone.
import { CircleCheck, Clock, CircleX } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { statusLabelKey, statusTone } from "./queue-model.ts";

const ICONS = {
  warning: Clock,
  success: CircleCheck,
  danger: CircleX,
} as const;

export function QueueStatusPill({ status }: { status: string }) {
  const t = useT();
  const tone = statusTone(status);
  return (
    <StatusPill status={tone} icon={ICONS[tone]} className="whitespace-nowrap">
      {t(statusLabelKey(status))}
    </StatusPill>
  );
}
