import { describe, expect, it } from "vitest";
import { FernetError, fernetDecrypt, fernetEncrypt } from "../src/fernet";
import vectors from "./fixtures/fernet-vectors.json";

// Python -> Worker direction (the reverse is tests/test_crypto.py). Vectors: scripts/make-fernet-vectors*.
const { key, other_key: otherKey } = vectors;

const raw = (token: string) => Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("Fernet compatibility with Python cryptography", () => {
  it.each(vectors.python_tokens)("decrypts a Python token ($plaintext)", async ({ plaintext, token }) => {
    expect(await fernetDecrypt(token, key)).toBe(plaintext);
  });

  it.each(vectors.python_tokens)("re-encrypts to the identical bytes given Python's IV and time ($plaintext)", async ({ plaintext, token }) => {
    const bytes = raw(token);
    const now = Number(new DataView(bytes.buffer).getBigUint64(1)) * 1000;
    const iv = bytes.slice(9, 25);
    expect(await fernetEncrypt(plaintext, key, { now, iv })).toBe(token);
  });

  it("round-trips and never contains the plaintext", async () => {
    const t = await fernetEncrypt("access-sandbox-123", key);
    expect(t.startsWith("gAAAAA")).toBe(true);
    expect(t).not.toContain("access-sandbox");
    expect(await fernetDecrypt(t, key)).toBe("access-sandbox-123");
    expect(await fernetEncrypt("same", key)).not.toBe(await fernetEncrypt("same", key));   // random IV
  });

  it("rejects the wrong key, tampering and junk without leaking the token", async () => {
    const token = vectors.python_tokens[0].token;
    await expect(fernetDecrypt(token, otherKey)).rejects.toThrow(FernetError);
    const flipped = token.slice(0, 40) + (token[40] === "A" ? "B" : "A") + token.slice(41);
    await expect(fernetDecrypt(flipped, key)).rejects.toThrow(FernetError);
    for (const junk of ["", "not-a-token", "gAAAAA", token.slice(0, -8)]) {
      await expect(fernetDecrypt(junk, key)).rejects.toThrow(FernetError);
    }
    await expect(fernetDecrypt(flipped, key)).rejects.not.toThrow(new RegExp(token.slice(0, 20)));
  });

  it("rejects a key that isn't 32 bytes", async () => {
    await expect(fernetEncrypt("x", "c2hvcnQ=")).rejects.toThrow(/32 url-safe base64/);
  });
});
