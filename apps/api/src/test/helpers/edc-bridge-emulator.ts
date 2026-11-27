// Small Node emulator of the "Legend EDC Bridge" tablet for the B2 tests
// (legend-wasr7.21). It speaks the wire contract of
// @starter/shared/edc/bridge and answers commands with the simulator codec's
// base64 JSON body (edge/edc/bridge-codec.ts). No journal, no dedupe, no
// terminal link: the full emulator is B3.
import WebSocket from "ws";
import {
  EDC_BRIDGE_PROTOCOL_VERSION,
  parseEdcBridgeDownlink,
  type EdcBridgeAnswer,
  type EdcBridgeCommand,
  type EdcBridgeDownlink,
  type EdcBridgeResult,
} from "@starter/shared/edc/bridge";

export type DecodedCommand = EdcBridgeCommand & {
  body: Record<string, unknown>;
};

/** What the tablet does with a command: an answer, or null = stay silent. */
export type CommandScript = (command: DecodedCommand) => EdcBridgeAnswer | null;

export const responseOf = (body: unknown): EdcBridgeAnswer => ({
  outcome: "response",
  frame: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
});

export type BridgeEmulator = Awaited<ReturnType<typeof connectBridge>>;

export async function connectBridge(
  url: string,
  token: string | null,
  options: { script?: CommandScript } = {},
) {
  const received: EdcBridgeDownlink[] = [];
  const waiters: Array<() => void> = [];
  let script = options.script ?? (() => null);
  let closeCode: number | null = null;
  const ws = new WebSocket(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const opened = await new Promise<
    { ok: true } | { ok: false; status: number }
  >((resolve) => {
    ws.once("open", () => resolve({ ok: true }));
    ws.once("unexpected-response", (_req, res) =>
      resolve({ ok: false, status: res.statusCode ?? 0 }),
    );
    ws.once("error", () => resolve({ ok: false, status: 0 }));
  });
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  ws.on("message", (data) => {
    const message = parseEdcBridgeDownlink(String(data));
    received.push(message);
    if (message.type === "command") {
      const body = JSON.parse(
        Buffer.from(message.frame, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      const answer = script({ ...message, body });
      if (answer) send(resultFor(message, answer));
    }
    for (const wake of waiters.splice(0)) wake();
  });
  ws.on("close", (code) => {
    closeCode = code;
    for (const wake of waiters.splice(0)) wake();
  });

  async function waitFor<T extends EdcBridgeDownlink["type"]>(
    type: T,
    from = 0,
    timeoutMs = 15_000,
  ): Promise<Extract<EdcBridgeDownlink, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = received.slice(from).find((message) => message.type === type);
      if (hit) return hit as Extract<EdcBridgeDownlink, { type: T }>;
      if (Date.now() > deadline || closeCode !== null)
        throw new Error(`EDC bridge emulator: no ${type}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50).unref();
      });
    }
  }

  return {
    opened,
    ws,
    received,
    get closeCode() {
      return closeCode;
    },
    setScript(next: CommandScript) {
      script = next;
    },
    send,
    async hello() {
      const from = received.length;
      send({
        type: "hello",
        protocolVersion: EDC_BRIDGE_PROTOCOL_VERSION,
        appVersion: "0.1.0",
        unackedResults: 0,
        heldSaleRecords: 0,
      });
      return waitFor("lease", from);
    },
    waitFor,
    acks: () =>
      received.flatMap((message) =>
        message.type === "ack" ? [message.commandId] : [],
      ),
    async closed(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (closeCode === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return closeCode;
    },
    close() {
      ws.terminate();
    },
  };
}

export function resultFor(
  command: Pick<EdcBridgeCommand, "commandId" | "terminalId" | "op" | "trace">,
  answer: EdcBridgeAnswer,
  overrides: Partial<EdcBridgeResult> = {},
): EdcBridgeResult {
  return {
    type: "result",
    commandId: command.commandId,
    terminalId: command.terminalId,
    op: command.op,
    trace: command.trace,
    replayOf: null,
    completedAt: new Date().toISOString(),
    answer,
    ...overrides,
  };
}
