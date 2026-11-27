// O5 follow-up (Keputusan CTO 27 Nov, point 6 b and c): what the close shift
// screen does on a tablet that cannot reach the cloud. The blind count is
// written to the cloud (strict money rule), so it waits for the internet;
// the screen says so and holds the action instead of failing to load.
// Pure: the screen feeds it the connection, the shift read and the local kit.
import { ApiError } from "@/lib/api/errors";

export type CloseScreenMode = "normal" | "needs_internet";

/** The client's own network failure, or a fetch that never got an answer. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof ApiError)
    return error.status === 0 && error.code === "NETWORK_ERROR";
  return error instanceof TypeError;
}

/**
 * "needs_internet" when the API is unreachable, or when the shift read failed
 * at the network and the tablet still holds the offline kit of an open shift
 * (the last shift status stored here). Any other failure stays a normal error
 * of the screen.
 */
export function closeScreenMode(input: {
  online: boolean;
  shiftError: unknown;
  kit: { shiftId: string } | null;
}): CloseScreenMode {
  if (!input.online) return "needs_internet";
  if (input.kit !== null && isNetworkFailure(input.shiftError))
    return "needs_internet";
  return "normal";
}
