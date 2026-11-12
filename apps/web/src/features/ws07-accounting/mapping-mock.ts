// Mock handlers of the account-role mapping screen (`VITE_API_MOCK=true`,
// legend-fzvh). Picked up by the `features/*/*-mock.ts` glob. The PUT runs the
// contract's `accountMappingIssues` against the mock chart, like the API will.
//
// Loaded in Node by tests, so imports are bare packages or relative `.ts`.
import {
  accountMappingIssues,
  cafeLegendAccountingFixtures,
  listAccountMappings,
  replaceAccountMappings,
  type AccountMapping,
} from "@starter/shared/accounting";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const fixtures = cafeLegendAccountingFixtures;

const state = createMockStore<{ mappings: AccountMapping[] }>(() => ({
  mappings: [...fixtures.accountMappings],
}));

registerMock(listAccountMappings, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  return {
    data: state
      .get()
      .mappings.filter((row) => row.legalEntityId === params.legalEntityId),
  };
});

registerMock(replaceAccountMappings, ({ params, body }) => {
  const next: AccountMapping[] = body.mappings.map((row) => ({
    tenantId: fixtures.tenantId,
    legalEntityId: params.legalEntityId,
    role: row.role,
    accountId: row.accountId,
  })) as AccountMapping[];
  const issues = accountMappingIssues(
    next,
    fixtures.accounts.filter(
      (account) => account.legalEntityId === params.legalEntityId,
    ),
  );
  if (issues.length > 0)
    throw new ApiError(422, "VALIDATION_ERROR", issues.join("; "));
  state.set({
    mappings: [
      ...state
        .get()
        .mappings.filter((row) => row.legalEntityId !== params.legalEntityId),
      ...next,
    ],
  });
  return { data: next };
});
