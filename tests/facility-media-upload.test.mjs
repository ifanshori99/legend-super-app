import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  storageSourceKindPurpose,
  storageSourceKindSchema,
  uploadStorageMetadataSchema,
} from "../packages/shared/src/storage/index.ts";

// Brief 787 (legend-wf37, legend-xxx6): the cleaning, breakdown-ticket and
// checklist screens must upload real files through the storage client instead
// of minting a random id with newIdempotencyKey(). These are source-level
// checks (TypeScript AST) in the same spirit as media-screens-upload.test.mjs:
// the screens are wrapped in Radix dialogs and offline queues that are not
// worth faking, so we assert the contract each screen must honour.
//
// Assumption: a screen may upload through `uploadStorageFile` directly or
// through `useUploadStorageFile().mutateAsync`; either way the call carries an
// object literal with `sourceKind`, so the check keys off that literal.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const features = new URL("../apps/web/src/features/", import.meta.url);

const screens = [
  {
    name: "cleaning dialog",
    file: "facility-staff/components/cleaning-dialog.tsx",
    sourceKind: "cleaning_task",
  },
  {
    name: "breakdown ticket form",
    file: "operations-equipment/components/ticket-form-dialog.tsx",
    sourceKind: "maintenance_ticket",
  },
  {
    name: "checklist item card",
    file: "operations-checklist/components/checklist-item-card.tsx",
    sourceKind: "checklist_evidence",
  },
];
const signatureFile = "operations-checklist/components/signature-field.tsx";

function parse(relative) {
  const url = new URL(relative, features);
  return ts.createSourceFile(
    url.href,
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function collect(source, predicate) {
  const found = [];
  walk(source, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function propertyName(node) {
  if (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isBindingElement(node)
  )
    return node.name.getText();
  return undefined;
}

function identifierUsed(source, name) {
  return (
    collect(source, (node) => ts.isIdentifier(node) && node.text === name)
      .length > 0
  );
}

/** Object literals that look like a storage upload request. */
function uploadRequests(source) {
  return collect(
    source,
    (node) =>
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((p) => propertyName(p) === "sourceKind"),
  );
}

function literalOf(objectLiteral, name) {
  const property = objectLiteral.properties.find(
    (p) => propertyName(p) === name,
  );
  if (!property) return undefined;
  if (ts.isPropertyAssignment(property))
    return ts.isStringLiteralLike(property.initializer)
      ? property.initializer.text
      : property.initializer.getText();
  return name;
}

// A media/photo/signature value must never come from newIdempotencyKey().
function idempotencyKeyMintsMedia(source) {
  const bad = [];
  walk(source, (node) => {
    if (
      !ts.isCallExpression(node) ||
      node.expression.getText() !== "newIdempotencyKey"
    )
      return;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) break;
      const name = propertyName(parent);
      const callee = ts.isCallExpression(parent)
        ? parent.expression.getText()
        : undefined;
      if (
        /media|photo|signature/i.test(name ?? "") ||
        /setPhoto|setSignature|setMedia/i.test(callee ?? "")
      ) {
        bad.push(parent.getText().slice(0, 80));
        break;
      }
    }
  });
  return bad;
}

test("[legend-wf37] shared contract: facility source kinds are receipt-purpose evidence", () => {
  for (const kind of [
    "cleaning_task",
    "maintenance_ticket",
    "checklist_evidence",
  ]) {
    assert.equal(
      storageSourceKindSchema.safeParse(kind).success,
      true,
      `${kind} is an accepted storage source kind`,
    );
    assert.equal(storageSourceKindPurpose[kind], "receipt");
    const metadata = uploadStorageMetadataSchema.safeParse({
      purpose: "receipt",
      sourceKind: kind,
      outletId: "00000000-0000-4000-8000-000000000002",
    });
    assert.equal(metadata.success, true, `${kind} upload metadata validates`);
  }
});

for (const { name, file, sourceKind } of screens) {
  const source = parse(file);

  test(`[legend-wf37] ${name} uploads the chosen photo as ${sourceKind} evidence`, () => {
    assert.ok(
      identifierUsed(source, "uploadStorageFile") ||
        identifierUsed(source, "useUploadStorageFile"),
      "screen uses the storage upload client",
    );
    assert.ok(
      identifierUsed(source, "normalizeImageFile"),
      "camera photos are normalized before upload",
    );
    const requests = uploadRequests(source);
    assert.ok(requests.length > 0, "an upload request names its sourceKind");
    assert.ok(
      requests.some(
        (request) =>
          literalOf(request, "sourceKind") === sourceKind &&
          literalOf(request, "purpose") === "receipt",
      ),
      `upload uses purpose receipt and sourceKind ${sourceKind}`,
    );
    for (const request of requests) {
      assert.ok(
        request.properties.some((p) => propertyName(p) === "outletId"),
        "upload names the outlet the screen works in",
      );
      assert.ok(
        request.properties.some((p) => propertyName(p) === "signal"),
        "upload can be aborted",
      );
    }
  });

  test(`[legend-wf37] ${name} never sends a locally minted or data-URL media id`, () => {
    assert.deepEqual(
      idempotencyKeyMintsMedia(source),
      [],
      "newIdempotencyKey() must not produce a media id",
    );
    assert.equal(
      identifierUsed(source, "readAsDataURL"),
      false,
      "no data URL is persisted",
    );
  });

  test(`[legend-wf37] ${name} aborts, blocks submit while uploading and offers a retry`, () => {
    assert.ok(
      identifierUsed(source, "AbortController"),
      "an in-flight upload is cancelled on replace/unmount",
    );
    const blocking = collect(
      source,
      (node) =>
        ts.isJsxAttribute(node) &&
        ["disabled", "loading"].includes(node.name.getText()) &&
        /upload|pending/i.test(node.initializer?.getText() ?? ""),
    );
    assert.ok(blocking.length > 0, "submit is disabled while a photo uploads");
    const retryProp = collect(
      source,
      (node) => ts.isJsxAttribute(node) && node.name.getText() === "onRetry",
    );
    const retryCopy = collect(
      source,
      (node) => ts.isStringLiteralLike(node) && node.text === "common.retry",
    );
    assert.ok(
      retryProp.length + retryCopy.length > 0,
      "a failed upload shows a 'Coba lagi' retry",
    );
  });
}

test("[legend-wf37] signature is exported from the canvas and uploaded as checklist_evidence", () => {
  const field = parse(signatureFile);
  const card = parse(screens[2].file);
  const exportsCanvas = collect(
    field,
    (node) =>
      ts.isCallExpression(node) && /\.toBlob$/.test(node.expression.getText()),
  );
  assert.ok(exportsCanvas.length > 0, "the signature pad exports a PNG blob");
  assert.ok(
    field.getText().includes("image/png"),
    "signature image is exported as PNG",
  );
  assert.deepEqual(idempotencyKeyMintsMedia(field), []);
  // Photo and signature both upload under checklist_evidence, from the field
  // or the card (the card owns the answer payload).
  const requests = [...uploadRequests(field), ...uploadRequests(card)].filter(
    (request) => literalOf(request, "sourceKind") === "checklist_evidence",
  );
  assert.ok(
    requests.length >= 1,
    "signature upload is tagged checklist_evidence",
  );
  assert.ok(
    card.getText().includes("signatureMediaId"),
    "answer still carries signatureMediaId",
  );
});
