// Vault actions — one vault per pattern ("패턴마다 금고").
//
// Lock model: the pattern itself is never stored. Each vault row in
// vault_meta holds a random salt and SHA-256(salt + pattern) for its
// own pattern. Drawing a pattern opens exactly the vault whose hash it
// matches: the server tries the drawn pattern against every vault's
// salt (vault counts are small, and each check is one SHA-256), and a
// pattern that matches nothing is simply "no vault yet" — the client
// can then offer to create a new vault with that very pattern. Every
// content action takes the drawn pattern, resolves it to its vault,
// and only ever touches that vault's items and backup chain, so one
// vault's pattern reveals nothing about any other vault — not even
// their names. This is verify-only gating — the stored bytes are not
// encrypted with a pattern-derived key, and the UI says so plainly.
//
// Patterns live on a grid: vaults created before the 5x5 upgrade hold a
// 3x3 pattern (indices 0-8); new setups and upgrades use 5x5 (indices
// 0-24). getStatus reports the grid of the single existing vault when
// there is exactly one, so a legacy 3x3 vault stays openable; with
// several vaults the pad is 5x5.
//
// Backups are a hash chain per vault. The client encrypts every file
// with a key derived from that vault's pattern (PBKDF2 -> HMAC
// keystream, in the browser) and computes a block hash over the
// previous block's hash, the creation time, and each file's SHA-256.
// registerBackup re-derives that block hash on the server, refuses a
// block whose prevHash is not the chain head of the same vault, stores
// the encrypted package as a blob, and appends the ledger row. The
// server never sees the backup key or the plain files.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_BACKUP_BYTES = 512 * 1024 * 1024; // 512 MB per backup package

// Indices run 0-24 so one schema covers both the legacy 3x3 grid (0-8)
// and the current 5x5 grid (0-24). A pattern is 4+ distinct dots; the
// client enforces distinctness by construction.
const patternSchema = z
  .array(z.number().int().min(0).max(24))
  .min(4)
  .max(25);

const hexHash = z.string().regex(/^[0-9a-f]{64}$/);

