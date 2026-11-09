// Pure checks of the daily-ops notification event payloads (legend-lvx2).
// No database: envelope + payload validation against the shared contract.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eventCatalogByName, eventFixture } from "@starter/shared/events";
import {
  operationsEventPayloadSchemas,
  operationsEventSchema,
} from "@starter/shared/operations";

const now = "2026-11-01T01:00:00.000Z";
const checklistBase = {
  runId: randomUUID(),
  templateId: randomUUID(),
  shiftDate: "2026-11-01",
  assignedTo: randomUUID(),
  dueAt: "2026-11-01T03:00:00.000Z",
};

const cases = [
  {
    name: "checklist.completed",
    aggregateType: "checklist",
    payload: { ...checklistBase, completedAt: now },
    idField: "runId",
    requiredField: "completedAt",
  },
  {
    name: "checklist.reminded",
    aggregateType: "checklist",
    payload: { ...checklistBase, remindedAt: now },
    idField: "templateId",
    requiredField: "remindedAt",
  },
  {
    name: "equipment_service.reminded",
    aggregateType: "equipment_service",
    payload: {
      scheduleId: randomUUID(),
      equipmentId: randomUUID(),
      nextDueAt: "2026-11-03T00:00:00.000Z",
      vendorId: null,
      remindedAt: now,
    },
    idField: "scheduleId",
    requiredField: "nextDueAt",
  },
  {
    name: "prep_list.created",
    aggregateType: "prep_list",
    payload: {
      prepListId: randomUUID(),
      prepDate: "2026-11-02",
      lineCount: 4,
      generatedFromForecastId: null,
      generatedAt: now,
    },
    idField: "prepListId",
    requiredField: "lineCount",
  },
] as const;

const envelope = (c: (typeof cases)[number], payload: object) => ({
  ...eventFixture,
  name: c.name,
  aggregateType: c.aggregateType,
  payloadSchemaRef: `${c.name}.v1`,
  payload,
});

describe("daily-ops notification event payloads", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("is catalogued with a matching <name>.v1 payload ref", () => {
        const entry = eventCatalogByName.get(c.name);
        expect(entry?.workstream).toBe("WS-14");
        expect(entry?.payloadSchemaRef).toBe(`${c.name}.v1`);
        expect(operationsEventPayloadSchemas[c.name]).toBeDefined();
      });

      it("accepts a valid envelope", () => {
        expect(
          operationsEventSchema.safeParse(envelope(c, c.payload)).success,
        ).toBe(true);
      });

      it("rejects a missing field", () => {
        const rest: Record<string, unknown> = { ...c.payload };
        delete rest[c.requiredField];
        expect(operationsEventSchema.safeParse(envelope(c, rest)).success).toBe(
          false,
        );
      });

      it("rejects an extra key", () => {
        expect(
          operationsEventSchema.safeParse(
            envelope(c, { ...c.payload, extra: true }),
          ).success,
        ).toBe(false);
      });

      it("rejects a wrong id", () => {
        expect(
          operationsEventSchema.safeParse(
            envelope(c, { ...c.payload, [c.idField]: "not-a-uuid" }),
          ).success,
        ).toBe(false);
      });
    });
  }

  it("prep_list.created needs at least one line", () => {
    const c = cases[3];
    expect(
      operationsEventSchema.safeParse(
        envelope(c, { ...c.payload, lineCount: 0 }),
      ).success,
    ).toBe(false);
  });

  it("equipment_service.reminded accepts a supplier vendor id", () => {
    const c = cases[2];
    expect(
      operationsEventSchema.safeParse(
        envelope(c, { ...c.payload, vendorId: randomUUID() }),
      ).success,
    ).toBe(true);
  });
});
