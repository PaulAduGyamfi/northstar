import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A fake WebAuthn authenticator for tests (NS-178): a real P-256 key made with node:crypto, and
// the bytes a browser would hand over for registration ("none" attestation) and sign-in, built by
// hand. No browser, device or network. Shapes follow the WebAuthn Level 2 spec, §6.1 and §6.5.

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

// The CBOR header of a major type and a length or value (RFC 8949 §3).
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65_536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

// Just enough CBOR for an attestation object and a COSE key.
function cbor(v: CborValue): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const text = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts = [...v].flatMap(([k, val]) => [cbor(k), cbor(val)]);
  return Buffer.concat([head(5, v.size), ...parts]);
}

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const b64u = (data: Buffer): string => data.toString("base64url");
const counterBytes = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};

// Authenticator data flags.
const UP = 0x01; // user present
const UV = 0x04; // user verified
const AT = 0x40; // attested credential data included

export type FakeAuthenticator = ReturnType<typeof fakeAuthenticator>;

// `counting: false` behaves like a platform passkey, whose sign count is always 0.
export function fakeAuthenticator(opts: { rpId: string; origin: string; counting?: boolean }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32);
  // COSE_Key for ES256 (RFC 9053): kty EC2, alg -7, crv P-256, x, y.
  const coseKey = new Map<CborValue, CborValue>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x ?? "", "base64url")],
    [-3, Buffer.from(jwk.y ?? "", "base64url")],
  ]);
  let counter = 0;
  const id = b64u(credentialId);

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");

  return {
    credentialId: id,

    // What navigator.credentials.create() would return, as JSON.
    register(challenge: string, over: { origin?: string; userVerified?: boolean } = {}) {
      const flags = UP | AT | (over.userVerified === false ? 0 : UV);
      const authData = Buffer.concat([
        sha256(opts.rpId),
        Buffer.from([flags]),
        counterBytes(counter),
        Buffer.alloc(16), // AAGUID: zeros for "none" attestation
        Buffer.from([credentialId.length >> 8, credentialId.length & 255]),
        credentialId,
        cbor(coseKey),
      ]);
      const attestationObject = cbor(
        new Map<CborValue, CborValue>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key" as const,
        response: {
          clientDataJSON: b64u(
            clientData("webauthn.create", challenge, over.origin ?? opts.origin),
          ),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },

    // What navigator.credentials.get() would return, as JSON. `counter` forces a sign count.
    signIn(
      challenge: string,
      over: { origin?: string; counter?: number; userVerified?: boolean } = {},
    ) {
      if (over.counter !== undefined) counter = over.counter;
      else if (opts.counting !== false) counter += 1;
      const authenticatorData = Buffer.concat([
        sha256(opts.rpId),
        Buffer.from([UP | (over.userVerified === false ? 0 : UV)]),
        counterBytes(counter),
      ]);
      const clientDataJSON = clientData("webauthn.get", challenge, over.origin ?? opts.origin);
      // ECDSA over authenticatorData || SHA-256(clientDataJSON); node returns it DER-encoded.
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key" as const,
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authenticatorData),
          signature: b64u(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}
