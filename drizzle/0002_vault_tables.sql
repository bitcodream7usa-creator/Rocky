DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY,
  pattern_salt TEXT NOT NULL,
  pattern_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE vault_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
