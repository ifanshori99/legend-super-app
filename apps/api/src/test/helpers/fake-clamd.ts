import net from "node:net";

// Fake clamd for tests (protocol per the M4 contract): `zINSTREAM\0`, then
// chunks of [u32 BE length][bytes], ended by a zero length; `zPING\0`.

export type FakeClamdBehavior =
  | { kind: "reply"; reply: string; whenStreamEnds?: boolean }
  | { kind: "silent" } // read everything, never answer (timeout)
  | { kind: "close" }; // drop the connection without answering

export interface FakeClamdSession {
  command: string;
  chunks: Buffer[];
  terminated: boolean;
}

export interface FakeClamd {
  port: number;
  sessions: FakeClamdSession[];
  /** Resolves when the n-th server-side connection has fully closed. */
  closedConnections: () => number;
  waitForClosed: (count: number) => Promise<void>;
  setBehavior: (behavior: FakeClamdBehavior) => void;
  close: () => Promise<void>;
}

export async function startFakeClamd(
  initial: FakeClamdBehavior,
): Promise<FakeClamd> {
  let behavior = initial;
  const sessions: FakeClamdSession[] = [];
  const sockets = new Set<net.Socket>();
  let closed = 0;
  const closeWaiters: Array<{ count: number; resolve: () => void }> = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const session: FakeClamdSession = {
      command: "",
      chunks: [],
      terminated: false,
    };
    sessions.push(session);
    let buffer = Buffer.alloc(0);
    let phase: "command" | "stream" | "done" = "command";
    const current = behavior;

    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      closed += 1;
      for (const waiter of [...closeWaiters]) {
        if (closed >= waiter.count) {
          closeWaiters.splice(closeWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });

    const answer = () => {
      if (current.kind === "reply") {
        socket.end(current.reply);
      } else if (current.kind === "close") {
        socket.destroy();
      }
      // silent: keep the socket open and say nothing.
    };

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === "command") {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        session.command = buffer.subarray(0, nul).toString("latin1");
        buffer = buffer.subarray(nul + 1);
        if (session.command === "zINSTREAM") {
          phase = "stream";
          if (current.kind === "reply" && current.whenStreamEnds === false) {
            answer();
            phase = "done";
            return;
          }
          if (current.kind === "close") {
            answer();
            phase = "done";
            return;
          }
        } else {
          phase = "done";
          answer();
          return;
        }
      }
      while (phase === "stream" && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          session.terminated = true;
          phase = "done";
          answer();
          return;
        }
        if (buffer.length < 4 + length) return;
        session.chunks.push(Buffer.from(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    sessions,
    closedConnections: () => closed,
    waitForClosed: (count) =>
      closed >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => closeWaiters.push({ count, resolve })),
    setBehavior: (next) => {
      behavior = next;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A local port that nothing listens on (for ECONNREFUSED). */
export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
