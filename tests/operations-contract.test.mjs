// WS-14 daily-operations contract tests (bead legend-ptd8).
// PRD v1.7 §3 F45 "Operasional Harian" and §6 L; acceptance criteria
// OPS-01..OPS-05. Every test name carries the acceptance ID it proves.
// Run with: pnpm test (root node:test suite, no database needed).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";
import * as inventory from "../packages/shared/src/inventory/index.ts";
import * as operations from "../packages/shared/src/operations/index.ts";
import { matchEndpointPath } from "../packages/shared/src/api/index.ts";

const f = operations.cafeLegendOperationsFixtures;
const templateById = (templateId) =>
  f.checklistTemplates.find((template) => template.id === templateId);
const equipmentByName = (name) =>
  f.equipment.find((row) => row.name.includes(name));

test("WS-14 fixtures parse and cover the whole daily-operations contract", () => {
  operations.operationsFixtureSchema.parse(f);
  assert.ok(f.checklistTemplates.length >= 3);
  assert.ok(f.checklistRuns.length >= 5);
  assert.ok(f.equipment.length >= 8);
  assert.ok(f.maintenanceTickets.length >= 3);
  assert.ok(f.temperatureLogs.length >= 4);
  assert.ok(f.prepLabels.length >= 3);
  assert.ok(f.prepLists.length >= 1);
  assert.ok(f.shiftHandovers.length >= 2);

  for (const collection of [
    f.checklistTemplates,
    f.checklistRuns,
    f.equipment,
    f.maintenanceSchedules,
    f.maintenanceTickets,
    f.temperatureLogs,
    f.prepLabels,
    f.prepLists,
    f.shiftHandovers,
  ]) {
    assert.equal(
      new Set(collection.map((row) => row.id)).size,
      collection.length,
    );
    for (const row of collection) {
      assert.equal(row.tenantId, f.checklistTemplates[0].tenantId);
      assert.equal(row.outletId, f.checklistTemplates[0].outletId);
    }
  }

  // Every run snapshots a real template and its results address that snapshot.
  for (const run of f.checklistRuns) {
    const template = templateById(run.templateId);
    assert.ok(template, `run ${run.id} template`);
    assert.equal(run.templateVersion, template.version);
    assert.deepEqual(run.items, template.items);
    const snapshotItemIds = new Set(run.items.map((item) => item.id));
    for (const result of run.results)
      assert.equal(snapshotItemIds.has(result.itemId), true, result.itemId);
  }

  // Money is whole rupiah (D-CORE-2), ever a string or a fraction.
  const resolved = f.maintenanceTickets.find(
    (ticket) => ticket.costIdr !== null,
  );
  assert.equal(Number.isInteger(resolved.costIdr), true);
  assert.equal(resolved.costIdr, 850_000);
});

