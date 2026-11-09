// Tanya AI chat HTTP API (PRD v1.7 §3 Fitur 38; AIG-01; TEN-01/02/03; bead
// legend-xq8y). Real Express app, Better Auth, RBAC and PostgreSQL against the
// seeded Cafe Legend tenant, with the scripted fake provider. Needs the
// engineer's registration of `aiChatRouter` under `/api/ai` (routes/index.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeProvider } from "../lib/ai/fake.ts";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import {
  asTenant,
  cleanupAcceptance,
  created,
  grantCustomRole,
  newOwner,
  originHeader,
  outletA,
  ownerPool,
  resetGovernance,
  signedIn,
  tenantAgent,
  tenantId,
} from "./ai-acceptance-helpers.ts";

type Client = Awaited<ReturnType<typeof signedIn>>["client"];
let asker: Client;
let otherAsker: Client;
let outsider: Client;
let outletAsker: Client;
let askerId: string;

const ask = (client: Client, body: Record<string, unknown>) =>
  client.post("/api/ai/ask").set(originHeader).send(body);

beforeAll(async () => {
  setAiProviderForTests(
    createFakeProvider(() => ({
      content: [{ type: "text", text: "Jawaban uji." }],
      stopReason: "end_turn",
    })),
  );
  // Own tenant (ai-acceptance-helpers) with a funded AI budget: a tenant with
  // no ai_settings row fails closed with a zero budget (AIG-01, HTTP 402).
  await resetGovernance(await newOwner("Pemilik AI chat"));
  const a = await signedIn("Penanya A");
  await grantCustomRole(a.userId, ["ai.ask"], { type: "tenant" });
  asker = a.client;
  askerId = a.userId;
  const b = await signedIn("Penanya B");
  await grantCustomRole(b.userId, ["ai.ask"], { type: "tenant" });
  otherAsker = b.client;
  const c = await signedIn("Tanpa izin");
  await grantCustomRole(c.userId, ["self.profile.view"], { type: "tenant" });
  outsider = c.client;
  const d = await signedIn("Penanya outlet");
  await grantCustomRole(d.userId, ["ai.ask"], { type: "outlet", id: outletA });
  outletAsker = d.client;
});

