// Backup crypto, Vaultaire-style: the drawn pattern is the key.
//
// The pattern never leaves the device as anything but its serialized
// form inside action calls (the server stores only a salted hash of it).
// Here the same serialized pattern feeds PBKDF2-HMAC-SHA-256 (200k
// rounds, random per-backup salt) to derive the backup keys, and every
// file is sealed under its own random nonce. The server stores only
// ciphertext plus the hash-chain ledger, so a backup package is useless
// without the exact pattern it was sealed with.
//
// Why no WebCrypto? Version 1 sealed files with AES-256-GCM through
// `crypto.subtle`, but WebCrypto's subtle API only exists in secure
// contexts — in the shell/webview this app actually runs in, it came
// back undefined and every backup died with "Cannot read properties of
// undefined (reading 'importKey')" (the user's report, 2026-10-30).
// Version 2 therefore uses a self-contained pure-TypeScript
// construction that works in any JavaScript environment:
//
//   master  = PBKDF2-HMAC-SHA-256(pattern, salt, 200k, 32 bytes)
//   encKey  = HMAC-SHA-256(master, "vault-backup-enc-v2")
//   macKey  = HMAC-SHA-256(master, "vault-backup-mac-v2")
//   stream block i = HMAC-SHA-256(encKey, nonce || uint32BE(i)), XORed
//   tag     = HMAC-SHA-256(macKey, nonce || ciphertext)  (encrypt-then-MAC)
//
// The tag is appended to each file's ciphertext and verified before
// decryption, so a wrong pattern or a tampered file is detected, never
// silently restored. Version 1 packages (AES-256-GCM) can still be
// opened when WebCrypto happens to be available; no v1 backup was ever
// successfully created in this vault (the chain is empty), so nothing
// in the wild depends on that path.
//
// Chain rule (shared with the server, which re-derives and enforces it):
//   blockHash = SHA-256(prevHash + ":" + createdAt + ":" + itemHashes.join(","))
// where itemHashes are the SHA-256 of each file's plain bytes, in vault
// order, and the first block's prevHash is 64 zero hex digits.

export const GENESIS_HASH = "0".repeat(64);
const KDF_ITERATIONS = 200_000;
export const BACKUP_CIPHER_V2 = "hmac-sha256-ctr-etm";

export interface BackupItemEntry {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  iv: string; // base64 nonce
  data: string; // base64 ciphertext (+ 32-byte auth tag for v2)
}

export interface BackupPackage {
  format: "vault-backup";
  version: 1 | 2;
  createdAt: string;
  kdf: { salt: string; iterations: number }; // salt is base64
  cipher?: string; // v2: BACKUP_CIPHER_V2; absent on v1 (AES-256-GCM)
  chain: { prevHash: string; blockHash: string };
  items: BackupItemEntry[];
}

export interface PlainBackupItem {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/* ------------------------------ byte helpers ------------------------------ */

import { bytesToBase64 } from "@hatch/space-sdk/client";

export { bytesToBase64 };

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  // Freshly allocated above, so this really is a plain ArrayBuffer.
  return copy.buffer as ArrayBuffer;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* --------------------------- pure SHA-256 --------------------------------- */
// Self-contained SHA-256 (FIPS 180-4) with a cloneable state so HMAC can
// precompute its pad states once and reuse them for every message —
// that is what keeps 200k PBKDF2 rounds fast enough in pure JS.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

class Sha256 {
  private state = new Uint32Array(SHA256_IV);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  clone(): Sha256 {
    const c = new Sha256();
    c.state.set(this.state);
    c.buf.set(this.buf);
    c.bufLen = this.bufLen;
    c.total = this.total;
    return c;
  }

