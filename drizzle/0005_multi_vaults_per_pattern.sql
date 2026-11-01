ALTER TABLE vault_meta ADD COLUMN name TEXT NOT NULL DEFAULT '내 금고';
--> statement-breakpoint
ALTER TABLE vault_items ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE vault_backups ADD COLUMN vault_id INTEGER NOT NULL DEFAULT 1;
