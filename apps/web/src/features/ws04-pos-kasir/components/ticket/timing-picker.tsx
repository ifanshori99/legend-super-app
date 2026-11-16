import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { formatClock } from "../../../facility/flow";
import { useTicketSlots } from "../../ticket/hooks";
import type {
  TicketArea,
  TicketProduct,
  TicketTiming,
} from "../../ticket/types";
import { Notice, PosPanel } from "../shared";
import { TicketError } from "./ticket-error";

// Step 3: the area and when the guest enters. Free start times are the
// server's availability; the screen never builds a slot itself.
export function TimingPicker({
  product,
  areaId,
  timing,
  disabled,
  onArea,
  onTiming,
}: {
  product: TicketProduct | null;
  areaId: string;
  timing: TicketTiming;
  disabled?: boolean;
  onArea: (areaId: string) => void;
  onTiming: (timing: TicketTiming) => void;
}) {
  const t = useT();
  const wantsSlot = timing.kind === "slot";
  const slots = useTicketSlots(
    product && wantsSlot ? product.facilityId : "",
    areaId,
  );
  const areas: TicketArea[] = product?.areas ?? [];

  return (
    <PosPanel title={t("posKasirTicket.timing.title")}>
      {!product ? (
        <p className="text-muted-foreground">
          {t("posKasirTicket.summary.incomplete")}
        </p>
      ) : areas.length === 0 ? (
        <Notice tone="warning" title={t("posKasirTicket.timing.noArea")}>
          {t("posKasirTicket.timing.noAreaHint")}
        </Notice>
      ) : (
        <div className="grid gap-4">
          {areas.length > 1 && (
            <SegmentedControl
              value={areaId}
              onValueChange={onArea}
              label={t("posKasirTicket.timing.area")}
              options={areas.map((area) => ({
                value: area.id,
                label: area.name,
              }))}
            />
          )}
          <SegmentedControl
            value={timing.kind}
            onValueChange={(kind) =>
              onTiming(
                kind === "now"
                  ? { kind: "now" }
                  : { kind: "slot", startsAt: "", endsAt: "" },
              )
            }
            label={t("posKasirTicket.timing.when")}
            options={[
              { value: "now", label: t("posKasirTicket.timing.now") },
              { value: "slot", label: t("posKasirTicket.timing.slot") },
            ]}
          />
          {wantsSlot &&
            (slots.isLoading ? (
              <div role="status" aria-busy="true" className="grid gap-2">
                <span className="sr-only">
                  {t("posKasirTicket.timing.slotsLoading")}
                </span>
                <Skeleton className="h-10 w-full" />
              </div>
            ) : slots.isError ? (
              <TicketError
                error={slots.error}
                title={t("posKasirTicket.timing.slotsErrorTitle")}
                onRetry={() => void slots.refetch()}
              />
            ) : (slots.data ?? []).length === 0 ? (
              <Notice tone="info" title={t("posKasirTicket.timing.slotEmpty")}>
                {t("posKasirTicket.timing.slotEmptyHint")}
              </Notice>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {(slots.data ?? []).map((slot) => {
                  const range = t("posKasirTicket.timing.slotRange", {
                    from: formatClock(slot.startsAt),
                    until: formatClock(slot.endsAt),
                  });
                  const selected =
                    timing.kind === "slot" && timing.startsAt === slot.startsAt;
                  return (
                    <li key={slot.startsAt}>
                      <Button
                        type="button"
                        variant={selected ? "default" : "outline"}
                        aria-pressed={selected}
                        aria-label={t("posKasirTicket.timing.slotPick", {
                          range,
                        })}
                        disabled={disabled}
                        className="tabular"
                        onClick={() =>
                          onTiming({
                            kind: "slot",
                            startsAt: slot.startsAt,
                            endsAt: slot.endsAt,
                          })
                        }
                      >
                        {range}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      )}
    </PosPanel>
  );
}
