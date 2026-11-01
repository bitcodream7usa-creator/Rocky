// Drizzle schema for the vault artifact.
//
// vault_meta holds one row per vault, each with the salted hash of that
// vault's own lock pattern. The pattern itself is never stored. Every
// pattern opens exactly the vault it was set on ("패턴마다 금고"): the
// server finds the vault by trying the drawn pattern against every
// row's salt, and a pattern that matches nothing can become a new
// vault. Until at least one row exists the client shows the setup flow.
// Each vault also carries a user-chosen name so several vaults can be
// told apart once one of them is open.
//
// vault_items is the file metadata; the file bytes live in ctx.blobs under
// blob_key. Rows are only ever returned by actions after the caller proves
// knowledge of the pattern, so a locked vault exposes nothing but the fact
// that a pattern exists.
//
// vault_meta.grid_size records which grid the stored pattern was drawn on:
// patterns set before the 5x5 upgrade are 3x3 (column default), everything
// set or upgraded since is 5x5. The client renders the unlock pad at the
// stored size so an existing vault can still be opened, then offers the
// upgrade to 5x5.
//
// vault_backups is the backup chain ledger. Each row is one backup "block":
// its block_hash commits to the previous block's hash, the backup's
// creation time, and the SHA-256 of every file inside, so editing any
// earlier block or any backed-up file breaks every later hash. The
// encrypted backup package itself lives in ctx.blobs under blob_key; the
// encryption key is derived from the pattern on the client and never
// reaches the server.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const vaultMeta = sqliteTable("vault_meta", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().default("내 금고"),
  patternSalt: text("pattern_salt").notNull(),
  patternHash: text("pattern_hash").notNull(),
  gridSize: integer("grid_size").notNull().default(3),
  // Recovery-phrase envelope (Vaultaire-style): the client seals the
  // pattern itself under a key derived from the 9-word recovery phrase
  // and stores only that ciphertext here. The server never sees the
  // phrase or its key, so the envelope is useless without the phrase —
  // and the phrase alone, plus this envelope, recovers the pattern
  // (and with it the vault and every pattern-sealed backup). Null until
  // the user creates a phrase; cleared whenever the pattern changes,
  // because the old envelope wraps the old pattern.
  recoveryEnvelope: text("recovery_envelope"),
  recoveryCreatedAt: text("recovery_created_at"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const vaultBackups = sqliteTable("vault_backups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Each vault keeps its own independent backup chain: the chain head
  // is the newest block of the same vault, never another vault's.
  vaultId: integer("vault_id").notNull().default(1),
  blockHash: text("block_hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  itemCount: integer("item_count").notNull(),
  totalSize: integer("total_size").notNull(),
  blobKey: text("blob_key").notNull(),
  createdAt: text("created_at").notNull(),
});

export const vaultItems = sqliteTable("vault_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The vault this file belongs to. Items are only ever listed or read
  // through the owning vault's pattern.
  vaultId: integer("vault_id").notNull().default(1),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  blobKey: text("blob_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