test("OPS-01 a missed or failed checklist alerts the supervisor within 15 minutes of the deadline", () => {
  const dueAt = "2026-11-01T01:30:00.000Z";
  assert.equal(
    operations.checklistAlertDeadline(dueAt),
    "2026-11-01T01:45:00.000Z",
  );
  assert.equal(operations.CHECKLIST_ALERT_GRACE_MINUTES, 15);

  const pending = { dueAt, status: "pending" };
  const inProgress = { dueAt, status: "in_progress" };
  const completed = { dueAt, status: "completed" };

  assert.equal(operations.isChecklistRunOverdue(pending, dueAt), true);
  assert.equal(
    operations.isChecklistRunOverdue(pending, "2026-11-01T01:29:59.999Z"),
    false,
  );
  assert.equal(operations.isChecklistRunOverdue(inProgress, dueAt), true);
  assert.equal(
    operations.isChecklistRunOverdue(completed, "2026-11-01T02:00:00.000Z"),
    false,
    "a finished run is never overdue",
  );

  assert.equal(
    operations.isChecklistAlertOnTime({ dueAt }, "2026-11-01T01:45:00.000Z"),
    true,
  );
  assert.equal(
    operations.isChecklistAlertOnTime({ dueAt }, "2026-11-01T01:45:00.001Z"),
    false,
  );

  // Both missed and failed are alert-worthy statuses (PRD F45).
  assert.equal(operations.transitionChecklistRun("pending", "miss"), "missed");
  assert.equal(
    operations.transitionChecklistRun("in_progress", "miss"),
    "missed",
  );
  assert.equal(
    operations.transitionChecklistRun("in_progress", "fail"),
    "failed",
  );
  assert.throws(
    () => operations.transitionChecklistRun("completed", "miss"),
    (error) => error.code === "CHECKLIST_TRANSITION_INVALID",
  );
  assert.throws(
    () => operations.transitionChecklistRun("missed", "start"),
    (error) => error.code === "CHECKLIST_TRANSITION_INVALID",
  );

  // The yesterday run in the fixtures is already missed, not merely overdue.
  const missedRun = f.checklistRuns.find((run) => run.status === "missed");
  assert.equal(operations.isChecklistRunOverdue(missedRun, f.now), false);
  const closingRun = f.checklistRuns.find(
    (run) =>
      run.status === "pending" && run.templateId === f.checklistTemplates[1].id,
  );
  assert.equal(operations.isChecklistRunOverdue(closingRun, f.now), false);
  assert.equal(
    operations.isChecklistRunOverdue(closingRun, "2026-11-01T15:16:00.000Z"),
    true,
  );
});

test("OPS-02 an out-of-range temperature cannot be saved without a corrective action", () => {
  const chiller = equipmentByName("Chiller Bar");
  const threshold = chiller.temperatureThreshold;
  assert.deepEqual(threshold, {
    minCelsius: "1.0000",
    maxCelsius: "4.0000",
  });

  assert.deepEqual(
    operations.temperatureLogIssues({
      readingCelsius: "9.2000",
      threshold,
      correctiveAction: null,
    }),
    ["CORRECTIVE_ACTION_REQUIRED"],
  );
  assert.throws(
    () =>
      operations.assertTemperatureLogAllowed({
        readingCelsius: "9.2000",
        threshold,
        correctiveAction: null,
      }),
    (error) =>
      error.name === "OperationsError" &&
      error.code === "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED" &&
      error.status === 422,
  );
  assert.equal(
    operations.assertTemperatureLogAllowed({
      readingCelsius: "9.2000",
      threshold,
      correctiveAction:
        "Susu dipindahkan ke chiller cadangan; teknisi chiller dipanggil.",
    }),
    undefined,
  );
  assert.equal(
    operations.assertTemperatureLogAllowed({
      readingCelsius: "3.5000",
      threshold,
      correctiveAction: null,
    }),
    undefined,
  );
  // Fail closed: a blank corrective action is no corrective action.
  for (const correctiveAction of ["", "   ", undefined])
    assert.throws(
      () =>
        operations.assertTemperatureLogAllowed({
          readingCelsius: "9.2000",
          threshold,
          correctiveAction,
        }),
      (error) => error.code === "TEMPERATURE_CORRECTIVE_ACTION_REQUIRED",
      JSON.stringify(correctiveAction),
    );

  // Inclusive bounds: equal to a bound is in range.
  assert.equal(operations.isTemperatureInRange("4.0000", threshold), true);
  assert.equal(operations.isTemperatureInRange("4.0001", threshold), false);

  const valid = f.temperatureLogs[0];
  assert.equal(valid.inRange, true);
  assert.equal(valid.correctiveAction, null);
  assert.equal(
    operations.temperatureLogSchema.safeParse({
      ...valid,
      inRange: false,
      correctiveAction: null,
    }).success,
    false,
    "OPS-02 rejects an excursion without a corrective action",
  );
  assert.equal(
    operations.temperatureLogSchema.safeParse({
      ...valid,
      correctiveAction: "Suhu sudah dicek ulang.",
    }).success,
    false,
    "an in-range reading carries no corrective action",
  );
  assert.equal(
    operations.temperatureThresholdSchema.safeParse({
      minCelsius: "4.0000",
      maxCelsius: "1.0000",
    }).success,
    false,
  );
});

