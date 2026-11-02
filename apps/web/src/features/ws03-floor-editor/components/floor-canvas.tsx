// The floor plan surface: every table as an absolutely positioned button in
// plan units, so dragging and keyboard steps stay in the same coordinate space
// the contract stores (`tables.layout`). Dragging works with a mouse and with
// a finger; arrow keys move the focused table by one grid step.
import * as React from "react";
import { cn } from "cn";
import { Plus } from "lucide-react";
import type { FloorZone, Table, TableLayout } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { GRID, PLAN_HEIGHT, PLAN_WIDTH } from "../lib";

const STEPS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -GRID],
  ArrowDown: [0, GRID],
  ArrowLeft: [-GRID, 0],
  ArrowRight: [GRID, 0],
};

const percent = (value: number, total: number) => `${(value / total) * 100}%`;

type Props = {
  /** Tables to draw; the caller filters by zone when a zone is selected. */
  tables: Table[];
  zones: FloorZone[];
  drafts: Record<string, TableLayout>;
  selectedId: string | null;
  onSelect: (tableId: string) => void;
  onMoveTo: (tableId: string, x: number, y: number) => void;
  onStep: (tableId: string, dx: number, dy: number) => void;
  onAddTable?: () => void;
};

function FloorCanvas({
  tables,
  zones,
  drafts,
  selectedId,
  onSelect,
  onMoveTo,
  onStep,
  onAddTable,
}: Props) {
  const t = useT();
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{
    id: string;
    pointerId: number;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);

  const startDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    tableId: string,
    layout: TableLayout,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = {
      id: tableId,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: layout.x,
      y: layout.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    const surface = surfaceRef.current;
    if (!state || !surface || state.pointerId !== event.pointerId) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = ((event.clientX - state.clientX) / rect.width) * PLAN_WIDTH;
    const dy = ((event.clientY - state.clientY) / rect.height) * PLAN_HEIGHT;
    onMoveTo(state.id, state.x + dx, state.y + dy);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const keyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tableId: string,
  ) => {
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    onStep(tableId, step[0], step[1]);
  };

  return (
    <CardShell>
      <Card className="overflow-x-auto">
        <div
          ref={surfaceRef}
          data-testid="floor-plan"
          className="relative w-full min-w-[640px] rounded-container border-(length:--border-w) border-dashed border-input bg-surface-2"
          style={{ aspectRatio: `${PLAN_WIDTH} / ${PLAN_HEIGHT}` }}
        >
          {tables.length === 0 && (
            <div className="absolute inset-0 grid place-items-center">
              <EmptyState
                title={t("floorEditor.planEmptyTitle")}
                description={t("floorEditor.planEmptyHint")}
                action={
                  onAddTable && (
                    <Button variant="outline" size="sm" onClick={onAddTable}>
                      <Plus aria-hidden="true" />
                      {t("floorEditor.addTable")}
                    </Button>
                  )
                }
              />
            </div>
          )}
          {tables.map((table) => {
            const layout = drafts[table.id] ?? table.layout;
            const selected = table.id === selectedId;
            const inactive = table.status === "inactive";
            const occupied = table.status === "occupied";
            const cleaning = table.status === "dirty";
            const zone = zones.find((entry) => entry.id === table.zoneId);
            return (
              <button
                key={table.id}
                type="button"
                aria-pressed={selected}
                aria-label={[
                  t("floorEditor.tableTitle", { code: table.code }),
                  t("floorEditor.planSeats", { count: table.capacity }),
                  zone?.name,
                  inactive ? t("floorEditor.planInactive") : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onPointerDown={(event) => startDrag(event, table.id, layout)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => keyDown(event, table.id)}
                onClick={() => onSelect(table.id)}
                style={{
                  left: percent(layout.x, PLAN_WIDTH),
                  top: percent(layout.y, PLAN_HEIGHT),
                  width: percent(layout.width, PLAN_WIDTH),
                  height: percent(layout.height, PLAN_HEIGHT),
                }}
                className={cn(
                  "pressable absolute grid touch-none place-content-center gap-0.5 p-1 text-center transition-colors duration-(--duration-fast)",
                  layout.shape === "round"
                    ? "rounded-full"
                    : "rounded-container",
                  // DESIGN.md §5 Operations tile states: empty = card + border;
                  // occupied = surface-3 warm grey without a border (Q27);
                  // cleaning = dashed border; inactive = surface-2, muted.
                  inactive
                    ? "border-(length:--border-w) border-dashed border-input bg-surface-2 text-muted-foreground"
                    : cleaning
                      ? "border-(length:--border-w) border-dashed border-input bg-card"
                      : occupied
                        ? "border-(length:--border-w) border-transparent bg-surface-3"
                        : "border-(length:--border-w) border-input bg-card",
                  !inactive && "hover:bg-surface-2",
                  selected && "border-primary ring-2 ring-ring",
                )}
              >
                <span className="block truncate text-sm leading-4 font-semibold tabular">
                  {table.code}
                </span>
                <span
                  className="block text-xs leading-3 text-muted-foreground tabular"
                  aria-hidden="true"
                >
                  {table.capacity}
                </span>
              </button>
            );
          })}
        </div>
      </Card>
    </CardShell>
  );
}

export { FloorCanvas };
