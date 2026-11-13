// One typed caller per accounting endpoint the back office uses (docs/frontend.md
// "Typed endpoints and mock mode"). Responses are unwrapped from their `{ data }`
// envelope so components and query options never see it. Components never call
// these directly: they use the hooks in ./hooks.ts, which own cache keys and
// invalidation.
//
// The legal-entity picker reads the organisation contract
// (`@starter/shared/platform`, GET /api/org/legal-entities): the accounting
// contract keys everything by `legalEntityId` but has no list endpoint of its
// own. Reported as a follow-up for the finance API.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  approveManualJournal as approveManualJournalEndpoint,
  cancelManualJournal as cancelManualJournalEndpoint,
  createAccount as createAccountEndpoint,
  createManualJournal as createManualJournalEndpoint,
  createRecurringJournal as createRecurringJournalEndpoint,
  getJournal as getJournalEndpoint,
  getManualJournal as getManualJournalEndpoint,
  listAccounts as listAccountsEndpoint,
  listFiscalPeriods as listFiscalPeriodsEndpoint,
  listJournals as listJournalsEndpoint,
  listManualJournals as listManualJournalsEndpoint,
  listRecurringJournals as listRecurringJournalsEndpoint,
  rejectManualJournal as rejectManualJournalEndpoint,
  reverseJournal as reverseJournalEndpoint,
  submitManualJournal as submitManualJournalEndpoint,
  transitionRecurringJournalEndpoint,
  updateAccount as updateAccountEndpoint,
  updateManualJournal as updateManualJournalEndpoint,
  withdrawManualJournal as withdrawManualJournalEndpoint,
} from "@starter/shared/accounting";
import { orgEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Legal entities (organisation contract) --------------------------------

export async function fetchLegalEntities(signal?: AbortSignal) {
  const response = await callEndpoint(
    orgEndpoints.listLegalEntities,
    {},
    { signal },
  );
  return response.data;
}

/** Outlet names for the journal line's per-outlet attribution (ACC-03). */
export async function fetchOutlets(signal?: AbortSignal) {
  const page = await callEndpoint(
    orgEndpoints.listOutlets,
    { query: { limit: 50 } },
    { signal },
  );
  return page.data;
}

// ---- Chart of accounts -----------------------------------------------------

export async function fetchAccounts(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listAccountsEndpoint,
    { params: { legalEntityId } as Params<typeof listAccountsEndpoint> },
    { signal },
  );
  return response.data;
}

export async function createAccount(
  legalEntityId: string,
  body: Body<typeof createAccountEndpoint>,
) {
  const response = await callEndpoint(createAccountEndpoint, {
    params: { legalEntityId } as Params<typeof createAccountEndpoint>,
    body,
  });
  return response.data;
}

export async function updateAccount(
  accountId: string,
  body: Body<typeof updateAccountEndpoint>,
) {
  const response = await callEndpoint(updateAccountEndpoint, {
    params: { accountId } as Params<typeof updateAccountEndpoint>,
    body,
  });
  return response.data;
}

/** Open/closed months of one legal entity (ACC-02 posting guard, form hint). */
export async function fetchFiscalPeriods(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listFiscalPeriodsEndpoint,
    { params: { legalEntityId } as Params<typeof listFiscalPeriodsEndpoint> },
    { signal },
  );
  return response.data;
}

// ---- Posted journals -------------------------------------------------------

export async function fetchJournals(
  query: Query<typeof listJournalsEndpoint>,
  signal?: AbortSignal,
) {
  return callEndpoint(listJournalsEndpoint, { query }, { signal });
}

export async function fetchJournal(
  journalEntryId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getJournalEndpoint,
    { params: { journalEntryId } as Params<typeof getJournalEndpoint> },
    { signal },
  );
  return response.data;
}

