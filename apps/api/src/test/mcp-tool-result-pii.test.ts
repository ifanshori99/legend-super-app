// AIG-02 for the MCP channel (bead legend-zafqj): personal data in anything the
// MCP server sends back (tool results, error messages, resource reads, tool
// listings) is masked before it leaves the server, same as the in-app chat.
//
// Written from the PRD AIG-02 rule and the shared masker contract
// (lib/ai/pii.ts: email, Indonesian phone, NIK, bank account; keys such as
// `phone` and `accountNumber` mask plain numbers and strings). The real
// createMcpServer is used over an in-memory MCP transport; only the invoke
// layer (ai-tool-invoke.service.ts) is stubbed so tool output carries
// controlled PII.
//
// ASSUMPTIONS:
//  - A masked value is replaced by a placeholder; we only assert the raw value
//    is gone from the whole reply, not the exact placeholder text.
//  - Money amounts, ids, account codes and outlet names are not PII and stay
//    byte for byte.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

type Outcome =
  | { ok: true; output: unknown }
  | { ok: false; errorCode: string; message: string };

const stub = vi.hoisted(() => ({
  outcomes: {} as Record<string, unknown>,
  tools: [] as unknown[],
  // When set, the stubbed layer throws this instead of returning.
  invokeThrows: undefined as unknown,
  listThrows: undefined as unknown,
}));

vi.mock("../services/ai-tool-invoke.service.ts", () => ({
  invokeAiTool: async (_ctx: unknown, name: string) => {
    if (stub.invokeThrows) throw stub.invokeThrows;
    return (
      stub.outcomes[name] ?? {
        ok: false,
        errorCode: "TOOL_NOT_FOUND",
        message: "unknown",
      }
    );
  },
  listCallableTools: async () => {
    if (stub.listThrows) throw stub.listThrows;
    return stub.tools;
  },
  toToolSpecs: (tools: { name: string; description: string }[]) =>
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {},
    })),
}));

const { createMcpServer } = await import("../services/mcp-server.service.ts");

const PII = {
  email: { raw: "budi.santoso@example.com", text: "budi.santoso@example.com" },
  phone: { raw: "081234567890", text: "telp 0812 3456 7890" },
  nik: { raw: "3174011501900001", text: "NIK 3174011501900001" },
  bank: { raw: "1234567890", text: "no rek: 1234567890" },
} as const;
const KINDS = Object.keys(PII) as (keyof typeof PII)[];
// Raw fragments that must never appear (spaces removed from the phone form).
const RAW: Record<keyof typeof PII, string[]> = {
  email: ["budi.santoso@example.com"],
  phone: ["0812 3456 7890", "081234567890"],
  nik: ["3174011501900001"],
  bank: ["1234567890"],
};

const TOOLS = ["search_sop", "get_staff_note", "get_sales_summary"] as const;

const principal = {
  tokenId: "t1",
  clientId: "c1",
  scopes: ["mcp:sales:read", "mcp:sop:read"],
  access: {} as never,
  rateLimitPerMinute: 1000,
};