test("OPS-03 prep labels carry a use-by linked to a batch and past-due labels are alerted", () => {
  const coldBrew = f.prepLabels[0];
  assert.ok(coldBrew.batchId);
  assert.equal(coldBrew.printedAt !== null, true);

  assert.equal(operations.isPrepLabelExpired(coldBrew, f.now), false);
  const expired = operations.expiredPrepLabels(f.prepLabels, f.now);
  assert.deepEqual(
    expired.map((prepLabel) => prepLabel.id),
    [f.prepLabels[2].id],
  );

  // useBy must be after production, and the batch link is mandatory.
  assert.equal(
    operations.prepLabelSchema.safeParse({
      ...coldBrew,
      useBy: coldBrew.producedAt,
    }).success,
    false,
  );
  const withoutBatch = { ...coldBrew };
  delete withoutBatch.batchId;
  assert.equal(
    operations.prepLabelSchema.safeParse(withoutBatch).success,
    false,
  );
});

test("OPS-04 a ticket that marks equipment broken disables its mapped menu items", () => {
  const blender = equipmentByName("Blender");
  assert.equal(blender.status, "broken");
  const disabled = operations.menuItemsDisabledByEquipment(blender);
  assert.deepEqual([...disabled], blender.linkedMenuItemIds);
  assert.equal(disabled.length, 3);

  const oven = equipmentByName("Oven");
  assert.equal(oven.status, "operational");
  assert.deepEqual([...operations.menuItemsDisabledByEquipment(oven)], []);

  assert.equal(
    operations.transitionEquipment("operational", "report_breakdown"),
    "broken",
  );
  assert.equal(
    operations.transitionEquipment("under_maintenance", "complete_maintenance"),
    "operational",
  );
  assert.throws(
    () => operations.transitionEquipment("retired", "report_breakdown"),
    (error) => error.code === "EQUIPMENT_TRANSITION_INVALID",
  );

  const ticket = f.maintenanceTickets.find((row) => row.marksEquipmentBroken);
  assert.ok(ticket.mediaIds.length >= 1, "a breakdown ticket has a photo");
  assert.equal(
    operations.maintenanceTicketSchema.safeParse({
      ...ticket,
      mediaIds: [],
    }).success,
    false,
    "PRD F45 requires the ticket photo",
  );
  assert.equal(
    operations.assertMaintenanceTicketHasPhoto(ticket.mediaIds),
    undefined,
  );
  assert.throws(
    () => operations.assertMaintenanceTicketHasPhoto([]),
    (error) => error.code === "MAINTENANCE_PHOTO_REQUIRED",
  );
  assert.equal(
    operations.transitionMaintenanceTicket("reported", "start"),
    "in_progress",
  );
  assert.throws(
    () => operations.transitionMaintenanceTicket("reported", "resolve"),
    (error) => error.code === "MAINTENANCE_TRANSITION_INVALID",
  );
});