export async function reverseJournal(
  journalEntryId: string,
  body: Omit<Body<typeof reverseJournalEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(reverseJournalEndpoint, {
    params: { journalEntryId } as Params<typeof reverseJournalEndpoint>,
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

// ---- Manual journals -------------------------------------------------------

export async function fetchManualJournals(
  query: Query<typeof listManualJournalsEndpoint>,
  signal?: AbortSignal,
) {
  return callEndpoint(listManualJournalsEndpoint, { query }, { signal });
}

export async function fetchManualJournal(
  manualJournalId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getManualJournalEndpoint,
    { params: { manualJournalId } as Params<typeof getManualJournalEndpoint> },
    { signal },
  );
  return response.data;
}

export async function createManualJournal(
  body: Omit<Body<typeof createManualJournalEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(createManualJournalEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function updateManualJournal(
  manualJournalId: string,
  body: Body<typeof updateManualJournalEndpoint>,
) {
  const response = await callEndpoint(updateManualJournalEndpoint, {
    params: {
      manualJournalId,
    } as Params<typeof updateManualJournalEndpoint>,
    body,
  });
  return response.data;
}

export type ManualJournalCommand =
  "submit" | "withdraw" | "approve" | "cancel" | "reject";

/**
 * State-machine commands. Approve/reject need a different person than the
 * requester (AUTH-06); the API enforces it and the mock does the same.
 */
export async function runManualJournalCommand(
  command: ManualJournalCommand,
  manualJournalId: string,
  options: { reason?: string } = {},
): Promise<import("@starter/shared/accounting").ManualJournal> {
  const params = { manualJournalId };
  switch (command) {
    case "submit":
      return (
        await callEndpoint(submitManualJournalEndpoint, {
          params,
          body: { idempotencyKey: createUlid() },
        })
      ).data;
    case "withdraw":
      return (
        await callEndpoint(withdrawManualJournalEndpoint, {
          params,
          body: { idempotencyKey: createUlid() },
        })
      ).data;
    case "approve":
      return (
        await callEndpoint(approveManualJournalEndpoint, {
          params,
          body: { idempotencyKey: createUlid() },
        })
      ).data;
    case "cancel":
      return (
        await callEndpoint(cancelManualJournalEndpoint, {
          params,
          body: { idempotencyKey: createUlid() },
        })
      ).data;
    case "reject":
      return (
        await callEndpoint(rejectManualJournalEndpoint, {
          params,
          body: { reason: options.reason?.trim() ?? "" },
        })
      ).data;
  }
}

/** The draft was saved but the submit step failed: the draft id survives. */
export class SubmitAfterSaveError extends Error {
  constructor(
    readonly journal: import("@starter/shared/accounting").ManualJournal,
    readonly cause: unknown,
  ) {
    super("Draft saved, submit for approval failed");
  }
}

/**
 * "Ajukan untuk persetujuan" from the form: save the draft (create, or update
 * when `journalId` is set), then submit it. Both steps are the existing
 * endpoints; approval stays with a different person (AUTH-06). A failed submit
 * leaves the saved draft and reports it as SubmitAfterSaveError.
 */
export async function saveAndSubmitManualJournal(
  input:
    | {
        journalId?: undefined;
        body: Omit<Body<typeof createManualJournalEndpoint>, "idempotencyKey">;
      }
    | {
        journalId: string;
        body: Body<typeof updateManualJournalEndpoint>;
      },
) {
  const saved =
    input.journalId === undefined
      ? await createManualJournal(input.body)
      : await updateManualJournal(input.journalId, input.body);
  try {
    return await runManualJournalCommand("submit", saved.id);
  } catch (error) {
    throw new SubmitAfterSaveError(saved, error);
  }
}

// ---- Recurring journals ----------------------------------------------------

export async function fetchRecurringJournals(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listRecurringJournalsEndpoint,
    {
      query: {
        legalEntityId,
      } as Query<typeof listRecurringJournalsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function createRecurringJournal(
  body: Omit<Body<typeof createRecurringJournalEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(createRecurringJournalEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function transitionRecurringJournal(
  recurringJournalId: string,
  body: Body<typeof transitionRecurringJournalEndpoint>,
) {
  const response = await callEndpoint(transitionRecurringJournalEndpoint, {
    params: {
      recurringJournalId,
    } as Params<typeof transitionRecurringJournalEndpoint>,
    body,
  });
  return response.data;
}
