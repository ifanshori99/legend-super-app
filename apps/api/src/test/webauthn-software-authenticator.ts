// Test-only software WebAuthn authenticator (legend-jemg). Produces real
// registration (fmt "none") and assertion payloads per W3C WebAuthn L2 so the
// API's verification is exercised end to end without a browser. Written from
// the spec (authenticatorData layout, COSE ES256 key, clientDataJSON), not from
// the API implementation. Not a *.test.ts file, so vitest does not collect it.

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export const b64u = (buf: Buffer): string => buf.toString("base64url");

// ---- minimal CBOR (only what a COSE key + "none" attestation object need)
function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(value, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === "number")
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([cborHead(2, value.length), value]);
  const parts: Buffer[] = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

export type SoftwareAuthenticator = {
  credentialId: Buffer;
  publicKey: KeyObject;
  privateKey: KeyObject;
};

export function createSoftwareAuthenticator(): SoftwareAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return { credentialId: randomBytes(32), publicKey, privateKey };
}

const rpIdHash = (rpId: string): Buffer =>
  createHash("sha256").update(rpId, "utf8").digest();

function counterBytes(counter: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(counter);
  return b;
}

function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    "utf8",
  );
}

type CredentialOptions = {
  /** base64url challenge exactly as the server issued it */
  challenge: string;
  rpId: string;
  origin: string;
};

/** RegistrationResponseJSON (WebAuthn L3 JSON form) for a "none" attestation. */
export function registrationResponse(
  authenticator: SoftwareAuthenticator,
  options: CredentialOptions & { counter?: number },
) {
  const jwk = authenticator.publicKey.export({ format: "jwk" });
  const cose = new Map<Cbor, Cbor>([
    [1, 2], // kty EC2
    [3, -7], // alg ES256
    [-1, 1], // crv P-256
    [-2, Buffer.from(jwk.x as string, "base64url")],
    [-3, Buffer.from(jwk.y as string, "base64url")],
  ]);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(authenticator.credentialId.length);
  const authData = Buffer.concat([
    rpIdHash(options.rpId),
    Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
    counterBytes(options.counter ?? 0),
    Buffer.alloc(16), // aaguid
    credIdLen,
    authenticator.credentialId,
    cbor(cose),
  ]);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map<Cbor, Cbor>()],
      ["authData", authData],
    ]),
  );
  const id = b64u(authenticator.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64u(
        clientData("webauthn.create", options.challenge, options.origin),
      ),
      attestationObject: b64u(attestationObject),
      transports: ["internal" as const],
    },
    clientExtensionResults: {},
  };
}

/** AuthenticationResponseJSON (WebAuthn L3 JSON form) with an ES256 signature. */
export function assertionResponse(
  authenticator: SoftwareAuthenticator,
  options: CredentialOptions & { counter: number },
) {
  const authData = Buffer.concat([
    rpIdHash(options.rpId),
    Buffer.from([FLAG_UP | FLAG_UV]),
    counterBytes(options.counter),
  ]);
  const clientDataJSON = clientData(
    "webauthn.get",
    options.challenge,
    options.origin,
  );
  const signature = createSign("SHA256")
    .update(
      Buffer.concat([
        authData,
        createHash("sha256").update(clientDataJSON).digest(),
      ]),
    )
    .sign(authenticator.privateKey); // DER, as WebAuthn expects for ES256
  const id = b64u(authenticator.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
    },
    clientExtensionResults: {},
  };
}
