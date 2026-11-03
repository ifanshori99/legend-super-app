// Saving an integration without letting a secret reach the client caches
// (PAY-06). The sender receives the credentials from the one-shot buffer at the
// moment of the request; what is written to the query cache is the API answer,
// which carries a secret reference and field names only (never values).
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { TenantIntegration } from "@starter/shared/platform";
import type { SecretBuffer } from "./secret-buffer.ts";

export type IntegrationList = { data: TenantIntegration[] };

/** What the mutation carries: public fields plus the (empty-looking) buffer. */
export type SaveIntegrationVariables<Input> = {
  /** Request body WITHOUT credentials. */
  input: Input;
  secrets: SecretBuffer;
};

/** Replaces or inserts the saved row in the cached list. */
export function mergeSavedIntegration(
  current: IntegrationList | undefined,
  saved: TenantIntegration,
): IntegrationList | undefined {
  if (!current) return current;
  const exists = current.data.some((row) => row.id === saved.id);
  return {
    ...current,
    data: exists
      ? current.data.map((row) => (row.id === saved.id ? saved : row))
      : [...current.data, saved],
  };
}

/**
 * The function a mutation runs. `send` gets the body with credentials joined
 * in; nothing returned or cached contains them.
 */
export async function runSaveIntegration<Input extends object>(
  client: QueryClient,
  listKey: QueryKey,
  send: (body: Input) => Promise<{ data: TenantIntegration }>,
  variables: SaveIntegrationVariables<Input>,
): Promise<TenantIntegration> {
  const secrets = variables.secrets.take();
  const body = secrets
    ? ({ ...variables.input, credentials: secrets } as Input)
    : variables.input;
  const response = await send(body);
  client.setQueryData<IntegrationList>(listKey, (current) =>
    mergeSavedIntegration(current, response.data),
  );
  return response.data;
}
