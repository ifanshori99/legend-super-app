import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

// Exercise the real screen callbacks. React scheduling and unrelated queries
// are controlled so failure assertions can inspect state without a browser.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const state = {
  values: [],
  cursor: 0,
  bindings: {},
  uploads: [],
  normalized: [],
};
globalThis.__mediaScreensTest = state;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true },
});
const stub = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const react = `
const h=globalThis.__mediaScreensTest;
export const useState=(initial,name)=>{if(name in (h.initial??{}))initial=h.initial[name];const i=h.cursor++;if(!(i in h.values))h.values[i]=typeof initial==="function"?initial():initial;return [h.values[i],value=>{h.values[i]=typeof value==="function"?value(h.values[i]):value}];};
export const useRef=(initial)=>{const i=h.cursor++;return h.values[i]??=( {current:initial} );};
export const useMemo=(fn)=>fn();export const useCallback=(fn)=>fn;
export const useEffect=()=>{};export const useId=()=>"photo-input";
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react") return { url: stub(react), shortCircuit: true };
    if (specifier === "react/jsx-runtime")
      return {
        url: stub(
          'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment=Symbol.for("fragment");',
        ),
        shortCircuit: true,
      };
    if (context.parentURL?.startsWith(webRoot.href)) {
      const source = readFileSync(new URL(context.parentURL), "utf8");
      const ast = ts.createSourceFile(
        context.parentURL,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const names = [];
      for (const node of ast.statements) {
        if (
          !ts.isImportDeclaration(node) ||
          node.moduleSpecifier.text !== specifier ||
          node.importClause?.isTypeOnly
        )
          continue;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements)
            if (!item.isTypeOnly)
              names.push(item.propertyName?.text ?? item.name.text);
      }
      return {
        url: stub(
          names
            .map(
              (name) =>
                `export const ${name}=globalThis.__mediaScreensTest.bindings[${JSON.stringify(name)}]??${JSON.stringify(name)};`,
            )
            .join("\n"),
        ),
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(webRoot.href) && url.endsWith(".tsx")) {
      let source = readFileSync(new URL(url), "utf8");
      if (url.endsWith("receiving-form-page.tsx"))
        source += "\nexport { ReceivingFormContent };";
      if (url.endsWith("petty-page.tsx"))
        source += "\nexport { PettyFormDialog };";
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
          },
          transformers: {
            before: [
              (context) => (root) =>
                ts.visitNode(root, function visit(node) {
                  if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.expression.getText() === "React" &&
                    node.expression.name.text === "useState" &&
                    ts.isVariableDeclaration(node.parent) &&
                    ts.isArrayBindingPattern(node.parent.name)
                  ) {
                    return ts.factory.updateCallExpression(
                      node,
                      node.expression,
                      node.typeArguments,
                      [
                        node.arguments[0] ??
                          ts.factory.createIdentifier("undefined"),
                        ts.factory.createStringLiteral(
                          node.parent.name.elements[0].name.getText(),
                        ),
                      ],
                    );
                  }
                  return ts.visitEachChild(node, visit, context);
                }),
            ],
          },
        }).outputText,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
const outletId = "00000000-0000-4000-8000-000000000002";
const objectId = "00000000-0000-4000-8000-000000000003";
const query = (rows = []) => ({
  data: { data: rows },
  isPending: false,
  isError: false,
});
const upload = async (input) => {
  state.uploads.push(input);
  if (state.failure) throw state.failure;
  if (state.deferred) return state.deferred;
  return { id: objectId };
};
Object.assign(state.bindings, {
  useT: () => (key) => key,
  useToast: () => () => {},
  useTenantContext: () => ({ outlet: { id: outletId } }),
  useNavigate: () => () => {},
  useAttemptKey: () => ({ keyFor: () => "attempt", settle: () => {} }),
  useCreateGoodsReceipt: () => ({
    isPending: false,
    mutate: (input) => state.mutations.push(input),
  }),
  useCreatePettyPurchase: () => ({
    isPending: false,
    mutate: (input) => state.mutations.push(input),
  }),
  useCreateWasteLog: () => ({
    isPending: false,
    mutate: (input) => state.mutations.push(input),
  }),
  useUploadStorageFile: () => ({ mutateAsync: upload, isPending: false }),
  uploadStorageFile: upload,
  normalizeImageFile: async (file) => {
    state.normalized.push(file);
    return new Blob(["normalized"], { type: "image/jpeg" });
  },
  useStorageObjectUrl: (id, variant) => {
    state.signed = { id, variant };
    return {
      url: id ? "https://storage.example.test/signed-photo" : undefined,
      onError: () => {
        state.renewed = true;
      },
    };
  },
  usePurchaseOrders: () => query([{ id: "order", status: "approved" }]),
  usePurchaseOrder: () =>
    query({
      purchaseOrder: {
        id: "order",
        lines: [],
        status: "approved",
        orderedOn: "2026-11-14",
      },
      lines: [
        {
          id: "line",
          inventoryItemId: "item",
          uomId: "unit",
          quantity: "10",
          unitCostIdr: "1000",
        },
      ],
    }),
  useReceiptLinesForOrder: () => ({ ...query([]), lines: [] }),
  useSuppliers: () => query([]),
  useInventoryItems: () => query([]),
  useStockLocations: () =>
    query([{ id: "location", name: "Warehouse", isActive: true }]),
  useUoms: () => query([]),
  useUnits: () => query([]),
  useMenuItems: () => query([]),
  todayBusinessDate: () => "2026-11-14",
  formatBusinessDate: () => "2026-11-14",
  formatIdrText: String,
  supplierNameOf: () => "Supplier",
  formatDecimal4: String,
  parseDecimal4: Number,
  goodsReceiptValueIdr: () => 0,
  remainingQuantity: () => "10",
  acceptedReceivedQuantity: () => "0",
  quantityFromInput: (value) => value || null,
  rejectedQuantityFromInput: (value) => value || "0",
  itemNameOf: () => "Item",
  isZeroPriceLine: (line) => Number(line.unitPriceIdr) === 0,
  bonusFlagOf: (line, isBonus) =>
    Number(line.unitPriceIdr) === 0 && isBonus ? { isBonus: true } : {},
  uomCodeOf: () => "kg",
  formatQuantityWithUnit: String,
  amountFromInput: (value) => (value ? Number(value) : null),
  WASTE_REASONS: [],
  wasteReasonKey: (value) => value,
  newIdempotencyKey: () => "fake-local-id",
  WASTE_PHOTO_MAX_BYTES: 5 * 1024 * 1024,
  WASTE_PHOTO_TYPES: ["image/jpeg", "image/png", "image/webp"],
  cn: (...values) => values.filter(Boolean).join(" "),
  ApiError,
  API_MOCK: true,
  photoUploadErrorKey: (error) =>
    error.status === 503
      ? "waste.form.photoUploadUnavailable"
      : "waste.form.photoUploadOffline",
});
const modules = await Promise.all([
  import("../apps/web/src/features/ws06-purchasing/components/receiving-form-page.tsx"),
  import("../apps/web/src/features/ws06-purchasing/components/petty-page.tsx"),
  import("../apps/web/src/features/ws06-inventory/components/waste-form-dialog.tsx"),
  import("../apps/web/src/features/ws06-inventory/components/photo-field.tsx"),
]);
const screens = [
  ["goods_receipt", modules[0].ReceivingFormContent, {}],
  [
    "petty_purchase",
    modules[1].PettyFormDialog,
    { limitIdr: 100000, todayTotal: 0, today: "2026-11-14", onClose: () => {} },
  ],
  [
    "waste_log",
    modules[2].WasteFormDialog,
    { open: true, onOpenChange: () => {} },
  ],
];
function find(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function render(component, props) {
  state.cursor = 0;
  return component(props);
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}
function reset() {
  state.values = [];
  state.initial = {
    vendor: "Vendor",
    description: "Description",
    amount: "5000",
    targetId: "item",
    quantity: "1",
    reason: "expired",
    drafts: {
      line: {
        received: "1",
        rejected: "0",
        reason: "",
        batchCode: "",
        expiresOn: "",
        locationId: "location",
      },
    },
  };
  state.uploads = [];
  state.normalized = [];
  state.failure = undefined;
  state.deferred = undefined;
  state.mutations = [];
  state.renewed = false;
}
// Legacy callbacks must complete too: the regression should fail because no
// upload happened, rather than because Node lacks FileReader.
globalThis.FileReader = class {
  readAsDataURL() {
    this.result = "data:image/png;base64,AA==";
    this.onload?.();
  }
};
for (const [kind, component, props] of screens) {
  test(`[legend-uaoli M3] ${kind} normalizes and uploads with its actual outlet and keeps only the returned id`, async () => {
    reset();
    const tree = render(component, props);
    const field = find(tree, (node) => node.type === "PhotoField");
    assert.ok(field, "photo control rendered");
    const file = new File(["camera"], "camera.png", { type: "image/png" });
    await field.props.onSelect(file);
    await settle();
    assert.equal(
      state.uploads.length,
      1,
      "selected photo must upload before creating a record",
    );
    assert.equal(state.normalized[0], file);
    assert.equal(
      state.uploads[0].purpose,
      kind === "goods_receipt" ? "goods_receipt_photo" : "receipt",
    );
    assert.equal(state.uploads[0].sourceKind, kind);
    assert.equal(state.uploads[0].outletId, outletId);
    assert.equal(await state.uploads[0].file.text(), "normalized");
    const updated = find(
      render(component, props),
      (node) => node.type === "PhotoField",
    );
    assert.equal(updated.props.mediaId, objectId);
    assert.equal(updated.props.previewUrl, undefined, "no persisted data URL");
    const savedTree = render(component, props);
    const button = find(
      savedTree,
      (node) =>
        node.type === "Button" &&
        String(node.props.children).includes(
          kind === "goods_receipt"
            ? "receiving.form.submit"
            : kind === "petty_purchase"
              ? "petty.submit"
              : "waste.form.submit",
        ),
    );
    if (button.props.onClick) button.props.onClick();
    else
      find(savedTree, (node) => node.type === "form").props.onSubmit({
        preventDefault() {},
      });
    assert.equal(state.mutations.length, 1, "otherwise valid form saves once");
    const payload = state.mutations[0];
    assert.equal(
      kind === "goods_receipt"
        ? payload.mediaIds[0]
        : kind === "petty_purchase"
          ? payload.photoMediaId
          : payload.mediaId,
      objectId,
      "save uses returned storage id",
    );
  });
  for (const failure of [
    new ApiError(503, "SCANNER_UNAVAILABLE", "Unavailable"),
    new ApiError(503, "STORAGE_UNAVAILABLE", "Unavailable"),
    new TypeError("offline"),
  ]) {
    test(`[legend-uaoli M3] ${kind} ${failure.code ?? "offline"} shows an error without a media id`, async () => {
      reset();
      state.failure = failure;
      const field = find(
        render(component, props),
        (node) => node.type === "PhotoField",
      );
      await field.props.onSelect(
        new File(["camera"], "camera.png", { type: "image/png" }),
      );
      await settle();
      assert.equal(state.uploads.length, 1);
      const updated = find(
        render(component, props),
        (node) => node.type === "PhotoField",
      );
      assert.ok(updated.props.error, "failure must be visible next to photo");
      assert.equal(updated.props.mediaId, null);
      assert.equal(typeof updated.props.onRetry, "function");
      const button = find(
        render(component, props),
        (node) =>
          node.type === "Button" &&
          String(node.props.children).includes(
            kind === "goods_receipt"
              ? "receiving.form.submit"
              : kind === "petty_purchase"
                ? "petty.submit"
                : "waste.form.submit",
          ),
      );
      assert.equal(
        button.props.disabled,
        true,
        "failed selected upload locks saving",
      );
      if (button.props.onClick) button.props.onClick();
      else
        find(
          render(component, props),
          (node) => node.type === "form",
        ).props.onSubmit({ preventDefault() {} });
      assert.equal(state.mutations.length, 0);
      state.failure = undefined;
      await updated.props.onRetry();
      await settle();
      assert.equal(
        state.uploads.length,
        2,
        "retry uploads the same chosen file",
      );
      assert.equal(
        find(render(component, props), (node) => node.type === "PhotoField")
          .props.mediaId,
        objectId,
      );
    });
  }
}

for (const [kind, component, props] of screens) {
  test(`[legend-uaoli M3] ${kind} normalizes large camera files before applying the output limit`, async () => {
    reset();
    const file = new File([new Uint8Array(6 * 1024 * 1024)], "camera.heic", {
      type: "image/heic",
    });
    const field = find(
      render(component, props),
      (node) => node.type === "PhotoField",
    );
    await field.props.onSelect(file);
    await settle();
    assert.equal(state.normalized[0], file);
    assert.equal(state.uploads.length, 1);
    assert.equal(state.uploads[0].file.type, "image/jpeg");
  });
  test(`[legend-uaoli M3] ${kind} pending upload locks saving and clearing ignores its late result`, async () => {
    reset();
    let resolveUpload;
    state.deferred = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    let field = find(
      render(component, props),
      (node) => node.type === "PhotoField",
    );
    void field.props.onSelect(
      new File(["camera"], "camera.png", { type: "image/png" }),
    );
    await settle();
    field = find(
      render(component, props),
      (node) => node.type === "PhotoField",
    );
    assert.equal(field.props.isUploading, true);
    const button = find(
      render(component, props),
      (node) =>
        node.type === "Button" &&
        String(node.props.children).includes(
          kind === "goods_receipt"
            ? "receiving.form.submit"
            : kind === "petty_purchase"
              ? "petty.submit"
              : "waste.form.submit",
        ),
    );
    assert.equal(button.props.disabled, true);
    if (button.props.onClick) button.props.onClick();
    else
      find(
        render(component, props),
        (node) => node.type === "form",
      ).props.onSubmit({ preventDefault() {} });
    assert.equal(state.mutations.length, 0);
    field.props.onClear();
    resolveUpload({ id: objectId });
    await settle();
    field = find(
      render(component, props),
      (node) => node.type === "PhotoField",
    );
    assert.equal(
      field.props.mediaId,
      null,
      "late upload must not restore a cleared photo",
    );
    assert.equal(field.props.isUploading, false);
  });
}

test("[legend-uaoli M3] PhotoField displays a signed thumbnail and renews failed image requests", () => {
  reset();
  const tree = render(modules[3].PhotoField, {
    mediaId: objectId,
    onSelect: () => {},
    onClear: () => {},
  });
  assert.ok(
    find(
      tree,
      (node) =>
        node.type === modules[3].StoragePhoto &&
        node.props.mediaId === objectId,
    ),
  );
  state.values = [];
  const image = find(
    render(modules[3].StoragePhoto, { mediaId: objectId }),
    (node) => node.type === "img",
  );
  assert.ok(image, "uploaded photo is visible");
  assert.equal(image.props.src, "https://storage.example.test/signed-photo");
  assert.deepEqual(state.signed, { id: objectId, variant: "thumbnail" });
  image.props.onError();
  assert.equal(state.renewed, true);
});

test("[legend-uaoli M3] petty purchase retains its amount cap after successful upload", async () => {
  reset();
  state.initial.amount = "100001";
  const [, component, props] = screens[1];
  let tree = render(component, props);
  await find(tree, (node) => node.type === "PhotoField").props.onSelect(
    new File(["camera"], "camera.png", { type: "image/png" }),
  );
  await settle();
  tree = render(component, props);
  const button = find(
    tree,
    (node) =>
      node.type === "Button" &&
      String(node.props.children).includes("petty.submit"),
  );
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  assert.equal(state.mutations.length, 0);
});
