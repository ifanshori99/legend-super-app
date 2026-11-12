// Account-role mapping screen logic (bead legend-fzvh, S6 of sub-539-u5a;
// mockup design/mockups/backoffice/account-role-mappings.html). Loads the pure
// module and the mock handlers with native Node type stripping; the screen
// itself is not rendered (the web app has no component test runner).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { POSTING_ACCOUNT_ROLES } from "../packages/shared/src/accounting/coa.ts";
import { cafeLegendAccountingFixtures as fixtures } from "../packages/shared/src/accounting/fixtures.ts";
import { messagesId } from "../packages/shared/src/i18n/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws07-accounting/mapping-mock.ts";
import {
  MAPPING_ROLES,
  SAVE_ERROR_KEYS,
  buildReplaceBody,
  draftFromMappings,
  draftIssues,
  eligibleAccounts,
  isDraftDirty,
  mappingCounts,
  mergeDraftOnto,
  mappingSaveError,
  mappingScreenState,
  parseContractIssue,
  parseContractIssues,
  roleIssue,
  roleLabelKey,
  roleTypeLabelKey,
} from "../apps/web/src/features/ws07-accounting/mapping-state.ts";

const entity = fixtures.legalEntity.id;
const accounts = fixtures.accounts.filter((a) => a.legalEntityId === entity);
const byCode = (code) => fixtures.accountByCode(code);
const message = (key) =>
  key.split(".").reduce((node, part) => node?.[part], messagesId);

afterEach(() => resetMocks());

describe("roles and catalog", () => {
  test("every posting role has a label, a type label and the screen copy exists", () => {
    assert.equal(MAPPING_ROLES.length, Object.keys(POSTING_ACCOUNT_ROLES).length);
    for (const role of MAPPING_ROLES) {
      assert.equal(typeof message(roleLabelKey(role)), "string", role);
      assert.equal(typeof message(roleTypeLabelKey(role)), "string", role);
    }
    for (const group of Object.values(SAVE_ERROR_KEYS)) {
      assert.equal(typeof message(group.title), "string");
      assert.equal(typeof message(group.hint), "string");
    }
    for (const issue of ["header", "inactive", "wrongType", "notFound", "duplicate"])
      assert.equal(typeof message(`accounting.mapping.issues.${issue}`), "string");
  });

  test("type label: fixed type, a list for flexible roles", () => {
    assert.equal(roleTypeLabelKey("cash_on_hand"), "accounting.mapping.types.asset");
    assert.equal(
      roleTypeLabelKey("service_charge"),
      "accounting.mapping.types.liabilityOrRevenue",
    );
    assert.equal(
      roleTypeLabelKey("payroll_custom_deduction"),
      "accounting.mapping.types.expenseOrLiability",
    );
  });
});

describe("draft", () => {
  test("fixture mapping is complete; counts and dirty flag follow the draft", () => {
    const saved = draftFromMappings(fixtures.accountMappings);
    const counts = mappingCounts(saved);
    assert.equal(counts.total, MAPPING_ROLES.length);
    assert.equal(counts.mapped + counts.missing, counts.total);
    assert.equal(isDraftDirty(saved, { ...saved }), false);
    const cleared = { ...saved, cash_on_hand: "" };
    assert.equal(isDraftDirty(saved, cleared), true);
    assert.equal(mappingCounts(cleared).missing, counts.missing + 1);
  });

  test("empty draft: nothing mapped, body has no rows", () => {
    assert.deepEqual(mappingCounts({}), {
      mapped: 0,
      total: MAPPING_ROLES.length,
      missing: MAPPING_ROLES.length,
    });
    assert.deepEqual(buildReplaceBody({}), { mappings: [] });
  });

  test("body drops cleared roles and keeps role/account pairs", () => {
    const body = buildReplaceBody({
      cash_on_hand: byCode("1101").id,
      petty_cash: "",
    });
    assert.deepEqual(body, {
      mappings: [{ role: "cash_on_hand", accountId: byCode("1101").id }],
    });
  });
});

describe("stale draft merge (S6 review: no overwrite of another admin's change)", () => {
  const cash = byCode("1101").id;
  const bankA = accounts.find((a) => a.type === "asset" && a.id !== cash).id;
  const bankB = accounts.find((a) => a.type === "asset" && a.id !== cash && a.id !== bankA).id;

  test("user edits role A, server changed role B: body has new B and user's A", () => {
    const baseline = { cash_on_hand: cash, petty_cash: cash };
    const draft = { ...baseline, cash_on_hand: bankA };
    const latest = { ...baseline, petty_cash: bankB };
    const merged = mergeDraftOnto(baseline, draft, latest);
    assert.deepEqual(merged, { cash_on_hand: bankA, petty_cash: bankB });
    assert.deepEqual(buildReplaceBody(merged).mappings.sort((a, b) => a.role.localeCompare(b.role)), [
      { role: "cash_on_hand", accountId: bankA },
      { role: "petty_cash", accountId: bankB },
    ]);
  });

  test("user's change wins on the same role; a cleared role stays cleared", () => {
    const baseline = { cash_on_hand: cash, petty_cash: cash };
    const draft = { cash_on_hand: bankA, petty_cash: "" };
    const latest = { cash_on_hand: bankB, petty_cash: bankB };
    assert.deepEqual(mergeDraftOnto(baseline, draft, latest), { cash_on_hand: bankA, petty_cash: "" });
  });

  test("untouched draft takes the latest as is, including roles added or removed", () => {
    const baseline = { cash_on_hand: cash };
    const latest = { petty_cash: bankB };
    assert.deepEqual(buildReplaceBody(mergeDraftOnto(baseline, { ...baseline }, latest)), {
      mappings: [{ role: "petty_cash", accountId: bankB }],
    });
  });
});