afterAll(async () => {
  setAiProviderForTests(undefined);
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM ai_conversations WHERE tenant_id = $1 AND owner_user_id = ANY($2)",
      [tenantId, created.users],
    );
    for (const table of ["ai_usage_events", "ai_usage_daily"])
      await db.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND user_id = ANY($2)`,
        [tenantId, created.users],
      );
  });
  await cleanupAcceptance();
  await ownerPool.query("DELETE FROM ai_settings WHERE tenant_id = $1", [
    tenantId,
  ]);
  await ownerPool.query('DELETE FROM "user" WHERE id = ANY($1)', [
    created.users,
  ]);
  await ownerPool.end();
});

describe("auth and permission", () => {
  it("answers 401 without a session", async () => {
    const response = await tenantAgent().get("/api/ai/tools");
    expect(response.status).toBe(401);
  });

  it("answers 403 without ai.ask on every route", async () => {
    expect((await outsider.get("/api/ai/tools")).status).toBe(403);
    expect((await outsider.get("/api/ai/conversations")).status).toBe(403);
    expect(
      (await ask(outsider, { feature: "AI-01", question: "Halo" })).status,
    ).toBe(403);
  });

  it("refuses a cookie mutation from an untrusted origin", async () => {
    const response = await asker
      .post("/api/ai/ask")
      .set("Origin", "https://evil.example")
      .send({ feature: "AI-01", question: "Halo" });
    expect(response.status).toBe(403);
  });

  it("rejects unknown body fields (strict zod)", async () => {
    const response = await ask(asker, {
      feature: "AI-01",
      question: "Halo",
      tenantId: randomUUID(),
    });
    expect(response.status).toBe(422);
  });
});

describe("ask and conversations", () => {
  it("answers, stores the conversation and lists it for the owner only", async () => {
    const response = await ask(asker, {
      feature: "AI-01",
      question: "Berapa penjualan kemarin?",
    });
    expect(response.status).toBe(200);
    const { conversation, userMessage, assistantMessage, actionRequestIds } =
      response.body.data;
    expect(conversation.userId).toBe(askerId);
    expect(userMessage.role).toBe("user");
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      content: "Jawaban uji.",
      aiAssisted: true,
    });
    expect(actionRequestIds).toEqual([]);

    const mine = await asker.get("/api/ai/conversations");
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((item: { id: string }) => item.id)).toContain(
      conversation.id,
    );
    const theirs = await otherAsker.get("/api/ai/conversations");
    expect(
      theirs.body.data.map((item: { id: string }) => item.id),
    ).not.toContain(conversation.id);

    const detail = await asker.get(`/api/ai/conversations/${conversation.id}`);
    expect(detail.status).toBe(200);
    expect(
      detail.body.data.messages.map((m: { role: string }) => m.role),
    ).toEqual(["user", "assistant"]);

    // Another user in the same tenant cannot read, continue or delete it.
    const peek = await otherAsker.get(
      `/api/ai/conversations/${conversation.id}`,
    );
    expect(peek.status).toBe(404);
    expect(peek.body.error?.code ?? peek.body.code).toBe(
      "AI_CONVERSATION_NOT_FOUND",
    );
    expect(
      (
        await ask(otherAsker, {
          feature: "AI-01",
          question: "Lanjut",
          conversationId: conversation.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await otherAsker
          .delete(`/api/ai/conversations/${conversation.id}`)
          .set(originHeader)
      ).status,
    ).toBe(404);
  });

  it("continues a conversation in order", async () => {
    const first = await ask(asker, { feature: "AI-01", question: "Halo" });
    const id = first.body.data.conversation.id as string;
    const second = await ask(asker, {
      feature: "AI-01",
      question: "Dan hari ini?",
      conversationId: id,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.conversation.id).toBe(id);
    const detail = await asker.get(`/api/ai/conversations/${id}`);
    expect(
      detail.body.data.messages.map((m: { content: string }) => m.content),
    ).toEqual(["Halo", "Jawaban uji.", "Dan hari ini?", "Jawaban uji."]);
  });

  it("blocks personal data in the question with AI_PII_BLOCKED", async () => {
    const response = await ask(asker, {
      feature: "AI-01",
      question: "Kirim ke budi@example.com dan 081234567890",
    });
    expect(response.status).toBe(422);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "AI_PII_BLOCKED",
    );
  });

  it("rejects an outlet outside the caller's reach", async () => {
    const response = await ask(outletAsker, {
      feature: "AI-01",
      question: "Penjualan?",
      outletId: randomUUID(),
    });
    expect(response.status).toBe(403);
  });

  it("creates an empty conversation", async () => {
    const response = await asker
      .post("/api/ai/conversations")
      .set(originHeader)
      .send({ feature: "AI-02", title: "Stok" });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      feature: "AI-02",
      title: "Stok",
    });
  });

  it("deletes the conversation, its messages and emits the event", async () => {
    const made = await ask(asker, { feature: "AI-01", question: "Hapus saya" });
    const id = made.body.data.conversation.id as string;
    const removed = await asker
      .delete(`/api/ai/conversations/${id}`)
      .set(originHeader);
    expect(removed.status).toBe(204);
    expect((await asker.get(`/api/ai/conversations/${id}`)).status).toBe(404);
    const rows = await asTenant((db) =>
      db.query("SELECT 1 FROM ai_messages WHERE conversation_id = $1", [id]),
    );
    expect(rows.rowCount).toBe(0);
    const events = await asTenant((db) =>
      db.query(
        "SELECT 1 FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2",
        [tenantId, id],
      ),
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe("tool catalog", () => {
  it("lists only tools the caller can call, with no schemas on the wire", async () => {
    const response = await asker.get("/api/ai/tools");
    expect(response.status).toBe(200);
    for (const tool of response.body.data) {
      expect(Object.keys(tool).sort()).toEqual(
        [
          "code",
          "description",
          "kind",
          "mcpAnnotations",
          "name",
          "scope",
          "titleId",
        ].sort(),
      );
    }
    // ai.ask alone gives no sales/finance data permission.
    const names = response.body.data.map((t: { name: string }) => t.name);
    expect(names).not.toContain("get_financial_statement");
  });
});
