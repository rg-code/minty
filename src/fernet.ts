/** Fernet (https://github.com/fernet/spec), byte-compatible with the reference implementation
 * (Python's `cryptography.fernet`; test/fixtures/fernet-vectors.json was generated with it).
 * token = base64url( 0x80 | timestamp u64 BE | IV 16 | AES-128-CBC(PKCS7) ciphertext | HMAC-SHA256 32 )
 * key   = base64url( signing key 16 | encryption key 16 )
 * Errors never include the token or the plaintext. */

export class FernetError extends Error {}

const VERSION = 0x80;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new FernetError("invalid base64");
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");   // keep "=" padding, as the spec does
}

interface Keys { sign: CryptoKey; encrypt: CryptoKey }
const keyCache = new Map<string, Promise<Keys>>();

function importKeys(key: string): Promise<Keys> {
  let keys = keyCache.get(key);
  if (!keys) {
    const raw = b64urlDecode(key.trim());
    if (raw.length !== 32) throw new FernetError("TOKEN_ENC_KEY must be 32 url-safe base64-encoded bytes");
    keys = Promise.all([
      crypto.subtle.importKey("raw", raw.slice(0, 16), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
      crypto.subtle.importKey("raw", raw.slice(16), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]),
    ]).then(([sign, encrypt]) => ({ sign, encrypt }));
    keyCache.set(key, keys);
  }
  return keys;
}

export async function fernetEncrypt(
  plaintext: string,
  key: string,
  opts: { now?: number; iv?: Uint8Array } = {},
): Promise<string> {
  const { sign, encrypt } = await importKeys(key);
  const iv = opts.iv ?? crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, encrypt, enc.encode(plaintext)));
  const body = new Uint8Array(1 + 8 + 16 + ciphertext.length);
  body[0] = VERSION;
  new DataView(body.buffer).setBigUint64(1, BigInt(Math.floor((opts.now ?? Date.now()) / 1000)));
  body.set(iv, 9);
  body.set(ciphertext, 25);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", sign, body));
  const token = new Uint8Array(body.length + 32);
  token.set(body);
  token.set(mac, body.length);
  return b64urlEncode(token);
}

/** No TTL check: stored Plaid access tokens don't expire. */
export async function fernetDecrypt(token: string, key: string): Promise<string> {
  const { sign, encrypt } = await importKeys(key);
  const data = b64urlDecode(token.trim());
  // version + timestamp + IV + at least one AES block + HMAC, ciphertext a whole number of blocks
  if (data.length < 1 + 8 + 16 + 16 + 32 || (data.length - 57) % 16 !== 0 || data[0] !== VERSION) {
    throw new FernetError("invalid token");
  }
  const body = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  if (!(await crypto.subtle.verify("HMAC", sign, mac, body))) throw new FernetError("invalid token");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: body.subarray(9, 25) }, encrypt, body.subarray(25));
    return dec.decode(plain);
  } catch {
    throw new FernetError("invalid token");
  }
}
