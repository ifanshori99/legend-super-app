// Examine the raw body before Zod strips forward-compatible fields. Credentials
// and key material must never be silently accepted, even in an unknown section.
/** Inspect untrusted JSON in bounded space before dropping forward-compatible fields. */
export function hasUnsafeSnapshotFields(
  value: unknown,
  maxNodes = 4_194_304,
): boolean {
  const maxDepth = 8;
  function* fields(item: object): Generator<[string, unknown]> {
    for (const key in item) {
      if (Object.hasOwn(item, key))
        yield [key, (item as Record<string, unknown>)[key]];
    }
  }
  if (value === null || typeof value !== "object") return false;
  const stack = [{ iterator: fields(value), depth: 0 }];
  let visited = 1;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.iterator.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const [key, child] = next.value;
    const depth = frame.depth + 1;
    if (++visited > maxNodes || depth > maxDepth) return true;
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .split(/[^a-z0-9]+/i)
      .map((word) => word.toLowerCase());
    if (
      words.includes("pin") ||
      /^pin|pin$/i.test(key) ||
      /password|passcode|token|credential|secret|seed|auth|bearer|session|otp|private.?key|api.?key|access.?key|client.?key/i.test(
        key,
      )
    )
      return true;
    if (child !== null && typeof child === "object") {
      stack.push({ iterator: fields(child), depth });
    }
  }
  return false;
}
