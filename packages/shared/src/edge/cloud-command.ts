// Edge -> cloud command contract (card F1, brief 1269). One path for every
// action the cloud must decide while the edge owns the bill: the edge stores a
// command (ULID, frozen body bytes), sends it with its node credential, and the
// cloud executes it at most once per id.
//
// - The body never names a tenant, outlet, node or device: the cloud takes them
//   from the verified credential (strict schemas refuse such fields).
// - The body bytes are part of the key: the same id with other bytes is refused.
// - An outcome the edge did not receive stays `unknown` there. It is settled by
//   asking the status of that id, never by a new id. A status question about an
//   id the cloud does not know writes a tombstone (`absent`), so a late POST of
//   that id can no longer execute.
import {
  dataResponseSchema,
  isoDateTimeSchema,
  ulidSchema,
  z,
} from "../core/index.ts";

/** Cloud routes: POST the frozen body, and POST `<id>/status` to settle it. */
export const EDGE_COMMAND_PATH = "/api/edge-sync/commands";
/** The edge database the command comes from (`edge_nodes.instance_id`). */
export const EDGE_COMMAND_INSTANCE_HEADER = "X-Edge-Instance";
/**
 * The edge's own clock (ISO) when it sent the request. Not part of the frozen
 * body and never trusted: it only tells a wrong edge clock from a late send.
 */
export const EDGE_COMMAND_CLOCK_HEADER = "X-Edge-Time";
/** Largest command body, in bytes. */
export const EDGE_COMMAND_MAX_BYTES = 16 * 1024;
/** Largest `result` a kind may return, in bytes of JSON. */
export const EDGE_COMMAND_MAX_RESULT_BYTES = 8 * 1024;
/**
 * Longest time between `issuedAt` and `expiresAt`, and the furthest in the
 * future (cloud clock) an `expiresAt` may be, plus the skew allowance.
 */
export const EDGE_COMMAND_MAX_TTL_MS = 15 * 60 * 1000;
export const EDGE_COMMAND_MAX_SKEW_MS = 2 * 60 * 1000;

/** `<area>.<action>`; later cards add kinds, never reuse one. */
export const edgeCommandKindSchema = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, "Jenis perintah tidak valid.");

/** The one kind of card F1: proves the path, changes no business data. */
export const EDGE_COMMAND_TEST_KIND = "test.echo";
export const edgeTestEchoPayloadSchema = z.strictObject({
  note: z.string().max(200),
});
export const edgeTestEchoResultSchema = z.strictObject({
  note: z.string().max(200),
});

/** The frozen body. Parsed by the cloud from the exact bytes the edge stored. */
export const edgeCommandBodySchema = z
  .strictObject({
    v: z.literal(1),
    id: ulidSchema,
    kind: edgeCommandKindSchema,
    payload: z.record(z.string(), z.unknown()),
    issuedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .refine(
    (body) => {
      const ttl = Date.parse(body.expiresAt) - Date.parse(body.issuedAt);
      return ttl > 0 && ttl <= EDGE_COMMAND_MAX_TTL_MS;
    },
    { message: "Masa berlaku perintah tidak valid.", path: ["expiresAt"] },
  );
export type EdgeCommandBody = z.infer<typeof edgeCommandBodySchema>;

export const edgeCommandSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Digest perintah tidak valid.");

/** Body of the status question: which bytes the edge would have sent. */
export const edgeCommandStatusRequestSchema = z.strictObject({
  kind: edgeCommandKindSchema,
  bodySha256: edgeCommandSha256Schema,
});
export type EdgeCommandStatusRequest = z.infer<
  typeof edgeCommandStatusRequestSchema
>;

export const edgeCommandParamsSchema = z.strictObject({
  commandId: ulidSchema,
});

/**
 * Final cloud outcomes.
 * - succeeded: executed once, `result` is what the kind returned.
 * - refused: the kind said no (`code`); nothing of it was kept.
 * - expired: arrived after `expiresAt`; never executed.
 * - absent: the status question tombstoned it; never executed, never will be.
 */
export const EDGE_COMMAND_FINAL_STATUSES = [
  "succeeded",
  "refused",
  "expired",
  "absent",
] as const;
export const edgeCommandFinalStatusSchema = z.enum(EDGE_COMMAND_FINAL_STATUSES);
export type EdgeCommandFinalStatus = z.infer<
  typeof edgeCommandFinalStatusSchema
>;

export const edgeCommandCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

const outcomeBase = {
  id: ulidSchema,
  kind: edgeCommandKindSchema,
  bodySha256: edgeCommandSha256Schema,
  decidedAt: isoDateTimeSchema,
};
export const edgeCommandOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...outcomeBase,
    status: z.literal("succeeded"),
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...outcomeBase,
    status: z.literal("refused"),
    code: edgeCommandCodeSchema,
  }),
  z.strictObject({ ...outcomeBase, status: z.literal("expired") }),
  z.strictObject({ ...outcomeBase, status: z.literal("absent") }),
]);
export type EdgeCommandOutcome = z.infer<typeof edgeCommandOutcomeSchema>;
export const edgeCommandOutcomeResponseSchema = dataResponseSchema(
  edgeCommandOutcomeSchema,
);