describe("eligible accounts and issues", () => {
  test("picker lists only active leaf accounts of the role's type, by code", () => {
    const list = eligibleAccounts("cash_on_hand", accounts);
    assert.ok(list.length > 0);
    const parentIds = new Set(accounts.flatMap((a) => (a.parentId ? [a.parentId] : [])));
    for (const account of list) {
      assert.equal(account.type, "asset");
      assert.equal(account.isActive, true);
      assert.equal(parentIds.has(account.id), false);
    }
    const codes = list.map((a) => a.code);
    assert.deepEqual(codes, [...codes].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  test("flexible role accepts either allowed type", () => {
    const types = new Set(eligibleAccounts("service_charge", accounts).map((a) => a.type));
    assert.ok(types.has("liability"));
    for (const type of types) assert.ok(["liability", "revenue"].includes(type));
  });

  test("fixture mapping has no issues", () => {
    assert.deepEqual(draftIssues(draftFromMappings(fixtures.accountMappings), accounts, entity), {});
  });

  test("wrong type, header, inactive, foreign and unknown accounts are flagged", () => {
    const header = accounts.find((a) => accounts.some((b) => b.parentId === a.id));
    assert.ok(header, "fixture chart has a header account");
    const expense = accounts.find((a) => a.type === "expense" && a.isActive);
    assert.equal(roleIssue("cash_on_hand", expense.id, accounts, entity), "wrongType");
    assert.equal(roleIssue(header.type === "asset" ? "cash_on_hand" : "sales_revenue", header.id, accounts, entity), "header");
    const inactive = { ...byCode("1101"), id: "01JBQ9A2B3C4D5E6F7G8H9AAAA", isActive: false, parentId: null };
    assert.equal(roleIssue("cash_on_hand", inactive.id, [...accounts, inactive], entity), "inactive");
    assert.equal(roleIssue("cash_on_hand", byCode("1101").id, accounts, "other-entity"), "notFound");
    assert.equal(roleIssue("cash_on_hand", "missing", accounts, entity), "notFound");
    assert.equal(roleIssue("cash_on_hand", "", accounts, entity), null);
  });
});

describe("contract issue text and API errors", () => {
  test("English accountMappingIssues strings map to a role and an issue", () => {
    assert.deepEqual(parseContractIssue("Role cash_on_hand mapped twice"), { role: "cash_on_hand", issue: "duplicate" });
    assert.deepEqual(parseContractIssue("Role bank: account not in this legal entity"), { role: "bank", issue: "notFound" });
    assert.deepEqual(parseContractIssue("Role bank: needs a asset account"), { role: "bank", issue: "wrongType" });
    assert.deepEqual(parseContractIssue("Role bank: header account is not postable"), { role: "bank", issue: "header" });
    assert.equal(parseContractIssue("Role nope: header account is not postable"), null);
    assert.equal(parseContractIssue("something else"), null);
  });

  test("a 422 message splits on ';' into one issue per row; unknown parts are skipped", () => {
    assert.deepEqual(
      parseContractIssues("Role bank: needs a asset account; Role cash_on_hand mapped twice; something else"),
      { bank: "wrongType", cash_on_hand: "duplicate" },
    );
    assert.deepEqual(parseContractIssues(""), {});
    assert.deepEqual(parseContractIssues(undefined), {});
  });

  test("save errors map to the banner kind", () => {
    assert.equal(mappingSaveError({ status: 422, code: "VALIDATION_ERROR" }), "invalid");
    assert.equal(mappingSaveError({ status: 409 }), "invalid");
    assert.equal(mappingSaveError({ status: 403 }), "forbidden");
    assert.equal(mappingSaveError({ status: 0, code: "NETWORK_ERROR" }), "network");
    assert.equal(mappingSaveError({ status: 500 }), "unknown");
    assert.equal(mappingSaveError(new Error("x")), "unknown");
    assert.equal(mappingSaveError(undefined), "unknown");
  });

  test("screen state: error beats loading beats ready", () => {
    const base = { mappingsPending: false, accountsPending: false, mappingsError: false, accountsError: false };
    assert.equal(mappingScreenState(base), "ready");
    assert.equal(mappingScreenState({ ...base, accountsPending: true }), "loading");
    assert.equal(mappingScreenState({ ...base, mappingsPending: true, accountsError: true }), "error");
  });
});

describe("mock endpoints (what the screen runs on in mock mode)", () => {
  const path = `/api/accounting/legal-entities/${entity}/account-mappings`;

  test("GET returns the fixture mapping", async () => {
    const response = await dispatchMock({ method: "GET", path });
    assert.equal(response.data.length, fixtures.accountMappings.length);
  });

  test("PUT replaces, GET reads it back; an invalid mapping is a 422", async () => {
    const ok = await dispatchMock({
      method: "PUT",
      path,
      body: { mappings: [{ role: "cash_on_hand", accountId: byCode("1101").id }] },
    });
    assert.equal(ok.data.length, 1);
    const back = await dispatchMock({ method: "GET", path });
    assert.equal(back.data.length, 1);
    const error = await dispatchMock({
      method: "PUT",
      path,
      body: { mappings: [{ role: "cash_on_hand", accountId: accounts.find((a) => a.type === "expense").id }] },
    }).then(() => assert.fail("expected 422"), (e) => e);
    assert.equal(error.status, 422);
    assert.equal(mappingSaveError(error), "invalid");
  });
});
