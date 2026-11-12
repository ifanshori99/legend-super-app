// Query key and options for the AI guidelines page.
import { getAiGuidelines } from "@starter/shared/ai";
import { endpointQueryOptions } from "@/lib/api/endpoint";

// The page shows its error state instead of retrying silently; the
// ErrorState's "Coba lagi" is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export const aiGuidelinesQuery = () => ({
  ...endpointQueryOptions(getAiGuidelines),
  ...RETRY,
});
