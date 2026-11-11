// The claim token of one paid split part (legend-wwyyk). The server hands it
// out once, so the client keeps it in sessionStorage per session + part: the
// guest can leave for /masuk and come back to "Lanjut ke akun" without asking
// again. Pure over an injected Storage so Node tests can run it.

const PREFIX = "legend-qr-split-claim:";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StoredSplitClaim = { claimToken: string; claimableUntil: string };

const keyOf = (sessionId: string, splitId: string) =>
  `${PREFIX}${sessionId}:${splitId}`;

export function readSplitClaim(
  storage: StorageLike,
  sessionId: string,
  splitId: string,
): StoredSplitClaim | null {
  const raw = storage.getItem(keyOf(sessionId, splitId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSplitClaim> | null;
    return typeof value?.claimToken === "string" &&
      value.claimToken !== "" &&
      typeof value.claimableUntil === "string"
      ? { claimToken: value.claimToken, claimableUntil: value.claimableUntil }
      : null;
  } catch {
    return null;
  }
}

export function writeSplitClaim(
  storage: StorageLike,
  sessionId: string,
  splitId: string,
  claim: StoredSplitClaim,
): void {
  storage.setItem(keyOf(sessionId, splitId), JSON.stringify(claim));
}

export function clearSplitClaim(
  storage: StorageLike,
  sessionId: string,
  splitId: string,
): void {
  storage.removeItem(keyOf(sessionId, splitId));
}