async function connect(): Promise<Client> {
  const server = createMcpServer(principal as never);
  const client = new Client({ name: "pii-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return client;
}
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  stub.outcomes = {};
  stub.tools = [];
  stub.invokeThrows = undefined;
  stub.listThrows = undefined;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function setOk(name: string, output: unknown) {
  stub.outcomes[name] = { ok: true, output } satisfies Outcome;
}

function expectNoRaw(reply: unknown, kind: keyof typeof PII) {
  const wire = JSON.stringify(reply);
  for (const raw of RAW[kind]) expect(wire).not.toContain(raw);
}

describe("AIG-02 MCP tool result masking", () => {
  describe.each(TOOLS)("tool %s", (tool) => {
    it.each(KINDS)(
      "masks %s in structuredContent and content text",
      async (kind) => {
        setOk(tool, {
          rows: [{ note: `Kontak: ${PII[kind].text}` }],
          total: 1,
        });
        const client = await connect();
        const reply = await client.callTool({ name: tool, arguments: {} });
        expect(reply.isError).toBeFalsy();
        expectNoRaw(reply, kind);
      },
    );
  });

  it("masks structured keys phone and accountNumber with plain number and string values", async () => {
    setOk("get_staff_note", {
      phone: 85712345678,
      accountNumber: 7712345698,
      backupPhone: "812 3456 7890",
      nested: { accountNumber: "7712345699", phone: "85712345679" },
    });
    const client = await connect();
    const reply = await client.callTool({
      name: "get_staff_note",
      arguments: {},
    });
    const structured = JSON.stringify(reply.structuredContent);
    const text = JSON.stringify(
      (reply.content as { text: string }[])[0]?.text ?? "",
    );
    for (const where of [structured, text])
      for (const raw of [
        "85712345678",
        "7712345698",
        "812 3456 7890",
        "7712345699",
        "85712345679",
      ])
        expect(where).not.toContain(raw);
  });

  it("keeps money, ids, account codes and outlet names intact", async () => {
    const output = {
      outletName: "Outlet Senayan",
      outletId: "c0812345-6789-4abc-8def-0123456789ab",
      accountCode: "1100",
      total: 6200000000,
      rows: [{ amount: "120812345678", label: "Penjualan hari ini" }],
    };
    setOk("get_sales_summary", output);
    const client = await connect();
    const reply = await client.callTool({
      name: "get_sales_summary",
      arguments: {},
    });
    expect(reply.structuredContent).toEqual(output);
    const text = (reply.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(output);
  });

  it("masks personal data in a tool error message", async () => {
    stub.outcomes["search_sop"] = {
      ok: false,
      errorCode: "VALIDATION_FAILED",
      message:
        "Tidak ada hasil untuk budi.santoso@example.com / 0812 3456 7890",
    } satisfies Outcome;
    const client = await connect();
    const reply = await client.callTool({ name: "search_sop", arguments: {} });
    expect(reply.isError).toBe(true);
    const wire = JSON.stringify(reply);
    expect(wire).not.toContain("budi.santoso@example.com");
    expect(wire).not.toContain("0812 3456 7890");
    // The error code stays readable for the caller.
    expect(wire).toContain("VALIDATION_FAILED");
  });

  it("structuredContent deep-equals the parsed content text when the output has PII", async () => {
    setOk("get_staff_note", {
      note: "Hubungi budi.santoso@example.com / 0812 3456 7890",
      phone: 85712345678,
      rows: [{ nik: "NIK 3174011501900001", total: 3 }],
    });
    const client = await connect();
    const reply = await client.callTool({
      name: "get_staff_note",
      arguments: {},
    });
    expect(reply.isError).toBeFalsy();
    const text = (reply.content as { text: string }[])[0]!.text;
    expect(reply.structuredContent).toEqual(JSON.parse(text));
    // Sanity: the shared value is the masked one, not the raw one.
    expect(JSON.stringify(reply)).not.toContain("budi.santoso@example.com");
  });
});

describe("AIG-02 MCP unexpected errors", () => {
  // Either shape is acceptable to a client: a rejected request (JSON-RPC error)
  // or a tool result flagged isError. We look at everything the client sees.
  async function seen(run: () => Promise<unknown>): Promise<string> {
    try {
      return JSON.stringify(await run());
    } catch (e) {
      return `${(e as Error).message} ${JSON.stringify(e)}`;
    }
  }
  const LEAKY =
    "Failed query: select * from staff where email = $1 and phone = $2 params: a@b.co,08123456789";

  function expectGeneric(wire: string) {
    expect(wire).toContain("Internal error");
    for (const leak of [
      "Failed query",
      "select",
      "params",
      "a@b.co",
      "08123456789",
    ])
      expect(wire).not.toContain(leak);
  }

  it("a throwing tool handler returns a generic Internal error without SQL or PII", async () => {
    stub.invokeThrows = new Error(LEAKY);
    const client = await connect();
    const wire = await seen(() =>
      client.callTool({ name: "search_sop", arguments: {} }),
    );
    expectGeneric(wire);
  });

  it("a throwing tool listing returns a generic Internal error without SQL or PII", async () => {
    stub.listThrows = new Error(LEAKY);
    const client = await connect();
    const wire = await seen(() => client.listTools());
    expectGeneric(wire);
  });

  it("a throwing catalog resource read returns a generic Internal error without SQL or PII", async () => {
    stub.listThrows = new Error(LEAKY);
    const client = await connect();
    const wire = await seen(() =>
      client.readResource({ uri: "legend://tools/catalog" }),
    );
    expectGeneric(wire);
  });

  it("redacts an email inside a thrown McpError message", async () => {
    stub.invokeThrows = new McpError(
      ErrorCode.InvalidParams,
      "Invalid input for budi.santoso@example.com",
    );
    const client = await connect();
    const wire = await seen(() =>
      client.callTool({ name: "search_sop", arguments: {} }),
    );
    expect(wire).not.toContain("budi.santoso@example.com");
  });

  it("redacts an email inside a thrown HttpError-like error (status + message)", async () => {
    // HttpError shape per the API error contract: an Error carrying a numeric
    // status. Built inline so the test does not import backend code.
    stub.invokeThrows = Object.assign(
      new Error("Staff budi.santoso@example.com tidak ditemukan"),
      { name: "HttpError", status: 404 },
    );
    const client = await connect();
    const wire = await seen(() =>
      client.callTool({ name: "search_sop", arguments: {} }),
    );
    expect(wire).not.toContain("budi.santoso@example.com");
  });
});

describe("AIG-02 MCP resource and listing masking", () => {
  const catalogTool = (description: string) => ({
    name: "search_sop",
    code: "TL-10",
    kind: "read",
    titleId: "Cari SOP",
    description,
    scope: "mcp:sop:read",
    mcpAnnotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  it("masks personal data in the tool catalog resource", async () => {
    stub.tools = [
      catalogTool("Hubungi budi.santoso@example.com atau 0812 3456 7890"),
    ];
    const client = await connect();
    const reply = await client.readResource({ uri: "legend://tools/catalog" });
    const wire = JSON.stringify(reply);
    expect(wire).not.toContain("budi.santoso@example.com");
    expect(wire).not.toContain("0812 3456 7890");
    expect(wire).toContain("Cari SOP");
  });

  it("masks personal data in the tools/list descriptions", async () => {
    stub.tools = [catalogTool("NIK 3174011501900001, rek: 1234567890")];
    const client = await connect();
    const reply = await client.listTools();
    const wire = JSON.stringify(reply);
    expect(wire).not.toContain("3174011501900001");
    expect(wire).not.toContain("1234567890");
    expect(reply.tools[0]?.name).toBe("search_sop");
  });

  it("returns the requested uri unchanged on resource reads", async () => {
    stub.tools = [catalogTool("Hubungi budi.santoso@example.com")];
    const client = await connect();
    for (const uri of [
      "legend://tools/catalog",
      "legend://metrics/definitions",
    ]) {
      const read = await client.readResource({ uri });
      expect(read.contents.length).toBeGreaterThan(0);
      for (const c of read.contents) expect(c.uri).toBe(uri);
    }
  });

  it("still lists the resources and reads the metric glossary", async () => {
    const client = await connect();
    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain(
      "legend://metrics/definitions",
    );
    const read = await client.readResource({
      uri: "legend://metrics/definitions",
    });
    expect(read.contents.length).toBeGreaterThan(0);
  });
});
