// Pure allocation of one POS named-item refund row across original order lines
// (bead 1169). No database. Decision (CTO, caps what is paid out): split by
// weight with BigInt largest remainder, clamp to each line's room, hand the
// leftover to other lines with room, and put any final residual on the
// heaviest line so the debits always add up to the refund amount.

/**
 * Split `amountIdr` over the lines in `weights`.
 * - Lines are processed by id ascending, so request order never matters.
 * - Largest remainder on BigInt weights; ties go to the lower id. All-zero
 *   weights fall back to equal weights.
 * - Each share is clamped to max(0, roomOf(id)); the clamped-off amount goes
 *   to other lines that still have room (id ascending), never above room.
 * - Whatever is still left (every line full) lands on the heaviest line
 *   (tie: lower id), so the sum of the result is always `amountIdr`.
 * `amountIdr <= 0` or no lines gives an empty map.
 */
export function allocateRefundRowIdr(
  amountIdr: number,
  weights: ReadonlyMap<string, bigint>,
  roomOf: (lineId: string) => number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!(amountIdr > 0) || weights.size === 0) return result;

  const ids = [...weights.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rawWeight = (id: string): bigint => weights.get(id) ?? 0n;
  const allZero = ids.every((id) => rawWeight(id) <= 0n);
  const weightOf = (id: string): bigint =>
    allZero ? 1n : rawWeight(id) > 0n ? rawWeight(id) : 0n;

  let total = 0n;
  for (const id of ids) total += weightOf(id);
  const amount = BigInt(amountIdr);

  // Step 2: largest remainder.
  const shares = new Map<string, number>();
  const remainders: { id: string; rem: bigint }[] = [];
  let assigned = 0n;
  for (const id of ids) {
    const num = amount * weightOf(id);
    const floor = num / total;
    shares.set(id, Number(floor));
    assigned += floor;
    remainders.push({ id, rem: num % total });
  }
  let extra = Number(amount - assigned);
  remainders.sort((a, b) =>
    a.rem === b.rem ? (a.id < b.id ? -1 : 1) : a.rem > b.rem ? -1 : 1,
  );
  for (const { id } of remainders) {
    if (extra <= 0) break;
    shares.set(id, (shares.get(id) ?? 0) + 1);
    extra -= 1;
  }

  // Step 3: clamp to room.
  const room = new Map<string, number>();
  let leftover = 0;
  for (const id of ids) {
    const r = Math.max(0, roomOf(id));
    const share = shares.get(id) ?? 0;
    const given = Math.min(share, r);
    result.set(id, given);
    room.set(id, r - given);
    leftover += share - given;
  }

  // Step 4: leftover to other lines with room, id ascending.
  for (const id of ids) {
    if (leftover <= 0) break;
    const add = Math.min(leftover, room.get(id) ?? 0);
    if (add > 0) {
      result.set(id, (result.get(id) ?? 0) + add);
      room.set(id, (room.get(id) ?? 0) - add);
      leftover -= add;
    }
  }

  // Step 5: final residual to the heaviest line (tie: lower id).
  if (leftover > 0) {
    let top = ids[0]!;
    for (const id of ids) {
      if (weightOf(id) > weightOf(top)) top = id;
    }
    result.set(top, (result.get(top) ?? 0) + leftover);
  }
  return result;
}
