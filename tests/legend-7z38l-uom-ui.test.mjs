// Pure logic of the unit editor (bead legend-7z38l): form validation, the API
// error mapping and the row/list state. Loads the TypeScript module directly
// with native Node type stripping, like payslip-pin-ui.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { STANDARD_UOM_CATALOG } from "../packages/shared/src/inventory/standard-uoms.ts";
import {
  RESERVED_UOM_CODES,
  UOM_COPY,
  canRenameUom,
  isReservedUomCode,
  mapUomSaveError,
  normalizeUomCode,
  uomListState,
  validateUomCode,
  validateUomForm,
  validateUomName,
} from "../apps/web/src/features/ws06-inventory/uom-state.ts";

const existing = [{ code: "kg" }, { code: "ktn" }];

describe("reserved codes", () => {
  test("match the standard catalog the API rejects", () => {
    assert.deepEqual(
      [...RESERVED_UOM_CODES].sort(),
      STANDARD_UOM_CATALOG.map((unit) => unit.code).sort(),
    );
  });

  test("are matched after trim and lowercase", () => {
    assert.equal(isReservedUomCode("  KG "), true);
    assert.equal(isReservedUomCode("ktn"), false);
    assert.equal(normalizeUomCode(" Dus "), "dus");
  });
});

describe("name validation", () => {
  test("empty or blank name asks for a name", () => {
    assert.equal(validateUomName(""), UOM_COPY.errors.nameRequired);
    assert.equal(validateUomName("   "), UOM_COPY.errors.nameRequired);
  });

  test("accepts up to 150 characters, rejects 151", () => {
    assert.equal(validateUomName("a".repeat(150)), undefined);
    assert.equal(validateUomName("a".repeat(151)), UOM_COPY.errors.nameTooLong);
  });
});

describe("code validation", () => {
  test("accepts 1-10 letters or digits, any case", () => {
    assert.equal(validateUomCode("dus", existing), undefined);
    assert.equal(validateUomCode("A1", existing), undefined);
    assert.equal(validateUomCode("abcdefghij", existing), undefined);
  });

  test("rejects empty, spaces, symbols and 11 characters", () => {
    for (const bad of ["", "  ", "a b", "a-b", "abcdefghijk", "sa tu"])
      assert.equal(validateUomCode(bad, existing), UOM_COPY.errors.codeInvalid);
  });

  test("reserved code is rejected before the taken check", () => {
    assert.equal(validateUomCode("kg", existing), UOM_COPY.errors.codeReserved);
    assert.equal(validateUomCode("KG", []), UOM_COPY.errors.codeReserved);
  });

  test("a code the tenant already uses is rejected", () => {
    assert.equal(validateUomCode("ktn", existing), UOM_COPY.errors.codeTaken);
    assert.equal(validateUomCode(" KTN ", existing), UOM_COPY.errors.codeTaken);
  });
});

describe("form validation", () => {
  test("create returns trimmed name and normalized code", () => {
    assert.deepEqual(
      validateUomForm(
        { mode: "create", name: "  Dus besar ", code: " DUS " },
        existing,
      ),
      { ok: true, name: "Dus besar", code: "dus" },
    );
  });

  test("create reports every field error at once", () => {
    const result = validateUomForm(
      { mode: "create", name: "", code: "" },
      existing,
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors.name, UOM_COPY.errors.nameRequired);
    assert.equal(result.errors.code, UOM_COPY.errors.codeInvalid);
  });

  test("edit validates the name only and sends no code", () => {
    assert.deepEqual(
      validateUomForm({ mode: "edit", name: " Karton besar " }, existing),
      { ok: true, name: "Karton besar" },
    );
    const blank = validateUomForm({ mode: "edit", name: " " }, existing);
    assert.equal(blank.ok, false);
    assert.deepEqual(blank.errors, { name: UOM_COPY.errors.nameRequired });
  });
});

describe("API error mapping", () => {
  test("409 reserved message maps to the reserved copy on the code field", () => {
    const error = new ApiError(
      409,
      "CONFLICT",
      "That code is reserved for a standard unit.",
    );
    assert.deepEqual(mapUomSaveError(error), {
      field: "code",
      message: UOM_COPY.errors.codeReserved,
    });
  });

  test("other 409 maps to the taken copy on the code field", () => {
    const error = new ApiError(
      409,
      "CONFLICT",
      "This tenant already has a unit with that code.",
    );
    assert.deepEqual(mapUomSaveError(error), {
      field: "code",
      message: UOM_COPY.errors.codeTaken,
    });
  });

  test("400 with a field detail lands on that field", () => {
    const code = new ApiError(400, "VALIDATION_ERROR", "x", [
      { field: "code", message: "x" },
    ]);
    assert.deepEqual(mapUomSaveError(code), {
      field: "code",
      message: UOM_COPY.errors.codeInvalid,
    });
    const name = new ApiError(400, "VALIDATION_ERROR", "x", [
      { field: "name", message: "x" },
    ]);
    assert.equal(mapUomSaveError(name).field, "name");
    assert.equal(
      mapUomSaveError(new ApiError(400, "VALIDATION_ERROR", "x")).field,
      "form",
    );
  });

  test("403, 404, network and unknown errors stay on the form", () => {
    assert.deepEqual(mapUomSaveError(new ApiError(403, "FORBIDDEN", "x")), {
      field: "form",
      message: UOM_COPY.errors.forbidden,
    });
    assert.equal(
      mapUomSaveError(new ApiError(404, "NOT_FOUND", "x")).message,
      UOM_COPY.errors.notFound,
    );
    assert.equal(
      mapUomSaveError(new ApiError(0, "NETWORK_ERROR", "x")).message,
      UOM_COPY.errors.network,
    );
    assert.equal(
      mapUomSaveError(new ApiError(500, "INTERNAL", "x")).message,
      UOM_COPY.errors.unknown,
    );
    assert.equal(mapUomSaveError(undefined).message, UOM_COPY.errors.unknown);
  });
});

describe("list and row state", () => {
  test("loading wins, then error, then empty, then ready", () => {
    assert.equal(
      uomListState({ isPending: true, isError: true, count: 0 }),
      "loading",
    );
    assert.equal(
      uomListState({ isPending: false, isError: true, count: 3 }),
      "error",
    );
    assert.equal(
      uomListState({ isPending: false, isError: false, count: 0 }),
      "empty",
    );
    assert.equal(
      uomListState({ isPending: false, isError: false, count: 3 }),
      "ready",
    );
  });

  test("only tenant units can be renamed; standard units are locked", () => {
    assert.equal(canRenameUom({ isSystem: true }), false);
    assert.equal(canRenameUom({ isSystem: false }), true);
  });
});
