// WS-01 sign-in return path (bead legend-qhh5): a captive Wi-Fi portal (or a
// payment link) hands a guest to /masuk with `?redirect=<this app's path>` and
// expects the same path back after the WhatsApp sign-in. `lanjut` is the older
// name for the same field; both go through one validator, so neither can leave
// the app.
//
// Loaded with plain Node ESM and type stripping like the other root suites.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  safeReturnPath,
  signInPath,
  signInReturnPath,
  signInSearch,
} from "../apps/web/src/features/ws01-login/flow.ts";

const PORTAL =
  "/wifi?zone=00000000-0000-4000-8000-000000009401&facility=00000000-0000-4000-8000-000000009002&table=st_01JC0QRD4M5N6P7Q8R9S0T1V2W";
const BILL = "/bayar/2f5c0b0e-1c58-4a0a-9a2c-2b0b1f9a3d10";
const MEMBER = "/member?tab=points#history";

describe("legend-qhh5: app-local return path for sign-in", () => {
  test("legend-qhh5: ?redirect= accepts the same app-local paths as ?lanjut=", () => {
    for (const path of ["/", "/wifi", PORTAL, BILL, MEMBER]) {
      assert.equal(safeReturnPath(path), path, path);
      assert.deepEqual(signInSearch({ lanjut: path }), {
        lanjut: path,
        redirect: undefined,
      });
      assert.deepEqual(signInSearch({ redirect: path }), {
        lanjut: undefined,
        redirect: path,
      });
      assert.equal(signInReturnPath({ lanjut: path }), path);
      assert.equal(signInReturnPath({ redirect: path }), path);
    }
  });

  test("legend-qhh5: both names refuse external, protocol-relative and backslash forms", () => {
    const refused = [
      "//evil.example",
      "///evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/ /evil.example",
      "wifi?zone=x",
      "?redirect=/wifi",
      "#/wifi",
      "*",
      "",
    ];
    for (const value of refused) {
      assert.equal(safeReturnPath(value), undefined, JSON.stringify(value));
      assert.equal(
        signInReturnPath({ redirect: value }),
        undefined,
        JSON.stringify(value),
      );
      assert.equal(
        signInReturnPath({ lanjut: value }),
        undefined,
        JSON.stringify(value),
      );
      assert.deepEqual(
        signInSearch({ lanjut: value, redirect: value }),
        { lanjut: undefined, redirect: undefined },
        JSON.stringify(value),
      );
    }
  });

  test("legend-qhh5: arrays, objects and other non-strings never become a path", () => {
    const search = {
      lanjut: ["/member", "//evil.example"],
      redirect: { href: "//evil.example" },
    };
    assert.deepEqual(signInSearch(search), {
      lanjut: undefined,
      redirect: undefined,
    });
    assert.equal(signInReturnPath(search), undefined);
    assert.equal(signInReturnPath({ redirect: 42 }), undefined);
    assert.equal(signInReturnPath({ redirect: null }), undefined);
  });

  test("legend-qhh5: ?redirect= wins over ?lanjut=, and an unsafe alias falls back", () => {
    assert.equal(
      signInReturnPath({ lanjut: "/member", redirect: PORTAL }),
      PORTAL,
    );
    assert.equal(
      signInReturnPath({ lanjut: "/member", redirect: "https://evil.example" }),
      "/member",
      "an ignored redirect must not shadow the valid old parameter",
    );
    assert.equal(
      signInReturnPath({ lanjut: "//evil.example", redirect: PORTAL }),
      PORTAL,
    );
    assert.equal(signInReturnPath({}), undefined);
  });

  test("legend-qhh5: signInPath emits either name and drops an unsafe path", () => {
    assert.equal(
      signInPath(PORTAL),
      `/masuk?lanjut=${encodeURIComponent(PORTAL)}`,
    );
    assert.equal(
      signInPath(PORTAL, "redirect"),
      `/masuk?redirect=${encodeURIComponent(PORTAL)}`,
    );
    assert.equal(signInPath("https://evil.example", "redirect"), "/masuk");
    assert.equal(signInPath(undefined, "redirect"), "/masuk");
    assert.equal(signInPath(null), "/masuk");
  });

  test("legend-qhh5: the built sign-in URL round-trips the portal path through the search validator", () => {
    const url = new URL(signInPath(PORTAL, "redirect"), "https://legend.test");
    assert.equal(url.pathname, "/masuk");
    assert.equal(url.searchParams.get("redirect"), PORTAL);

    const search = signInSearch(Object.fromEntries(url.searchParams.entries()));
    assert.equal(signInReturnPath(search), PORTAL);
  });

  test("legend-qhh5 review: encoded separators, control chars, dot segments and API paths are refused", () => {
    const refused = [
      "/%2F%2Fevil.example",
      "/%2f%2fevil.example",
      "/%5Cevil.example",
      "/%5cevil.example",
      "/%2F/evil.example",
      "/wifi%2F..%2F..%2Fapi",
      "/\u0000/evil.example",
      "/\u0001evil",
      "/\u007fevil",
      "/ /evil.example",
      "/ /evil.example",
      "/﻿/evil.example",
      "/%09/evil.example",
      "/%0a/evil.example",
      "/%20/evil.example",
      "/%E0%A4%A",
      "/api",
      "/api/auth/sign-out",
      "/API/auth/callback",
      "/auth/callback",
      "/wifi/../api/org/outlets",
      "/./api/x",
      "/%2e%2e/api/x",
      "/x/%2e%2e/api/x",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " /wifi",
      "/wifi ",
    ];
    for (const value of refused) {
      assert.equal(safeReturnPath(value), undefined, JSON.stringify(value));
      assert.equal(
        signInReturnPath({ redirect: value }),
        undefined,
        JSON.stringify(value),
      );
      assert.equal(signInPath(value, "redirect"), "/masuk");
    }
    // An encoded value inside the query is data, not a separator.
    for (const value of [
      "/wifi?next=%2Fmenu",
      "/member?q=nasi%20goreng",
      "/apiary",
      "/authors",
    ]) {
      assert.equal(safeReturnPath(value), value, value);
    }
  });

  test("legend-qhh5: percent-encoded protocol-relative values are decoded before the check", () => {
    const url = new URL(
      "/masuk?redirect=%2F%2Fevil.example",
      "https://legend.test",
    );
    const search = signInSearch(Object.fromEntries(url.searchParams.entries()));
    assert.equal(search.redirect, undefined);
    assert.equal(signInReturnPath(search), undefined);
  });
});
