import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  verifyKirimWebhook,
  signKirimWebhook,
} from "../packages/shared/src/adapters/webhook.ts";
import {
  buildHeaders,
  buildPayload,
  buildRequest,
  parseArgs,
  signBody,
} from "../scripts/wa-simulate-inbound.mjs";

const SECRET = "simulator-test-secret";

test("simulator signature passes verifyKirimWebhook and equals signKirimWebhook", async () => {
  const rawBody = JSON.stringify({ hello: "wörld" });
  const timestamp = Math.floor(Date.now() / 1000);
  const header = signBody({ rawBody, secret: SECRET, timestamp });
  assert.equal(
    header,
    await signKirimWebhook({ rawBody, secret: SECRET, timestamp }),
  );
  const verified = await verifyKirimWebhook({
    headers: buildHeaders({ signature: header }),
    rawBody,
    secrets: [SECRET],
  });
  assert.equal(verified.signedAt, timestamp);
});

test("simulator uses the first secret of a comma separated list and rejects a wrong one", async () => {
  const rawBody = "{}";
  const header = signBody({ rawBody, secret: `${SECRET},older` });
  const headers = buildHeaders({ signature: header });
  await verifyKirimWebhook({ headers, rawBody, secrets: [SECRET] });
  await assert.rejects(
    verifyKirimWebhook({ headers, rawBody, secrets: ["other"] }),
  );
});

test("simulator payload has the envelope parseKirimdevPayload reads", () => {
  // The API parser needs the database module, so this checks the same fields
  // it reads (identity-wa-inbound.service.ts kirimdevPayloadSchema) directly.
  const request = buildRequest(
    parseArgs([
      "--from",
      "628123456789",
      "--text",
      "RESET PIN K7Q4-M2XD",
      "--phone-number-id",
      "pn-1",
      "--message-id",
      "m-1",
      "--count",
      "3",
    ]),
    { PORT: "4321" },
  );
  assert.equal(request.url, "http://localhost:4321/api/webhooks/whatsapp");
  const payload = JSON.parse(request.rawBody);
  assert.equal(payload.object, "whatsapp_business_account");
  const change = payload.entry[0].changes[0];
  assert.equal(change.field, "messages");
  assert.equal(change.value.metadata.phone_number_id, "pn-1");
  assert.deepEqual(
    change.value.messages.map((m) => [m.id, m.from, m.type, m.text.body]),
    ["m-1", "m-1-2", "m-1-3"].map((id) => [
      id,
      "628123456789",
      "text",
      "RESET PIN K7Q4-M2XD",
    ]),
  );
});

test("simulator builds one delivery with several different messages", () => {
  const request = buildRequest(
    parseArgs([
      "--from",
      "6281",
      "--from",
      "6282",
      "--text",
      "a",
      "--text",
      "b",
    ]),
    {},
  );
  const payload = buildPayload({
    phoneNumberId: "x",
    messages: request.messages,
  });
  assert.equal(payload.entry[0].changes[0].value.messages.length, 2);
  assert.deepEqual(
    request.messages.map((m) => [m.from, m.text]),
    [
      ["6281", "a"],
      ["6282", "b"],
    ],
  );
});

test("simulator --help and --dry-run work without a secret and print no secret", () => {
  const env = { ...process.env, KIRIM_WEBHOOK_SECRET: "" };
  const help = execFileSync(
    process.execPath,
    ["scripts/wa-simulate-inbound.mjs", "--help"],
    { env, encoding: "utf8" },
  );
  assert.match(help, /--bad-signature/);
  const dry = execFileSync(
    process.execPath,
    [
      "scripts/wa-simulate-inbound.mjs",
      "--from",
      "628123456789",
      "--text",
      "hi",
      "--dry-run",
    ],
    { env, encoding: "utf8" },
  );
  assert.match(dry, /whatsapp_business_account/);
  const withSecret = execFileSync(
    process.execPath,
    [
      "scripts/wa-simulate-inbound.mjs",
      "--from",
      "628123456789",
      "--text",
      "hi",
      "--dry-run",
    ],
    { env: { ...env, KIRIM_WEBHOOK_SECRET: SECRET }, encoding: "utf8" },
  );
  assert.match(withSecret, /t=\d+,v1=[0-9a-f]{64}/);
  assert.equal(withSecret.includes(SECRET), false);
});

test("simulator exits with a clear message when the secret is empty", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "scripts/wa-simulate-inbound.mjs",
          "--from",
          "628123456789",
          "--text",
          "hi",
        ],
        { env: { ...process.env, KIRIM_WEBHOOK_SECRET: "" }, stdio: "pipe" },
      ),
    (error) => /KIRIM_WEBHOOK_SECRET is empty/.test(String(error.stderr)),
  );
});

test("simulator headers carry X-Kirim-Event-Id; verifier rejects a delivery without it", async () => {
  const rawBody = "{}";
  const signature = signBody({ rawBody, secret: SECRET });
  const headers = buildHeaders({ signature });
  assert.match(headers["X-Kirim-Event-Id"], /^sim-evt-[0-9a-f]{16}$/);
  assert.equal(
    buildHeaders({ signature, eventId: "e-1" })["X-Kirim-Event-Id"],
    "e-1",
  );
  await verifyKirimWebhook({ headers, rawBody, secrets: [SECRET] });
  const withoutEventId = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "X-Kirim-Event-Id"),
  );
  await assert.rejects(
    verifyKirimWebhook({ headers: withoutEventId, rawBody, secrets: [SECRET] }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("simulator --dry-run prints X-Kirim-Event-Id and honours --event-id", () => {
  const out = execFileSync(
    process.execPath,
    [
      "scripts/wa-simulate-inbound.mjs",
      "--from",
      "628123456789",
      "--text",
      "hi",
      "--event-id",
      "evt-xyz",
      "--dry-run",
    ],
    { env: { ...process.env, KIRIM_WEBHOOK_SECRET: "" }, encoding: "utf8" },
  );
  assert.match(out, /"X-Kirim-Event-Id": "evt-xyz"/);
});