test("OPS-05 a shift handover cannot close before the receiving shift confirms it", () => {
  const submitted = f.shiftHandovers.find((row) => row.status === "submitted");
  assert.equal(operations.shiftHandoverCanClose(submitted), false);
  assert.throws(
    () => operations.assertShiftHandoverClosable(submitted),
    (error) => error.code === "HANDOVER_ACKNOWLEDGEMENT_REQUIRED",
  );

  assert.throws(
    () =>
      operations.acknowledgeShiftHandover(submitted, {
        acknowledgedBy: submitted.submittedBy,
        acknowledgedAt: "2026-11-01T15:10:00.000Z",
      }),
    (error) => error.code === "HANDOVER_SELF_ACKNOWLEDGEMENT",
  );

  const receiver = f.shiftHandovers[1].acknowledgedBy;
  assert.ok(receiver);
  assert.notEqual(receiver, submitted.submittedBy);
  const acknowledged = operations.acknowledgeShiftHandover(submitted, {
    acknowledgedBy: receiver,
    acknowledgedAt: "2026-11-01T15:10:00.000Z",
  });
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(acknowledged.acknowledgedBy, receiver);
  assert.equal(operations.shiftHandoverCanClose(acknowledged), true);
  assert.equal(operations.assertShiftHandoverClosable(acknowledged), undefined);

  const already = f.shiftHandovers.find((row) => row.status === "acknowledged");
  assert.throws(
    () =>
      operations.acknowledgeShiftHandover(already, {
        acknowledgedBy: receiver,
        acknowledgedAt: "2026-11-01T15:20:00.000Z",
      }),
    (error) => error.code === "HANDOVER_ALREADY_ACKNOWLEDGED",
  );

  // The schema refuses a self-acknowledged or contradictory row.
  assert.equal(
    operations.shiftHandoverSchema.safeParse({
      ...acknowledged,
      acknowledgedBy: acknowledged.submittedBy,
    }).success,
    false,
  );
  assert.equal(
    operations.shiftHandoverSchema.safeParse({
      ...submitted,
      status: "acknowledged",
    }).success,
    false,
  );
  assert.equal(
    operations.shiftHandoverSchema.safeParse({
      ...submitted,
      acknowledgedBy: receiver,
    }).success,
    false,
    "a submitted handover carries no half-recorded confirmation",
  );
});

test("checklist evidence gates completion: photo, number and signature are enforced", () => {
  const template = templateById(f.checklistRuns[0].templateId);
  const run = f.checklistRuns[0];
  assert.equal(run.status, "completed");

  const resultFor = (itemId) =>
    run.results.find((result) => result.itemId === itemId);

  const photoItem = template.items.find((item) =>
    item.requiredEvidence.includes("photo"),
  );
  const photoResult = { ...resultFor(photoItem.id), photoMediaIds: [] };
  assert.deepEqual(
    operations.checklistItemResultIssues(photoItem, photoResult),
    ["PHOTO_REQUIRED"],
  );

  const numberItem = template.items.find((item) =>
    item.requiredEvidence.includes("number"),
  );
  assert.deepEqual(
    operations.checklistItemResultIssues(numberItem, {
      ...resultFor(numberItem.id),
      numberValue: null,
    }),
    ["NUMBER_REQUIRED"],
  );

  const signatureItem = template.items.find((item) =>
    item.requiredEvidence.includes("signature"),
  );
  assert.deepEqual(
    operations.checklistItemResultIssues(signatureItem, {
      ...resultFor(signatureItem.id),
      signatureMediaId: null,
    }),
    ["SIGNATURE_REQUIRED"],
  );

  assert.equal(
    operations.checklistCompletionStatus(template.items, run.results),
    "completed",
  );

  const failedResult = {
    ...resultFor(photoItem.id),
    status: "failed",
  };
  assert.equal(
    operations.checklistCompletionStatus(
      template.items,
      run.results.map((result) =>
        result.itemId === photoItem.id ? failedResult : result,
      ),
    ),
    "failed",
  );

  assert.throws(
    () =>
      operations.checklistCompletionStatus(
        template.items,
        run.results.map((result) =>
          result.itemId === photoItem.id
            ? {
                ...result,
                status: "pending",
                completedAt: null,
                completedBy: null,
              }
            : result,
        ),
      ),
    (error) => error.code === "CHECKLIST_ITEM_INCOMPLETE",
  );

  // A done result without author/time is invalid even without evidence rules.
  const plainItem = template.items.find(
    (item) => item.requiredEvidence.length === 0,
  );
  assert.equal(
    operations.checklistItemResultSchema.safeParse({
      ...resultFor(plainItem.id),
      completedAt: null,
    }).success,
    false,
  );
});

