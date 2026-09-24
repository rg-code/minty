// Worker -> Python direction of the Fernet vectors: encrypt with src/fernet.ts (WebCrypto) and
// store the tokens in test/fixtures/fernet-vectors.json; tests/test_crypto.py decrypts them with
// Python's cryptography. Run from the repo root:  node scripts/make-fernet-vectors-worker.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fernetEncrypt } from "../src/fernet.ts";

const path = new URL("../test/fixtures/fernet-vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(path, "utf8"));
vectors.worker_tokens = [];
for (const { plaintext } of vectors.python_tokens) {
  vectors.worker_tokens.push({ plaintext, token: await fernetEncrypt(plaintext, vectors.key) });
}
writeFileSync(path, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${vectors.worker_tokens.length} worker tokens`);