  private compress(block: Uint8Array, off: number): void {
    const w = this.w;
    const s = this.state;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] =
        ((block[j]! << 24) |
          (block[j + 1]! << 16) |
          (block[j + 2]! << 8) |
          block[j + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0;
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = s[0]!;
    let b = s[1]!;
    let c = s[2]!;
    let d = s[3]!;
    let e = s[4]!;
    let f = s[5]!;
    let g = s[6]!;
    let h = s[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    s[0] = (s[0]! + a) >>> 0;
    s[1] = (s[1]! + b) >>> 0;
    s[2] = (s[2]! + c) >>> 0;
    s[3] = (s[3]! + d) >>> 0;
    s[4] = (s[4]! + e) >>> 0;
    s[5] = (s[5]! + f) >>> 0;
    s[6] = (s[6]! + g) >>> 0;
    s[7] = (s[7]! + h) >>> 0;
  }

  update(data: Uint8Array): this {
    this.total += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off += take;
      if (this.bufLen === 64) {
        this.compress(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.compress(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    return this;
  }

  digest(): Uint8Array {
    const c = this.clone();
    const total = c.total;
    const bitLenHi = Math.floor(total / 0x20000000) >>> 0;
    const bitLenLo = (total << 3) >>> 0;
    const padLen = c.bufLen < 56 ? 56 - c.bufLen : 120 - c.bufLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    pad[padLen] = (bitLenHi >>> 24) & 0xff;
    pad[padLen + 1] = (bitLenHi >>> 16) & 0xff;
    pad[padLen + 2] = (bitLenHi >>> 8) & 0xff;
    pad[padLen + 3] = bitLenHi & 0xff;
    pad[padLen + 4] = (bitLenLo >>> 24) & 0xff;
    pad[padLen + 5] = (bitLenLo >>> 16) & 0xff;
    pad[padLen + 6] = (bitLenLo >>> 8) & 0xff;
    pad[padLen + 7] = bitLenLo & 0xff;
    c.update(pad);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = c.state[i]!;
      out[i * 4] = (v >>> 24) & 0xff;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  return Array.from(sha256Bytes(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

export function blockHashInput(
  prevHash: string,
  createdAt: string,
  itemHashes: string[],
): string {
  return `${prevHash}:${createdAt}:${itemHashes.join(",")}`;
}

/* --------------------- HMAC-SHA-256 and PBKDF2 ---------------------------- */

class HmacSha256 {
  private inner: Sha256;
  private outer: Sha256;

  constructor(key: Uint8Array) {
    let k = key;
    if (k.length > 64) k = sha256Bytes(k);
    const ipad = new Uint8Array(64);
    const opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const kb = i < k.length ? k[i]! : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    this.inner = new Sha256().update(ipad);
    this.outer = new Sha256().update(opad);
  }

  mac(msg: Uint8Array): Uint8Array {
    const innerDigest = this.inner.clone().update(msg).digest();
    return this.outer.clone().update(innerDigest).digest();
  }
}

// PBKDF2-HMAC-SHA-256, yielding to the UI every few thousand rounds so
// the busy label stays alive during the 200k-round derivation.
async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Promise<Uint8Array> {
  const h = new HmacSha256(password);
  const out = new Uint8Array(dkLen);
  let produced = 0;
  let blockIndex = 1;
  while (produced < dkLen) {
    const first = new Uint8Array(salt.length + 4);
    first.set(salt, 0);
    first[salt.length] = (blockIndex >>> 24) & 0xff;
    first[salt.length + 1] = (blockIndex >>> 16) & 0xff;
    first[salt.length + 2] = (blockIndex >>> 8) & 0xff;
    first[salt.length + 3] = blockIndex & 0xff;
    let u = h.mac(first);
    const t = new Uint8Array(u);
    for (let i = 1; i < iterations; i++) {
      u = h.mac(u);
      for (let j = 0; j < 32; j++) t[j] = t[j]! ^ u[j]!;
      if (i % 4000 === 0) await yieldToUi();
    }
    const take = Math.min(32, dkLen - produced);
    out.set(t.subarray(0, take), produced);
    produced += take;
    blockIndex++;
  }
  return out;
}

interface BackupKeys {
  enc: HmacSha256;
  mac: HmacSha256;
}

async function deriveKeysFromSecret(
  secretText: string,
  salt: Uint8Array,
  iterations: number,
  encLabel: string,
  macLabel: string,
): Promise<BackupKeys> {
  const master = await pbkdf2Sha256(
    new TextEncoder().encode(secretText),
    salt,
    iterations,
    32,
  );
  const masterHmac = new HmacSha256(master);
  return {
    enc: new HmacSha256(masterHmac.mac(new TextEncoder().encode(encLabel))),
    mac: new HmacSha256(masterHmac.mac(new TextEncoder().encode(macLabel))),
  };
}

async function deriveBackupKeys(
  pattern: number[],
  salt: Uint8Array,
  iterations: number,
): Promise<BackupKeys> {
  return deriveKeysFromSecret(
    pattern.join("-"),
    salt,
    iterations,
    "vault-backup-enc-v2",
    "vault-backup-mac-v2",
  );
}

/* --------------------------------- random --------------------------------- */

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(buf);
    return buf;
  }
  // getRandomValues is available in far more contexts than subtle, so
  // this is a last resort only: it keeps backup functional rather than
  // crashing, at weaker randomness.
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

/* ------------------------- v2 seal / open per file ------------------------ */

const TAG_BYTES = 32;
const NONCE_BYTES = 16;

// XOR the plaintext with the HMAC keystream for this nonce. The same
// routine decrypts, since the keystream depends only on key + nonce.
async function applyKeystream(
  keys: BackupKeys,
  nonce: Uint8Array,
  input: Uint8Array,
): Promise<Uint8Array> {
  const out = new Uint8Array(input.length);
  const counter = new Uint8Array(4);
  let block = 0;
  for (let off = 0; off < input.length; off += 32) {
    counter[0] = (block >>> 24) & 0xff;
    counter[1] = (block >>> 16) & 0xff;
    counter[2] = (block >>> 8) & 0xff;
    counter[3] = block & 0xff;
    const stream = keys.enc.mac(concatBytes(nonce, counter));
    const take = Math.min(32, input.length - off);
    for (let j = 0; j < take; j++) out[off + j] = input[off + j]! ^ stream[j]!;
    block++;
    if (block % 4096 === 0) await yieldToUi();
  }
  return out;
}

async function sealFileV2(
  keys: BackupKeys,
  bytes: Uint8Array,
): Promise<{ iv: string; data: string }> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = await applyKeystream(keys, nonce, bytes);
  const tag = keys.mac.mac(concatBytes(nonce, cipher));
  return {
    iv: bytesToBase64(nonce),
    data: bytesToBase64(concatBytes(cipher, tag)),
  };
}

function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// Returns null when the auth tag does not verify — the pattern is not
// the one this file was sealed with, or the file was tampered with.
async function openFileV2(
  keys: BackupKeys,
  ivB64: string,
  dataB64: string,
): Promise<Uint8Array | null> {
  const nonce = base64ToBytes(ivB64);
  const sealed = base64ToBytes(dataB64);
  if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) return null;
  const cipher = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const expected = keys.mac.mac(concatBytes(nonce, cipher));
  if (!tagsEqual(expected, tag)) return null;
  return applyKeystream(keys, nonce, new Uint8Array(cipher));
}

/* --------------------- legacy v1 (WebCrypto AES-GCM) ---------------------- */

function getSubtle(): SubtleCrypto | undefined {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    return c?.subtle;
  } catch {
    return undefined;
  }
}

async function deriveKeyV1(
  subtle: SubtleCrypto,
  pattern: number[],
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(pattern.join("-"))),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/* ------------------------------ build package ----------------------------- */

export async function buildBackupPackage(args: {
  pattern: number[];
  prevHash: string;
  createdAt: string;
  files: PlainBackupItem[];
}): Promise<{ pkg: BackupPackage; totalSize: number }> {
  // Let the caller's busy label paint before the deliberately expensive
  // key derivation blocks the main thread in chunks.
  await yieldToUi();
  const salt = randomBytes(16);
  const keys = await deriveBackupKeys(args.pattern, salt, KDF_ITERATIONS);
  const items: BackupItemEntry[] = [];
  let totalSize = 0;
  for (const file of args.files) {
    const sha256 = await sha256HexOfBytes(file.bytes);
    const sealed = await sealFileV2(keys, file.bytes);
    items.push({
      name: file.name,
      mimeType: file.mimeType,
      size: file.bytes.length,
      sha256,
      iv: sealed.iv,
      data: sealed.data,
    });
    totalSize += file.bytes.length;
  }
  const blockHash = await sha256HexOfText(
    blockHashInput(
      args.prevHash,
      args.createdAt,
      items.map((i) => i.sha256),
    ),
  );
  return {
    pkg: {
      format: "vault-backup",
      version: 2,
      createdAt: args.createdAt,
      kdf: { salt: bytesToBase64(salt), iterations: KDF_ITERATIONS },
      cipher: BACKUP_CIPHER_V2,
      chain: { prevHash: args.prevHash, blockHash },
      items,
    },
    totalSize,
  };
}

/* ------------------------------ open package ------------------------------ */

export type OpenPackageResult =
  | {
      ok: true;
      createdAt: string;
      blockHash: string;
      prevHash: string;
      files: PlainBackupItem[];
    }
  | {
      ok: false;
      reason: "bad_format" | "wrong_pattern" | "tampered" | "unsupported";
    };

function isHexHash(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

// Decrypt and fully verify a backup package: the block hash must
// re-derive from the chain fields, every file's auth tag must verify
// under the pattern-derived keys, and every decrypted file must hash to
// the SHA-256 committed in its entry. Tag failure means the pattern is
// not the one this backup was sealed with.
export async function openBackupPackage(
  raw: unknown,
  pattern: number[],
): Promise<OpenPackageResult> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "bad_format" };
  }
  const pkg = raw as Partial<BackupPackage>;
  if (
    pkg.format !== "vault-backup" ||
    (pkg.version !== 1 && pkg.version !== 2) ||
    typeof pkg.createdAt !== "string" ||
    !pkg.kdf ||
    typeof pkg.kdf.salt !== "string" ||
    typeof pkg.kdf.iterations !== "number" ||
    !pkg.chain ||
    !isHexHash(pkg.chain.prevHash) ||
    !isHexHash(pkg.chain.blockHash) ||
    !Array.isArray(pkg.items)
  ) {
    return { ok: false, reason: "bad_format" };
  }
  const entries = pkg.items as BackupItemEntry[];
  for (const e of entries) {
    if (
      typeof e.name !== "string" ||
      typeof e.mimeType !== "string" ||
      typeof e.size !== "number" ||
      !isHexHash(e.sha256) ||
      typeof e.iv !== "string" ||
      typeof e.data !== "string"
    ) {
      return { ok: false, reason: "bad_format" };
    }
  }

  const expectedBlock = await sha256HexOfText(
    blockHashInput(
      pkg.chain.prevHash,
      pkg.createdAt,
      entries.map((e) => e.sha256),
    ),
  );
  if (expectedBlock !== pkg.chain.blockHash) {
    return { ok: false, reason: "tampered" };
  }

  const files: PlainBackupItem[] = [];

  if (pkg.version === 2) {
    if (pkg.cipher !== BACKUP_CIPHER_V2) {
      return { ok: false, reason: "bad_format" };
    }
    let keys: BackupKeys;
    try {
      keys = await deriveBackupKeys(
        pattern,
        base64ToBytes(pkg.kdf.salt),
        pkg.kdf.iterations,
      );
    } catch {
      return { ok: false, reason: "bad_format" };
    }
    for (const e of entries) {
      const bytes = await openFileV2(keys, e.iv, e.data);
      if (!bytes) return { ok: false, reason: "wrong_pattern" };
      if (bytes.length !== e.size) return { ok: false, reason: "tampered" };
      const digest = await sha256HexOfBytes(bytes);
      if (digest !== e.sha256) return { ok: false, reason: "tampered" };
      files.push({ name: e.name, mimeType: e.mimeType, bytes });
    }
    return {
      ok: true,
      createdAt: pkg.createdAt,
      blockHash: pkg.chain.blockHash,
      prevHash: pkg.chain.prevHash,
      files,
    };
  }

  // Version 1: AES-256-GCM through WebCrypto — only openable where
  // subtle exists. Where it does not, say so honestly instead of
  // misreporting the pattern as wrong.
  const subtle = getSubtle();
  if (!subtle) return { ok: false, reason: "unsupported" };
  let key: CryptoKey;
  try {
    key = await deriveKeyV1(
      subtle,
      pattern,
      base64ToBytes(pkg.kdf.salt),
      pkg.kdf.iterations,
    );
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  for (const e of entries) {
    let plain: ArrayBuffer;
    try {
      plain = await subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(e.iv)) },
        key,
        toArrayBuffer(base64ToBytes(e.data)),
      );
    } catch {
      return { ok: false, reason: "wrong_pattern" };
    }
    const bytes = new Uint8Array(plain);
    if (bytes.length !== e.size) return { ok: false, reason: "tampered" };
    const digest = await sha256HexOfBytes(bytes);
    if (digest !== e.sha256) return { ok: false, reason: "tampered" };
    files.push({ name: e.name, mimeType: e.mimeType, bytes });
  }
  return {
    ok: true,
    createdAt: pkg.createdAt,
    blockHash: pkg.chain.blockHash,
    prevHash: pkg.chain.prevHash,
    files,
  };
}

/* --------------------------- recovery phrase ------------------------------ */
// Vaultaire-style recovery: a 9-word phrase is the second way in when
// the pattern is forgotten.
//
//   phrase  = 9 words drawn at random from the 256-word list below
//             (one random byte per word: 72 bits of entropy, stretched
//             further by the 200k-round PBKDF2 below)
//   keys    = PBKDF2-HMAC-SHA-256(phrase, random salt, 200k), split
//             into enc/mac subkeys exactly like backup v2
//   envelope = the pattern itself, sealed with those keys (same
//             HMAC keystream + encrypt-then-MAC construction as v2)
//
// Only the envelope ciphertext is stored (server-side, on vault_meta);
// the phrase and its keys never leave the device. Opening the envelope
// with the phrase returns the pattern, and that pattern opens both the
// vault (the server re-verifies it as usual) and every backup sealed
// with it — so phrase recovery restores backups too, without the
// backups themselves needing a second key. A wrong word fails the auth
// tag, indistinguishable from a tampered envelope.
//
// Changing the pattern invalidates the envelope (it wraps the old
// pattern), so the server clears it on upgradePattern and the user
// makes a fresh phrase for the new pattern.

export const RECOVERY_WORD_COUNT = 9;
export const RECOVERY_CIPHER = BACKUP_CIPHER_V2;

// 256 common English words, all distinct, grouped so duplicates are
// easy to spot: animals, nature, food, house, objects, colours, body,
// verbs, months/seasons, places, jobs, qualities, clothing, music,
// play, and a closing miscellany — 16 per group.
export const RECOVERY_WORDS: readonly string[] = [
  // animals
  "bear", "bird", "cat", "deer", "dog", "duck", "eagle", "fish",
  "fox", "frog", "goat", "horse", "lion", "mouse", "owl", "wolf",
  // nature
  "beach", "cloud", "desert", "forest", "glacier", "hill", "island", "lake",
  "meadow", "mountain", "ocean", "rain", "river", "snow", "valley", "volcano",
  // food
  "apple", "banana", "barley", "bean", "berry", "carrot", "corn", "grape",
  "lemon", "mango", "melon", "onion", "peach", "pear", "rice", "tomato",
  // house
  "basket", "bath", "bed", "bench", "brick", "candle", "chair", "clock",
  "door", "fence", "garden", "hammer", "house", "kitchen", "ladder", "lamp",
  // objects
  "anchor", "arrow", "badge", "banner", "barrel", "bell", "bicycle", "book",
  "bottle", "box", "bucket", "button", "camera", "coin", "compass", "engine",
  // colours and materials
  "amber", "black", "blue", "bronze", "brown", "copper", "coral", "crimson",
  "gold", "gray", "green", "ivory", "jade", "orange", "pink", "silver",
  // body
  "arm", "beard", "bone", "cheek", "chest", "ear", "elbow", "eye",
  "finger", "foot", "hair", "hand", "head", "knee", "leg", "neck",
  // verbs
  "build", "carry", "catch", "climb", "cook", "dance", "draw", "drive",
  "fly", "jump", "learn", "read", "run", "sing", "swim", "walk",
  // months and seasons
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "autumn", "dawn", "evening", "morning",
  // places
  "airport", "barn", "bridge", "castle", "cave", "city", "farm", "harbor",
  "hotel", "library", "market", "museum", "park", "school", "station", "village",
  // jobs
  "actor", "artist", "baker", "captain", "chef", "clerk", "coach", "dancer",
  "doctor", "driver", "farmer", "guard", "judge", "pirate", "poet", "singer",
  // qualities
  "brave", "calm", "clever", "dream", "faith", "freedom", "gentle", "happy",
  "honest", "hope", "joy", "kind", "love", "luck", "peace", "proud",
  // clothing
  "belt", "boot", "cap", "coat", "dress", "glove", "hat", "jacket",
  "jeans", "pocket", "scarf", "shirt", "shoe", "skirt", "sock", "suit",
  // music
  "cello", "choir", "drum", "flute", "guitar", "harp", "horn", "jazz",
  "melody", "opera", "piano", "rhythm", "song", "trumpet", "violin", "voice",
  // play
  "ball", "bat", "chess", "dice", "game", "goal", "gym", "kite",
  "puzzle", "race", "skate", "ski", "soccer", "tennis", "toy", "yoga",
  // miscellany
  "bamboo", "beacon", "blossom", "canyon", "cedar", "crystal", "delta", "ember",
  "falcon", "galaxy", "lagoon", "marble", "nectar", "oasis", "pearl", "quartz",
];

const RECOVERY_WORD_SET = new Set(RECOVERY_WORDS);

export function generateRecoveryPhrase(): string[] {
  const indices = randomBytes(RECOVERY_WORD_COUNT);
  return Array.from(indices, (b) => RECOVERY_WORDS[b]!);
}

// Split free-typed input into words. Returns every token found; the
// caller checks the count and lets the envelope's auth tag judge
// correctness, so a word outside the list simply fails to open.
export function parseRecoveryPhrase(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

export function isRecoveryWord(word: string): boolean {
  return RECOVERY_WORD_SET.has(word);
}

export interface RecoveryEnvelope {
  format: "vault-recovery";
  version: 1;
  createdAt: string;
  kdf: { salt: string; iterations: number };
  cipher: string;
  iv: string;
  data: string;
}

export async function buildRecoveryEnvelope(args: {
  pattern: number[];
  phrase: string[];
  createdAt: string;
}): Promise<string> {
  await yieldToUi();
  const salt = randomBytes(16);
  const keys = await deriveKeysFromSecret(
    args.phrase.join(" "),
    salt,
    KDF_ITERATIONS,
    "vault-recovery-enc-v1",
    "vault-recovery-mac-v1",
  );
  const plain = new TextEncoder().encode(
    JSON.stringify({ pattern: args.pattern }),
  );
  const sealed = await sealFileV2(keys, plain);
  const envelope: RecoveryEnvelope = {
    format: "vault-recovery",
    version: 1,
    createdAt: args.createdAt,
    kdf: { salt: bytesToBase64(salt), iterations: KDF_ITERATIONS },
    cipher: RECOVERY_CIPHER,
    iv: sealed.iv,
    data: sealed.data,
  };
  return JSON.stringify(envelope);
}

export type OpenRecoveryResult =
  | { ok: true; pattern: number[] }
  | { ok: false; reason: "bad_format" | "wrong_phrase" };

// Open a recovery envelope with a phrase. The auth tag decides: any
// wrong word, wrong order, or tampering fails the same way, so the
// caller can honestly say only "this phrase does not open it".
export async function openRecoveryEnvelope(
  envelopeJson: string,
  phrase: string[],
): Promise<OpenRecoveryResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(envelopeJson);
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "bad_format" };
  }
  const env = raw as Partial<RecoveryEnvelope>;
  if (
    env.format !== "vault-recovery" ||
    env.version !== 1 ||
    env.cipher !== RECOVERY_CIPHER ||
    !env.kdf ||
    typeof env.kdf.salt !== "string" ||
    typeof env.kdf.iterations !== "number" ||
    typeof env.iv !== "string" ||
    typeof env.data !== "string"
  ) {
    return { ok: false, reason: "bad_format" };
  }
  let keys: BackupKeys;
  try {
    keys = await deriveKeysFromSecret(
      phrase.join(" "),
      base64ToBytes(env.kdf.salt),
      env.kdf.iterations,
      "vault-recovery-enc-v1",
      "vault-recovery-mac-v1",
    );
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  const plain = await openFileV2(keys, env.iv, env.data);
  if (!plain) return { ok: false, reason: "wrong_phrase" };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
      pattern?: unknown;
    };
    const p = parsed.pattern;
    if (
      !Array.isArray(p) ||
      p.length < 4 ||
      p.length > 25 ||
      !p.every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 24) ||
      new Set(p).size !== p.length
    ) {
      return { ok: false, reason: "bad_format" };
    }
    return { ok: true, pattern: p as number[] };
  } catch {
    return { ok: false, reason: "bad_format" };
  }
}