test("checklist runs snapshot the template items so later edits never change past runs (owner decision)", () => {
  const run = f.checklistRuns[0];
  const template = templateById(run.templateId);
  assert.deepEqual(operations.snapshotChecklistTemplate(template), {
    templateId: template.id,
    templateVersion: template.version,
    items: template.items,
  });

  // The template is edited later: an item is dropped and evidence tightened.
  const edited = operations.checklistTemplateSchema.parse({
    ...template,
    version: template.version + 1,
    items: template.items.slice(1).map((item) => ({
      ...item,
      requiredEvidence: ["photo", "number", "signature"],
    })),
  });
  // The past run still validates and completes against its own snapshot.
  assert.equal(operations.checklistRunSchema.safeParse(run).success, true);
  assert.equal(run.templateVersion, 1);
  assert.equal(
    operations.checklistCompletionStatus(run.items, run.results),
    "completed",
  );
  assert.throws(
    () => operations.checklistCompletionStatus(edited.items, run.results),
    (error) => error.code === "CHECKLIST_ITEM_NOT_IN_RUN",
  );

  // A run without its snapshot, or answering an item outside it, is refused.
  const withoutItems = { ...run };
  delete withoutItems.items;
  assert.equal(
    operations.checklistRunSchema.safeParse(withoutItems).success,
    false,
  );
  const withoutVersion = { ...run };
  delete withoutVersion.templateVersion;
  assert.equal(
    operations.checklistRunSchema.safeParse(withoutVersion).success,
    false,
  );
  assert.equal(
    operations.checklistRunSchema.safeParse({
      ...run,
      items: run.items.slice(1),
    }).success,
    false,
  );
});

test("checklist evidence is enforced by the run schema, not only by the service", () => {
  const run = f.checklistRuns[0];
  const strip = (kind, patch) => {
    const item = run.items.find((row) => row.requiredEvidence.includes(kind));
    return {
      ...run,
      results: run.results.map((result) =>
        result.itemId === item.id ? { ...result, ...patch } : result,
      ),
    };
  };
  for (const [kind, patch] of [
    ["photo", { photoMediaIds: [] }],
    ["number", { numberValue: null }],
    ["signature", { signatureMediaId: null }],
  ]) {
    assert.equal(
      operations.checklistRunSchema.safeParse(strip(kind, patch)).success,
      false,
      `a done item missing its ${kind} is refused`,
    );
    // The same gap is refused on an in-progress run too.
    assert.equal(
      operations.checklistRunSchema.safeParse({
        ...strip(kind, patch),
        status: "in_progress",
        completedAt: null,
      }).success,
      false,
      `in-progress ${kind}`,
    );
  }

  // A completed run has a finished answer for every snapshot item.
  assert.equal(
    operations.checklistRunSchema.safeParse({
      ...run,
      results: run.results.slice(1),
    }).success,
    false,
  );
  // OPS-01: completed vs failed follows the item outcomes exactly.
  assert.equal(
    operations.checklistRunSchema.safeParse({
      ...run,
      results: run.results.map((result, index) =>
        index === 0 ? { ...result, status: "failed" } : result,
      ),
    }).success,
    false,
    "OPS-01 a run with a failed item cannot be stored as completed",
  );
  const failedRun = f.checklistRuns.find((row) => row.status === "failed");
  assert.equal(
    operations.checklistRunSchema.safeParse({
      ...failedRun,
      status: "completed",
    }).success,
    false,
  );
});

test("maintenance vendors are purchasing suppliers; no vendor entity of its own (legend-uy1e)", () => {
  assert.equal("maintenanceVendorIdSchema" in operations, false);
  const supplierIds = new Set(
    inventory.cafeLegendPurchasingFixtures.suppliers.map((row) => row.id),
  );
  const vendorIds = [
    ...f.maintenanceSchedules.map((row) => row.vendorId),
    ...f.maintenanceTickets.map((row) => row.vendorId),
  ].filter((vendorId) => vendorId !== null);
  assert.ok(vendorIds.length >= 1);
  for (const vendorId of vendorIds)
    assert.equal(supplierIds.has(vendorId), true, vendorId);

  const ticket = f.maintenanceTickets[0];
  assert.equal(
    operations.maintenanceTicketSchema.safeParse({
      ...ticket,
      vendorId: "not-a-supplier",
    }).success,
    false,
  );
});

