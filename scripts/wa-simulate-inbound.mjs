import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// Local stand-in for a KirimDev `message.received` delivery (legend-s5rgo).
// KirimDev has no sandbox, so this posts a signed Meta-shaped envelope to the
// local `/api/webhooks/whatsapp`. The signature is the same algorithm as
// `signKirimWebhook` (packages/shared/src/adapters/webhook.ts); a .mjs script
// cannot import that TypeScript, and tests/wa-simulate-inbound.test.mjs proves
// the two stay equal. The secret is read from KIRIM_WEBHOOK_SECRET and is never
// printed.

export const SIGNATURE_HEADER = "X-Kirim-Signature";
export const EVENT_ID_HEADER = "X-Kirim-Event-Id";

export const HELP = `Usage: node scripts/wa-simulate-inbound.mjs --from <number> --text <text> [options]

Sends a signed KirimDev-style inbound WhatsApp message to the local API.
Secret: env KIRIM_WEBHOOK_SECRET (first value when comma separated). Never printed.

Options:
  --from <digits>           Sender number, e.g. 628123456789 (required, repeatable)
  --text <text>             Message text, e.g. "RESET PIN K7Q4-M2XD" (required, repeatable)
  --phone-number-id <id>    Receiving phoneNumberId (default: env KIRIM_PHONE_NUMBER_ID or "sim-phone-number-id")
  --url <url>               Target (default: http://localhost:<PORT or 4000>/api/webhooks/whatsapp)
  --message-id <id>         Message id, the dedupe key. Reuse one to test replay (default: random)
  --count <n>               Send n copies of the message in ONE delivery (ids <id>, <id>-2, ...)
  --bad-signature           Sign with a wrong secret (expect 401)
  --event-id <id>           Value of the X-Kirim-Event-Id header (default: random; required by the verifier)
  --dry-run                 Print payload and headers, send nothing, need no secret
  --help                    Show this help

Pairs: give --from and --text several times to put several messages in one delivery
(the nth --from goes with the nth --text; a single value is reused for all).

Examples:
  node scripts/wa-simulate-inbound.mjs --from 628123456789 --text "RESET PIN K7Q4-M2XD"
  node scripts/wa-simulate-inbound.mjs --from 628123456789 --text "MASUK LEGEND K7Q4-M2XD" --dry-run
`;

/** Parses argv into options. Throws Error with a readable message. */
export function parseArgs(argv) {
  const out = {
    from: [],
    text: [],
    phoneNumberId: undefined,
    url: undefined,
    messageId: undefined,
    eventId: undefined,
    count: 1,
    badSignature: false,
    dryRun: false,
    help: false,
  };
  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--"))
      throw new Error(`${name} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        out.from.push(value(i++, arg));
        break;
      case "--text":
        out.text.push(value(i++, arg));
        break;
      case "--phone-number-id":
        out.phoneNumberId = value(i++, arg);
        break;
      case "--url":
        out.url = value(i++, arg);
        break;
      case "--message-id":
        out.messageId = value(i++, arg);
        break;
      case "--event-id":
        out.eventId = value(i++, arg);
        break;
      case "--count": {
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 1 || n > 50)
          throw new Error("--count must be an integer from 1 to 50.");
        out.count = n;
        break;
      }
      case "--bad-signature":
        out.badSignature = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`Unknown option ${arg}. Use --help.`);
    }
  }
  return out;
}

/**
 * Builds the Meta envelope that `parseKirimdevPayload` expects. `messages` is a
 * list of `{ id, from, text }`.
 */
export function buildPayload({ phoneNumberId, messages }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              messages: messages.map((m) => ({
                id: m.id,
                from: m.from,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: m.text },
              })),
            },
          },
        ],
      },
    ],
  };
}

/**
 * `X-Kirim-Signature` value: `t=<unix>,v1=<hex>`, HMAC-SHA256 over
 * `"<t>." + raw body`. A comma separated secret list uses the first entry.
 */
export function signBody({ rawBody, secret, timestamp }) {
  const key = secret.split(",")[0].trim();
  if (key.length === 0) throw new Error("Webhook secret is empty.");
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", key)
    .update(`${t}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * The full header set of a delivery. `verifyKirimWebhook` rejects a delivery
 * without `X-Kirim-Event-Id` (400), so it is always present. `signature` may be
 * null (dry run without a secret).
 */
export function buildHeaders({ signature, eventId }) {
  return {
    "Content-Type": "application/json",
    [EVENT_ID_HEADER]: eventId ?? `sim-evt-${randomBytes(8).toString("hex")}`,
    ...(signature ? { [SIGNATURE_HEADER]: signature } : {}),
  };
}

/** Turns parsed options into the request: url, raw body, message ids. */
export function buildRequest(options, env = process.env) {
  if (options.from.length === 0 || options.text.length === 0)
    throw new Error("--from and --text are required. Use --help.");
  const base = options.messageId ?? `sim-${randomBytes(8).toString("hex")}`;
  const total = Math.max(
    options.count,
    options.from.length,
    options.text.length,
  );
  const messages = Array.from({ length: total }, (_, i) => ({
    id: i === 0 ? base : `${base}-${i + 1}`,
    from: options.from[i] ?? options.from[options.from.length - 1],
    text: options.text[i] ?? options.text[options.text.length - 1],
  }));
  const phoneNumberId =
    options.phoneNumberId ?? env.KIRIM_PHONE_NUMBER_ID ?? "sim-phone-number-id";
  const url =
    options.url ?? `http://localhost:${env.PORT ?? 4000}/api/webhooks/whatsapp`;
  const rawBody = JSON.stringify(buildPayload({ phoneNumberId, messages }));
  return { url, rawBody, messages };
}

export async function main(argv, env = process.env, fetchImpl = fetch) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const request = buildRequest(options, env);
  let secret = env.KIRIM_WEBHOOK_SECRET ?? "";
  if (options.badSignature) secret = `wrong-${randomBytes(8).toString("hex")}`;
  if (secret.trim().length === 0 && !options.dryRun) {
    console.error(
      "KIRIM_WEBHOOK_SECRET is empty. Export it in this shell (value not printed), or use --dry-run.",
    );
    return 1;
  }
  const signature =
    secret.trim().length > 0
      ? signBody({ rawBody: request.rawBody, secret })
      : null;
  const headers = buildHeaders({ signature, eventId: options.eventId });
  if (options.dryRun) {
    console.log(`POST ${request.url}`);
    console.log(JSON.stringify(headers, null, 2));
    console.log(JSON.stringify(JSON.parse(request.rawBody), null, 2));
    if (!signature)
      console.log("(no signature: KIRIM_WEBHOOK_SECRET is empty)");
    return 0;
  }
  const response = await fetchImpl(request.url, {
    method: "POST",
    headers,
    body: request.rawBody,
  });
  console.log(
    `${response.status} ${response.statusText} (${request.messages.length} message(s), ids: ${request.messages.map((m) => m.id).join(", ")})`,
  );
  const text = await response.text();
  if (text) console.log(text.slice(0, 500));
  return response.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
