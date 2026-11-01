// Four-step progress of one item: Diterima, Diproses, Siap, Diantar
// (PRD §3 F10 "Status Pesanan"). Never color alone: every step has an icon and
// its name, and the list carries "Langkah 2 dari 4: Diproses" for readers.
import { cn } from "cn";
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { useT } from "@/components/i18n";
import { itemStepIndex, type ItemStep } from "../../domain";

const STEPS = [
  { step: "received", label: "qrOrders.status.step.received" },
  { step: "preparing", label: "qrOrders.status.step.preparing" },
  { step: "ready", label: "qrOrders.status.step.ready" },
  { step: "delivered", label: "qrOrders.status.step.delivered" },
] as const satisfies readonly { step: ItemStep; label: string }[];

export function OrderStepper({ step }: { step: ItemStep }) {
  const t = useT();
  const current = itemStepIndex(step);
  const currentLabel = t(STEPS[current].label);
  return (
    <ol
      aria-label={t("qrOrders.status.step.aria", {
        current: current + 1,
        total: STEPS.length,
        label: currentLabel,
      })}
      className="grid grid-cols-4 gap-1"
    >
      {STEPS.map(({ step: name, label }, index) => {
        const reached = index <= current;
        const isCurrent = index === current;
        const Icon =
          isCurrent && name !== "delivered"
            ? CircleDot
            : reached
              ? CircleCheck
              : Circle;
        return (
          <li
            key={name}
            aria-current={isCurrent ? "step" : undefined}
            className="grid gap-1"
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-1 rounded-full",
                reached ? "bg-foreground" : "bg-border",
              )}
            />
            <span
              className={cn(
                "flex items-center gap-1 text-xs leading-4",
                isCurrent
                  ? "font-semibold text-foreground"
                  : reached
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t(label)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