test("WS-14 domain events are catalogued and validate their payloads", () => {
  for (const name of operations.operationsEventNames) {
    const entry = events.eventCatalogByName.get(name);
    assert.ok(entry, `event ${name} is catalogued`);
    assert.equal(entry.workstream, "WS-14");
    assert.equal(entry.payloadSchemaRef, `${name}.v1`);
  }

  const missedRun = f.checklistRuns.find((run) => run.status === "missed");
  const missedEnvelope = {
    ...events.eventFixture,
    name: "checklist.missed",
    aggregateType: "checklist",
    payloadSchemaRef: "checklist.missed.v1",
    payload: {
      runId: missedRun.id,
      templateId: missedRun.templateId,
      shiftDate: missedRun.shiftDate,
      assignedTo: missedRun.assignedTo,
      dueAt: missedRun.dueAt,
      detectedAt: "2026-10-31T09:20:00.000Z",
    },
  };
  assert.equal(
    operations.checklistMissedEventPayloadSchema.safeParse(
      missedEnvelope.payload,
    ).success,
    true,
  );
  assert.equal(
    operations.operationsEventSchema.parse(missedEnvelope).name,
    "checklist.missed",
  );

  // OPS-01: a failed run alerts too and names the failed items.
  const failedRun = f.checklistRuns.find((run) => run.status === "failed");
  const failedEnvelope = {
    ...events.eventFixture,
    name: "checklist.failed",
    aggregateType: "checklist",
    payloadSchemaRef: "checklist.failed.v1",
    payload: {
      runId: failedRun.id,
      templateId: failedRun.templateId,
      shiftDate: failedRun.shiftDate,
      assignedTo: failedRun.assignedTo,
      dueAt: failedRun.dueAt,
      completedAt: failedRun.completedAt,
      failedItemIds: failedRun.results
        .filter((result) => result.status === "failed")
        .map((result) => result.itemId),
    },
  };
  assert.equal(
    operations.operationsEventSchema.safeParse(failedEnvelope).success,
    true,
  );
  assert.equal(
    operations.operationsEventSchema.safeParse({
      ...failedEnvelope,
      payload: { ...failedEnvelope.payload, failedItemIds: [] },
    }).success,
    false,
  );

  const excursion = f.temperatureLogs.find((log) => !log.inRange);
  const temperatureEnvelope = {
    ...events.eventFixture,
    name: "temperature.out_of_range",
    aggregateType: "temperature",
    payloadSchemaRef: "temperature.out_of_range.v1",
    payload: {
      temperatureLogId: excursion.id,
      equipmentId: excursion.equipmentId,
      readingCelsius: excursion.readingCelsius,
      minCelsius: "1.0000",
      maxCelsius: "4.0000",
      recordedAt: excursion.recordedAt,
      correctiveAction: excursion.correctiveAction,
    },
  };
  assert.equal(
    operations.operationsEventSchema.safeParse(temperatureEnvelope).success,
    true,
  );

  const ticket = f.maintenanceTickets.find((row) => row.marksEquipmentBroken);
  const blender = equipmentByName("Blender");
  const brokenEnvelope = {
    ...events.eventFixture,
    name: "equipment.broken",
    aggregateType: "equipment",
    payloadSchemaRef: "equipment.broken.v1",
    payload: {
      equipmentId: blender.id,
      ticketId: ticket.id,
      urgency: ticket.urgency,
      linkedMenuItemIds: blender.linkedMenuItemIds,
      reportedAt: ticket.reportedAt,
    },
  };
  assert.equal(
    operations.operationsEventSchema.safeParse(brokenEnvelope).success,
    true,
  );

  // A payload from another event and a foreign event name are both rejected.
  assert.equal(
    operations.operationsEventSchema.safeParse({
      ...missedEnvelope,
      payload: events.eventFixture.payload,
    }).success,
    false,
  );
  assert.equal(
    operations.operationsEventSchema.safeParse({
      ...events.eventFixture,
      name: "payment.paid",
      aggregateType: "payment",
    }).success,
    false,
  );
});

