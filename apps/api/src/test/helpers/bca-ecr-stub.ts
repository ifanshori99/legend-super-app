// Stub of the BCA ECR cloud gateway for the B5a tests (legend-wasr7.23). It
// checks what the SNAP client sends (token signature with the partner's
// public key, HMAC-SHA512 transaction signature, one X-EXTERNAL-ID per
// request) and answers per terminal (TID) with a scripted scenario. The wire
// shapes follow bca-cloud-provider.ts, i.e. the SNAP summary, NOT BCA's ECR
// document (belum diverifikasi bank).
import { createVerify, randomBytes, type KeyObject } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  BCA_ECR_INQUIRY_PATH,
  BCA_ECR_PAYMENT_PATH,
  BCA_ECR_TRANS_TYPE,
} from "../../edge/edc/bca-cloud-provider.ts";
import {
  BCA_SNAP_TOKEN_PATH,
  tokenStringToSign,
  transactionSignature,
} from "../../edge/edc/bca-snap-client.ts";

/** What BCA does with the payment request of a terminal. */
export type BcaEcrScenario =
  /** 200, transaction status 00, amount echoed. */
  | "approved"
  /** 200, transaction status 06. */
  | "declined"
  /** 400 before processing. */
  | "rejected"
  /** 202IS00; the inquiry then answers approved. */
  | "pending_then_approved"
  /** 504IS00; the inquiry then answers not found. */
  | "timeout_then_not_found"
  /** Charges, then closes the socket without a reply; inquiry approved. */
  | "drop_after_send"
  /** 409IS00 (external id reused); nothing charged. */
  | "conflict";

export type BcaEcrStubRequest = {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signatureOk: boolean;
};

type Charge = { amount: { value: string; currency: string }; voided: boolean };

export async function startBcaEcrStub(options: {
  clientId: string;
  clientSecret: string;
  publicKey: KeyObject;
  /** `expiresIn` of issued tokens, seconds. Default 900. */
  expiresInS?: number;
}) {
  const scenarios = new Map<string, BcaEcrScenario>();
  const tokens = new Set<string>();
  const externalIds = new Set<string>();
  const charges = new Map<string, Charge>();
  const requests: BcaEcrStubRequest[] = [];
  const issued: string[] = [];
  let tokenRequests = 0;

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  const header = (req: IncomingMessage, name: string) => {
    const value = req.headers[name.toLowerCase()];
    return typeof value === "string" ? value : "";
  };

  function token(req: IncomingMessage, res: ServerResponse) {
    tokenRequests += 1;
    const timestamp = header(req, "X-TIMESTAMP");
    const ok =
      header(req, "X-CLIENT-KEY") === options.clientId &&
      createVerify("RSA-SHA256")
        .update(tokenStringToSign(options.clientId, timestamp), "utf8")
        .verify(options.publicKey, header(req, "X-SIGNATURE"), "base64");
    if (!ok) return reply(res, 401, { responseCode: "4017300" });
    const value = randomBytes(24).toString("base64url");
    tokens.add(value);
    issued.push(value);
    reply(res, 200, {
      responseCode: "2007300",
      responseMessage: "Successful",
      accessToken: value,
      tokenType: "Bearer",
      expiresIn: String(options.expiresInS ?? 900),
    });
  }

  function details(reference: string, charge: Charge) {
    return {
      amount: charge.amount,
      approvalCode: "A1B2C3",
      rrn: `RRN${reference}`.slice(0, 24),
      cardType: "VISA",
      maskedPan: "411111******1111",
      invoiceNo: "000123",
      batchNo: "000001",
    };
  }

  function payment(res: ServerResponse, body: Record<string, unknown>) {
    const reference = String(body.partnerReferenceNo);
    if (body.transType === BCA_ECR_TRANS_TYPE.void) {
      const original = charges.get(String(body.originalPartnerReferenceNo));
      if (!original || original.voided)
        return reply(res, 404, {
          responseCode: "404IS01",
          partnerReferenceNo: reference,
        });
      original.voided = true;
      return reply(res, 200, {
        responseCode: "200IS00",
        partnerReferenceNo: reference,
        transactionStatus: "00",
      });
    }
    const charge: Charge = {
      amount: body.amount as Charge["amount"],
      voided: false,
    };
    const scenario = scenarios.get(String(body.terminalId)) ?? "approved";
    switch (scenario) {
      case "approved":
        charges.set(reference, charge);
        return reply(res, 200, {
          responseCode: "200IS00",
          partnerReferenceNo: reference,
          transactionStatus: "00",
          ...details(reference, charge),
        });
      case "declined":
        return reply(res, 200, {
          responseCode: "200IS00",
          partnerReferenceNo: reference,
          transactionStatus: "06",
        });
      case "rejected":
        return reply(res, 400, {
          responseCode: "400IS02",
          responseMessage: "Invalid Mandatory Field",
        });
      case "pending_then_approved":
        charges.set(reference, charge);
        return reply(res, 202, {
          responseCode: "202IS00",
          partnerReferenceNo: reference,
        });
      case "timeout_then_not_found":
        return reply(res, 504, { responseCode: "504IS00" });
      case "drop_after_send":
        charges.set(reference, charge);
        res.socket?.destroy();
        return;
      case "conflict":
        return reply(res, 409, { responseCode: "409IS00" });
    }
  }

  function inquiry(res: ServerResponse, body: Record<string, unknown>) {
    const reference = String(body.originalPartnerReferenceNo);
    const charge = charges.get(reference);
    reply(res, 200, {
      responseCode: "200IS00",
      originalPartnerReferenceNo: reference,
      latestTransactionStatus: !charge ? "07" : charge.voided ? "05" : "00",
      ...(charge ? details(reference, charge) : {}),
    });
  }

  const server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const path = req.url ?? "";
      if (path === BCA_SNAP_TOKEN_PATH) return token(req, res);
      const auth = header(req, "Authorization");
      const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const timestamp = header(req, "X-TIMESTAMP");
      const signatureOk =
        header(req, "X-SIGNATURE") ===
        transactionSignature(options.clientSecret, {
          method: "POST",
          path,
          accessToken,
          body: text,
          timestamp,
        });
      const body = JSON.parse(text) as Record<string, unknown>;
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      requests.push({ path, headers, body, signatureOk });
      if (!tokens.has(accessToken))
        return reply(res, 401, { responseCode: "401IS01" });
      if (!signatureOk) return reply(res, 401, { responseCode: "401IS00" });
      const externalId = header(req, "X-EXTERNAL-ID");
      if (externalIds.has(externalId))
        return reply(res, 409, { responseCode: "409IS00" });
      externalIds.add(externalId);
      if (path === BCA_ECR_PAYMENT_PATH) return payment(res, body);
      if (path === BCA_ECR_INQUIRY_PATH) return inquiry(res, body);
      reply(res, 404, { responseCode: "404IS00" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** Every access token handed out (for the log checks). */
    issued,
    tokenRequests: () => tokenRequests,
    script(tid: string, scenario: BcaEcrScenario) {
      scenarios.set(tid, scenario);
    },
    /** BCA forgets every token (expired on its side). */
    expireTokens() {
      tokens.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type BcaEcrStub = Awaited<ReturnType<typeof startBcaEcrStub>>;