const itemShape = z.object({
  id: z.number(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
});

const backupShape = z.object({
  id: z.number(),
  blockHash: z.string(),
  prevHash: z.string(),
  itemCount: z.number(),
  totalSize: z.number(),
  createdAt: z.string(),
});

const vaultShape = z.object({
  id: z.number(),
  name: z.string(),
  gridSize: z.number(),
  itemCount: z.number(),
  hasRecovery: z.boolean(),
  createdAt: z.string(),
});

const GENESIS_HASH = "0".repeat(64);

function serializePattern(pattern: number[]): string {
  return pattern.join("-");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The block-hash formula is shared with the client (client/src/backup.ts);
// both sides must produce byte-identical input strings.
function blockHashInput(
  prevHash: string,
  createdAt: string,
  itemHashes: string[],
): string {
  return `${prevHash}:${createdAt}:${itemHashes.join(",")}`;
}

type VaultMetaRow = typeof schema.vaultMeta.$inferSelect;

async function getAllMetas(ctx: Ctx): Promise<VaultMetaRow[]> {
  const db = ctx.db<typeof schema>();
  return db
    .select()
    .from(schema.vaultMeta)
    .orderBy(asc(schema.vaultMeta.id));
}

// Resolve a drawn pattern to the vault it opens. Each vault has its own
// salt, so the pattern is hashed once per vault until one matches.
// Returns null when no vault uses this pattern.
async function findVault(
  ctx: Ctx,
  pattern: number[],
): Promise<VaultMetaRow | null> {
  const metas = await getAllMetas(ctx);
  const serialized = serializePattern(pattern);
  for (const meta of metas) {
    const hash = await sha256Hex(`${meta.patternSalt}:${serialized}`);
    if (hash === meta.patternHash) return meta;
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const lockedError = { ok: false as const, error: "locked" as const };

export const Actions = {
  // The only action a locked client may call: how many vaults exist,
  // and on which grid the unlock pad should render. With exactly one
  // vault its stored grid is reported (a legacy 3x3 vault stays
  // openable); with none or several the pad is 5x5.
  getStatus: defineAction({
    description:
      "금고가 몇 개 존재하는지와 잠금 해제 패턴 패드의 격자 크기를 알려준다.",
    request: z.object({}),
    response: z.object({
      vaultCount: z.number(),
      gridSize: z.number(),
      hasRecovery: z.boolean(),
    }),
    async handler(ctx) {
      const metas = await getAllMetas(ctx);
      const only = metas.length === 1 ? metas[0] : undefined;
      return {
        vaultCount: metas.length,
        gridSize: only ? only.gridSize : 5,
        hasRecovery: metas.some((m) => m.recoveryEnvelope != null),
      };
    },
  }),

  // Create a new vault on the 5x5 grid with the drawn pattern. Refuses
  // when the pattern already opens an existing vault — that pattern is
  // taken. The first vault and every additional vault are created the
  // same way: one pattern, one vault.
  setupPattern: defineAction({
    description:
      "그린 패턴으로 새 금고를 만든다. 이미 다른 금고를 여는 패턴이면 거절한다.",
    request: z.object({
      pattern: patternSchema,
      name: z.string().trim().min(1).max(40).optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["pattern_taken"]).optional(),
      vaultId: z.number().optional(),
      vaultName: z.string().optional(),
    }),
    async handler(ctx, args) {
      const existing = await findVault(ctx, args.pattern);
      if (existing) return { ok: false, error: "pattern_taken" as const };
      const salt = randomHex(16);
      const hash = await sha256Hex(
        `${salt}:${serializePattern(args.pattern)}`,
      );
      const db = ctx.db<typeof schema>();
      const count = (await getAllMetas(ctx)).length;
      const name = args.name ?? `금고 ${count + 1}`;
      const inserted = await db
        .insert(schema.vaultMeta)
        .values({
          name,
          patternSalt: salt,
          patternHash: hash,
          gridSize: 5,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("setupPattern: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true as const, vaultId: row.id, vaultName: row.name };
    },
  }),

  // Verify a drawn pattern and report which vault it opens, if any.
  unlock: defineAction({
    description:
      "그린 패턴을 확인하고, 그 패턴이 여는 금고의 id와 이름을 알려준다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      vaultId: z.number().optional(),
      vaultName: z.string().optional(),
      gridSize: z.number().optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return { ok: false as const };
      return {
        ok: true as const,
        vaultId: meta.id,
        vaultName: meta.name,
        gridSize: meta.gridSize,
      };
    },
  }),

  // Re-key one vault to a new 5x5 pattern. The caller must prove the
  // vault's current pattern first; the new pattern must not already
  // open another vault. Afterwards only the new pattern opens this
  // vault, and backups encrypted under the old pattern stay sealed to
  // it.
  upgradePattern: defineAction({
    description:
      "현재 패턴을 확인한 뒤 이 금고의 패턴을 새 5x5 패턴으로 바꾼다.",
    request: z.object({
      pattern: patternSchema,
      newPattern: patternSchema,
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "pattern_taken"]).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const clash = await findVault(ctx, args.newPattern);
      if (clash && clash.id !== meta.id) {
        return { ok: false, error: "pattern_taken" as const };
      }
      const salt = randomHex(16);
      const hash = await sha256Hex(
        `${salt}:${serializePattern(args.newPattern)}`,
      );
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.vaultMeta)
        .set({
          patternSalt: salt,
          patternHash: hash,
          gridSize: 5,
          // The recovery envelope wraps the OLD pattern; keeping it
          // would hand back a pattern that no longer opens the vault.
          recoveryEnvelope: null,
          recoveryCreatedAt: null,
        })
        .where(eq(schema.vaultMeta.id, meta.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Rename the vault the pattern opens. Only someone who can open the
  // vault can rename it; other vaults' names stay hidden.
  renameVault: defineAction({
    description: "패턴으로 열린 금고의 이름을 바꾼다.",
    request: z.object({
      pattern: patternSchema,
      name: z.string().trim().min(1).max(40),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.vaultMeta)
        .set({ name: args.name })
        .where(eq(schema.vaultMeta.id, meta.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Delete the vault the pattern opens: its meta row, every item row
  // and backup block of that vault, and their blobs. Other vaults are
  // untouched. This is the per-vault counterpart of creating one vault
  // per pattern.
  deleteVault: defineAction({
    description:
      "패턴으로 열린 금고와 그 안의 파일·백업을 모두 삭제한다. 다른 금고는 그대로 둔다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
      remainingVaults: z.number().optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const items = await db
        .select()
        .from(schema.vaultItems)
        .where(eq(schema.vaultItems.vaultId, meta.id));
      const backups = await db
        .select()
        .from(schema.vaultBackups)
        .where(eq(schema.vaultBackups.vaultId, meta.id));
      for (const item of items) {
        await ctx.blobs.delete(item.blobKey);
      }
      for (const backup of backups) {
        await ctx.blobs.delete(backup.blobKey);
      }
      await db
        .delete(schema.vaultItems)
        .where(eq(schema.vaultItems.vaultId, meta.id));
      await db
        .delete(schema.vaultBackups)
        .where(eq(schema.vaultBackups.vaultId, meta.id));
      await db
        .delete(schema.vaultMeta)
        .where(eq(schema.vaultMeta.id, meta.id));
      const remaining = (await getAllMetas(ctx)).length;
      ctx.invalidateQueries();
      return { ok: true as const, remainingVaults: remaining };
    },
  }),

  // Store the recovery-phrase envelope for the vault the pattern
  // opens. The client seals the pattern under a phrase-derived key and
  // sends only ciphertext; the server validates the envelope's outer
  // shape (never its contents — it cannot read them) and stores it on
  // that vault's meta row. Requires the vault's current pattern, so
  // only the vault's owner can set or replace the phrase.
  setRecoveryEnvelope: defineAction({
    description:
      "패턴으로 열린 금고에 회복 문구 봉투(암호문)를 저장한다.",
    request: z.object({
      pattern: patternSchema,
      envelopeJson: z.string().min(1).max(8192),
      createdAt: z.string().min(1).max(64),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "bad_envelope"]).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.envelopeJson);
      } catch {
        return { ok: false, error: "bad_envelope" as const };
      }
      const env = parsed as Record<string, unknown> | null;
      if (
        typeof env !== "object" ||
        env === null ||
        env.format !== "vault-recovery" ||
        env.version !== 1 ||
        typeof env.iv !== "string" ||
        typeof env.data !== "string"
      ) {
        return { ok: false, error: "bad_envelope" as const };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.vaultMeta)
        .set({
          recoveryEnvelope: args.envelopeJson,
          recoveryCreatedAt: args.createdAt,
        })
        .where(eq(schema.vaultMeta.id, meta.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // Hand back every vault's recovery envelope. Deliberately NOT
  // pattern-gated: the whole point is reaching them when a pattern is
  // forgotten. Envelopes are ciphertext sealed under phrase-derived
  // keys, so returning them exposes nothing a phrase doesn't unlock;
  // the client tries each envelope with the typed phrase and the one
  // that opens names the pattern (and thus the vault).
  getRecoveryEnvelope: defineAction({
    description:
      "모든 금고의 회복 문구 봉투(암호문) 목록을 돌려준다. 봉투는 문구 없이는 열 수 없다.",
    request: z.object({}),
    response: z.object({
      hasRecovery: z.boolean(),
      envelopes: z.array(
        z.object({
          vaultId: z.number(),
          envelopeJson: z.string(),
          createdAt: z.string().optional(),
        }),
      ),
    }),
    async handler(ctx) {
      const metas = await getAllMetas(ctx);
      const envelopes = metas
        .filter((m) => m.recoveryEnvelope != null)
        .map((m) => ({
          vaultId: m.id,
          envelopeJson: m.recoveryEnvelope as string,
          createdAt: m.recoveryCreatedAt ?? undefined,
        }));
      return { hasRecovery: envelopes.length > 0, envelopes };
    },
  }),

  // Recovery status of just the vault the pattern opens, for the
  // unlocked recovery tab.
  getOwnRecovery: defineAction({
    description:
      "패턴으로 열린 금고 자신의 회복 문구 설정 상태를 알려준다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
      hasRecovery: z.boolean().optional(),
      envelopeJson: z.string().optional(),
      createdAt: z.string().optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      if (meta.recoveryEnvelope == null) {
        return { ok: true as const, hasRecovery: false as const };
      }
      return {
        ok: true as const,
        hasRecovery: true as const,
        envelopeJson: meta.recoveryEnvelope,
        createdAt: meta.recoveryCreatedAt ?? undefined,
      };
    },
  }),

  // Remove one vault's recovery phrase entirely. Pattern-gated:
  // deleting the second way in is an owner's decision.
  deleteRecoveryEnvelope: defineAction({
    description: "패턴으로 열린 금고의 회복 문구를 삭제한다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.vaultMeta)
        .set({ recoveryEnvelope: null, recoveryCreatedAt: null })
        .where(eq(schema.vaultMeta.id, meta.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listItems: defineAction({
    description: "패턴으로 열린 금고 안의 파일 목록을 돌려준다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
      items: z.array(itemShape).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultItems)
        .where(eq(schema.vaultItems.vaultId, meta.id))
        .orderBy(desc(schema.vaultItems.id));
      return {
        ok: true as const,
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  addItem: defineAction({
    description: "패턴으로 열린 금고에 파일 하나를 넣는다.",
    request: z.object({
      pattern: patternSchema,
      name: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(127),
      dataBase64: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "too_large"]).optional(),
      item: itemShape.optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const bytes = base64ToBytes(args.dataBase64);
      if (bytes.length > MAX_FILE_BYTES) {
        return { ok: false, error: "too_large" as const };
      }
      const blobKey = `vault/${Date.now()}-${randomHex(8)}`;
      await ctx.blobs.put(blobKey, bytes, { contentType: args.mimeType });
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.vaultItems)
        .values({
          vaultId: meta.id,
          name: args.name,
          mimeType: args.mimeType,
          size: bytes.length,
          blobKey,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addItem: insert returned no rows");
      ctx.invalidateQueries();
      return {
        ok: true as const,
        item: {
          id: row.id,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          createdAt: row.createdAt.toISOString(),
        },
      };
    },
  }),

  // Content access for viewing, exporting, and thumbnails. Only ever
  // returns a URL after the pattern checks out, and only for items of
  // the vault that pattern opens.
  getItemUrl: defineAction({
    description:
      "패턴으로 열린 금고 안 파일 하나의 보기용 주소를 돌려준다.",
    request: z.object({
      pattern: patternSchema,
      id: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "not_found"]).optional(),
      url: z.string().optional(),
      name: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultItems)
        .where(
          and(
            eq(schema.vaultItems.id, args.id),
            eq(schema.vaultItems.vaultId, meta.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" as const };
      const url = await ctx.blobs.getUrl(row.blobKey);
      return { ok: true as const, url, name: row.name, mimeType: row.mimeType };
    },
  }),

  // Raw bytes of one vault file, returned through the action channel.
  // The backup flow needs every file's plain bytes in the browser to
  // encrypt them; fetching them through the blob URL (getItemUrl) is a
  // separate, fragile round-trip, so the bytes are read straight from
  // the blob store by the host-side privileged helper instead. Same
  // trust level as getItemUrl: nothing is returned until the pattern
  // checks out.
  getItemData: defineAction({
    description:
      "패턴으로 열린 금고 안 파일 하나의 원본 바이트를 돌려준다.",
    request: z.object({
      pattern: patternSchema,
      id: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "not_found", "read_failed"]).optional(),
      dataBase64: z.string().optional(),
      name: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    privileged: [privileged.readBlobBytes],
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultItems)
        .where(
          and(
            eq(schema.vaultItems.id, args.id),
            eq(schema.vaultItems.vaultId, meta.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" as const };
      try {
        const { dataBase64 } = await ctx.executePrivileged(
          privileged.readBlobBytes,
          { spaceDir: ctx.spaceDir, key: row.blobKey },
        );
        return {
          ok: true as const,
          dataBase64,
          name: row.name,
          mimeType: row.mimeType,
        };
      } catch {
        return { ok: false, error: "read_failed" as const };
      }
    },
  }),

  deleteItem: defineAction({
    description: "패턴으로 열린 금고에서 파일 하나를 삭제한다.",
    request: z.object({
      pattern: patternSchema,
      id: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "not_found"]).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultItems)
        .where(
          and(
            eq(schema.vaultItems.id, args.id),
            eq(schema.vaultItems.vaultId, meta.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" as const };
      await ctx.blobs.delete(row.blobKey);
      await db
        .delete(schema.vaultItems)
        .where(eq(schema.vaultItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // The backup chain of the vault the pattern opens, oldest block
  // first. A locked client gets nothing.
  listBackups: defineAction({
    description: "패턴으로 열린 금고의 백업 체인 목록을 돌려준다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
      backups: z.array(backupShape).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultBackups)
        .where(eq(schema.vaultBackups.vaultId, meta.id))
        .orderBy(asc(schema.vaultBackups.id));
      return {
        ok: true as const,
        backups: rows.map((row) => ({
          id: row.id,
          blockHash: row.blockHash,
          prevHash: row.prevHash,
          itemCount: row.itemCount,
          totalSize: row.totalSize,
          createdAt: row.createdAt,
        })),
      };
    },
  }),

  // Append one block to this vault's backup chain. The block only
  // lands if its prevHash is the current chain head of the same vault
  // and its blockHash re-derives from the committed data — a tampered
  // or out-of-order package is refused.
  registerBackup: defineAction({
    description:
      "암호화된 백업 패키지를 검증해 이 금고의 백업 체인에 새 블록으로 기록한다.",
    request: z.object({
      pattern: patternSchema,
      createdAt: z.string().min(1).max(64),
      prevHash: hexHash,
      blockHash: hexHash,
      itemHashes: z.array(hexHash).max(100000),
      totalSize: z.number().int().nonnegative(),
      // The encrypted package travels as its raw JSON text, not wrapped
      // in another base64 layer: the extra encoding inflated every
      // backup by a third for no benefit.
      packageJson: z.string().min(1).max(64 * 1024 * 1024),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z
        .enum(["locked", "chain_mismatch", "bad_hash", "too_large"])
        .optional(),
      backup: backupShape.optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultBackups)
        .where(eq(schema.vaultBackups.vaultId, meta.id))
        .orderBy(desc(schema.vaultBackups.id))
        .limit(1);
      const head = rows[0]?.blockHash ?? GENESIS_HASH;
      if (args.prevHash !== head) {
        return { ok: false, error: "chain_mismatch" as const };
      }
      const expected = await sha256Hex(
        blockHashInput(args.prevHash, args.createdAt, args.itemHashes),
      );
      if (expected !== args.blockHash) {
        return { ok: false, error: "bad_hash" as const };
      }
      const bytes = new TextEncoder().encode(args.packageJson);
      if (bytes.length > MAX_BACKUP_BYTES) {
        return { ok: false, error: "too_large" as const };
      }
      const blobKey = `backups/${args.blockHash}`;
      await ctx.blobs.put(blobKey, bytes, {
        contentType: "application/json",
      });
      const inserted = await db
        .insert(schema.vaultBackups)
        .values({
          vaultId: meta.id,
          blockHash: args.blockHash,
          prevHash: args.prevHash,
          itemCount: args.itemHashes.length,
          totalSize: args.totalSize,
          blobKey,
          createdAt: args.createdAt,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("registerBackup: insert returned no rows");
      ctx.invalidateQueries();
      return {
        ok: true as const,
        backup: {
          id: row.id,
          blockHash: row.blockHash,
          prevHash: row.prevHash,
          itemCount: row.itemCount,
          totalSize: row.totalSize,
          createdAt: row.createdAt,
        },
      };
    },
  }),

  // Download URL for a stored backup package of this vault. The
  // package is ciphertext; only the pattern it was sealed with can
  // open it.
  getBackupUrl: defineAction({
    description:
      "패턴으로 열린 금고의 백업 패키지 하나에 대한 내려받기 주소를 돌려준다.",
    request: z.object({
      pattern: patternSchema,
      id: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "not_found"]).optional(),
      url: z.string().optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultBackups)
        .where(
          and(
            eq(schema.vaultBackups.id, args.id),
            eq(schema.vaultBackups.vaultId, meta.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" as const };
      const url = await ctx.blobs.getUrl(row.blobKey);
      return { ok: true as const, url };
    },
  }),

  // Raw bytes of a stored backup package, through the action channel.
  // Mobile browsers and in-app webviews frequently block or ignore a
  // programmatic <a download> click against a remote blob URL (the
  // user's "모바일에서 다운로드가 안 됨" report), so the client pulls
  // the package bytes this way and saves them locally with a blob URL
  // or the Web Share sheet instead. Same gating as getBackupUrl:
  // nothing is returned until the pattern checks out, and the package
  // itself is ciphertext.
  getBackupData: defineAction({
    description:
      "패턴으로 열린 금고의 백업 패키지 하나의 원본 바이트를 돌려준다.",
    request: z.object({
      pattern: patternSchema,
      id: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked", "not_found", "read_failed"]).optional(),
      dataBase64: z.string().optional(),
      createdAt: z.string().optional(),
    }),
    privileged: [privileged.readBlobBytes],
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.vaultBackups)
        .where(
          and(
            eq(schema.vaultBackups.id, args.id),
            eq(schema.vaultBackups.vaultId, meta.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, error: "not_found" as const };
      try {
        const { dataBase64 } = await ctx.executePrivileged(
          privileged.readBlobBytes,
          { spaceDir: ctx.spaceDir, key: row.blobKey },
        );
        return { ok: true as const, dataBase64, createdAt: row.createdAt };
      } catch {
        return { ok: false, error: "read_failed" as const };
      }
    },
  }),

  // The vaults the caller can prove: given one vault's pattern, list
  // every vault's summary (name, size, file count). Knowing one
  // pattern is the credential — the locked screen still shows nothing
  // but a count. Used by the in-vault "다른 금고" view to switch vaults
  // without re-drawing from memory alone.
  listVaults: defineAction({
    description:
      "패턴으로 열린 금고가 있으면, 모든 금고의 이름과 파일 수 요약을 돌려준다.",
    request: z.object({ pattern: patternSchema }),
    response: z.object({
      ok: z.boolean(),
      error: z.enum(["locked"]).optional(),
      currentVaultId: z.number().optional(),
      vaults: z.array(vaultShape).optional(),
    }),
    async handler(ctx, args) {
      const meta = await findVault(ctx, args.pattern);
      if (!meta) return lockedError;
      const db = ctx.db<typeof schema>();
      const metas = await getAllMetas(ctx);
      const vaults: z.infer<typeof vaultShape>[] = [];
      for (const m of metas) {
        const items = await db
          .select()
          .from(schema.vaultItems)
          .where(eq(schema.vaultItems.vaultId, m.id));
        vaults.push({
          id: m.id,
          name: m.name,
          gridSize: m.gridSize,
          itemCount: items.length,
          hasRecovery: m.recoveryEnvelope != null,
          createdAt: m.createdAt.toISOString(),
        });
      }
      return { ok: true as const, currentVaultId: meta.id, vaults };
    },
  }),

  // The app's own source code, for the in-app code viewer the user
  // asked for. This is the application's code, not vault content, so it
  // is not pattern-gated; the files are read verbatim from the
  // artifact's directory by the host-side privileged helper, so the
  // viewer always shows the code that is actually running.
  getSourceCode: defineAction({
    description:
      "앱 안에서 코드 탭으로 보여줄 이 앱 자체의 소스 코드 파일들을 읽어 돌려준다.",
    request: z.object({}),
    response: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          ok: z.boolean(),
          content: z.string(),
        }),
      ),
    }),
    privileged: [privileged.readSourceFiles],
    async handler(ctx) {
      const paths = [
        "client/src/App.tsx",
        "client/src/backup.ts",
        "client/src/api.ts",
        "client/src/main.tsx",
        "client/src/theme.css",
        "client/index.html",
        "server/src/actions.ts",
        "server/src/privileged.ts",
        "server/src/schema.ts",
        "drizzle/0002_vault_tables.sql",
        "drizzle/0003_grid_size_and_backup_chain.sql",
        "drizzle/0004_add_recovery_envelope.sql",
        "drizzle/0005_multi_vaults_per_pattern.sql",
        "DATA-PLAN.md",
        "space.json",
      ];
      const { files } = await ctx.executePrivileged(
        privileged.readSourceFiles,
        { spaceDir: ctx.spaceDir, paths },
      );
      return { files };
    },
  }),
} satisfies ActionsModule;
