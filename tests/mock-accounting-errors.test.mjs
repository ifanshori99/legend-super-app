// legend-3het: every accounting mock uses the runtime domain mapper, including
// async handlers and handlers registered without a feature-specific wrapper.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { defineEndpoint } from "../packages/shared/src/api/index.ts";
import {
  ACCOUNTING_ERROR_CODES,
  AccountingError,
  accountingErrorHttpStatus,
} from "../packages/shared/src/accounting/index.ts";
import { CoreError } from "../packages/shared/src/core/index.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { clearMocks, registerMock } from "../apps/web/src/lib/mock/registry.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

afterEach(() => {
  clearMocks();
  resetMocks();
});

for (const mode of ["sync", "async"]) {
  test(`legend-3het ${mode} AccountingError preserves every native code, status and message`, async () => {
    for (const code of ACCOUNTING_ERROR_CODES) {
      const endpoint = defineEndpoint({
        method: "POST",
        path: `/api/legend-3het/${mode}/${code}`,
      });
      const original = new AccountingError(code, `Penolakan ${code}.`);
      registerMock(
        endpoint,
        mode === "sync"
          ? () => {
              throw original;
            }
          : () => Promise.reject(original),
      );
      await assert.rejects(
        dispatchMock({ method: endpoint.method, path: endpoint.path }),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, code);
          assert.equal(error.status, accountingErrorHttpStatus[code]);
          assert.equal(error.message, original.message);
          return true;
        },
      );
    }
  });
}

test("legend-3het core and API errors keep their existing mapping", async () => {
  const errors = [
    new CoreError("OUTLET_OUT_OF_SCOPE", "Di luar outlet."),
    new ApiError(409, "CONFLICT", "Sudah berubah."),
  ];
  for (const [index, original] of errors.entries()) {
    const endpoint = defineEndpoint({
      method: "GET",
      path: `/api/legend-3het/existing/${index}`,
    });
    registerMock(endpoint, () => {
      throw original;
    });
    await assert.rejects(
      dispatchMock({ method: endpoint.method, path: endpoint.path }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, original.status);
        assert.equal(error.code, original.code);
        assert.equal(error.message, original.message);
        if (original instanceof ApiError) assert.equal(error, original);
        return true;
      },
    );
  }
});

test("legend-3het arbitrary errors cannot expose a forged domain code or message", async (t) => {
  t.mock.method(console, "error", () => {});
  const endpoint = defineEndpoint({
    method: "GET",
    path: "/api/legend-3het/unexpected",
  });
  registerMock(endpoint, () => {
    throw Object.assign(new Error("Private implementation detail"), {
      code: "PERIOD_CLOSED",
      status: 409,
    });
  });
  await assert.rejects(
    dispatchMock({ method: endpoint.method, path: endpoint.path }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.code, "INTERNAL_ERROR");
      assert.equal(error.message, "Terjadi kesalahan pada mock handler.");
      return true;
    },
  );
});