test("operations endpoints are unique and write inputs reject tenant fields (TEN-02, TEN-03)", () => {
  const pkg = JSON.parse(
    readFileSync(
      new URL("../packages/shared/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pkg.exports["./operations"], "./src/operations/index.ts");

  assert.ok(operations.operationsEndpoints.length >= 30);
  const ids = operations.operationsEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of operations.operationsEndpoints) {
    assert.equal(Object.isFrozen(endpoint), true);
    assert.ok(endpoint.path.startsWith("/api/operations/"), endpoint.path);
    const hasPathParam = endpoint.path
      .split("/")
      .some((part) => part.startsWith(":"));
    if (hasPathParam) assert.ok(endpoint.params, `${endpoint.id} params`);
  }
  const templateId = f.checklistTemplates[0].id;
  assert.deepEqual(
    matchEndpointPath(
      operations.getChecklistTemplate.path,
      `/api/operations/checklist-templates/${templateId}`,
    ),
    { templateId },
  );

  const template = f.checklistTemplates[0];
  const validTemplate = {
    outletId: template.outletId,
    name: "Checklist Buka Toko (cabang baru)",
    type: "opening",
    items: template.items.map((item) => ({
      label: item.label,
      instruction: item.instruction,
      requiredEvidence: item.requiredEvidence,
    })),
    schedule: template.schedule,
    roleId: template.roleId,
    idempotencyKey: "fixture-template-0001",
  };
  assert.equal(
    operations.createChecklistTemplateInputSchema.safeParse(validTemplate)
      .success,
    true,
  );
  assert.equal(
    operations.createChecklistTemplateInputSchema.safeParse({
      ...validTemplate,
      tenantId: template.tenantId,
    }).success,
    false,
  );

  const validLog = {
    outletId: template.outletId,
    equipmentId: equipmentByName("Chiller Bar").id,
    readingCelsius: "9.2000",
    correctiveAction: "Susu dipindahkan ke chiller cadangan.",
    idempotencyKey: "fixture-temperature-0001",
  };
  assert.equal(
    operations.createTemperatureLogInputSchema.safeParse(validLog).success,
    true,
  );
  assert.equal(
    operations.createTemperatureLogInputSchema.safeParse({
      ...validLog,
      readingCelsius: "suhu dingin",
    }).success,
    false,
  );

  const handover = f.shiftHandovers[0];
  assert.equal(
    operations.createShiftHandoverInputSchema.safeParse({
      outletId: handover.outletId,
      fromShiftTemplateId: handover.fromShiftTemplateId,
      toShiftTemplateId: handover.toShiftTemplateId,
      notes: handover.notes,
      idempotencyKey: "fixture-handover-0001",
    }).success,
    true,
  );

  // Lists always name an outlet, and a run always names an idempotency key.
  assert.equal(
    operations.checklistRunListQuerySchema.safeParse({}).success,
    false,
  );
  assert.equal(
    operations.createChecklistRunInputSchema.safeParse({
      outletId: template.outletId,
      templateId: template.id,
      shiftDate: "2026-11-01",
      assignedTo: handover.submittedBy,
    }).success,
    false,
  );
});

test("the operations contract is browser- and Node-safe and imports end in .ts", () => {
  const directory = new URL(
    "../packages/shared/src/operations/",
    import.meta.url,
  );
  const files = readdirSync(directory).filter((file) => file.endsWith(".ts"));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const source = readFileSync(new URL(file, directory), "utf8");
    assert.equal(/from\s+["']node:/.test(source), false, file);
    assert.equal(/\brequire\(/.test(source), false, file);
    assert.equal(/\bBuffer\./.test(source), false, file);
    assert.equal(/\bprocess\.env/.test(source), false, file);
    assert.equal(/\bdocument\.\w+\(/.test(source), false, file);
    assert.equal(/\bwindow\.\w+\(/.test(source), false, file);
    assert.equal(
      /from\s+["']\.\.?\/[^"']*(?<!\.ts)["']/.test(source),
      false,
      file,
    );
  }
});
