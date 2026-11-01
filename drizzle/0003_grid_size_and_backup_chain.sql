ALTER TABLE vault_meta ADD COLUMN grid_size INTEGER NOT NULL DEFAULT 3;
--> statement-breakpoint
CREATE TABLE vault_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  total_size INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
