// Host-side helpers for the vault actions.
//
// Two jobs need real filesystem access that the portable action worker
// does not have:
//
// 1. readBlobBytes — hand a stored vault file's raw bytes back to the
//    pattern-verified owner through the action channel. Backup creation
//    used to fetch the blob through its `./blobs/<token>` URL from the
//    browser instead, and failed end-to-end (the user's "백업이 안됨"
//    report: the chain stayed empty and the UI only showed its generic
//    catch-all error, i.e. an exception path, while addItem uploads of
//    the same files through the action channel worked). Reading the
//    object straight from the blob store keeps the whole backup flow
//    on the channel that is proven to work, and the client now names
//    the failing step if anything still goes wrong.
//    Blob objects live under a sha256-sharded id (see the runtime's
//    blobs.ts): objects/<id[0..2]>/<id> where id = SHA-256 of the blob
//    key; pre-migration objects may still sit at objects/<key>, so fall
//    back to that path.
//
// 2. readSourceFiles — the in-app code viewer. The user asked to see
//    this app's own source; the handler reads the artifact's actual
//    source files from its directory and returns them verbatim, so what
//    the app shows is always the code that is really there. Only the
//    fixed relative paths the action passes are read, and any path that
//    tries to escape the artifact directory is refused.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  readBlobBytes: {
    request: z.object({
      spaceDir: z.string().min(1),
      key: z.string().min(1),
    }),
    response: z.object({
      dataBase64: z.string(),
    }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30_000,
  },
  readSourceFiles: {
    request: z.object({
      spaceDir: z.string().min(1),
      paths: z.array(z.string().min(1)).max(32),
    }),
    response: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          ok: z.boolean(),
          content: z.string(),
        }),
      ),
    }),
    capabilities: ["filesystem.read"],
    timeoutMs: 30_000,
  },
});

function blobObjectId(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function readBlob(spaceDir: string, key: string): Promise<Buffer> {
  const root =
    process.env.HATCH_SPACE_BLOB_DIR?.trim() || join(spaceDir, "blobs");
  const id = blobObjectId(key);
  try {
    return await readFile(join(root, "objects", id.slice(0, 2), id));
  } catch {
    // Legacy layout: objects stored directly under their key.
    return await readFile(join(root, "objects", key));
  }
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async readBlobBytes(args) {
    const bytes = await readBlob(args.spaceDir, args.key);
    return { dataBase64: bytes.toString("base64") };
  },

  async readSourceFiles(args) {
    const root = resolve(args.spaceDir);
    const files: { path: string; ok: boolean; content: string }[] = [];
    for (const path of args.paths) {
      const target = resolve(root, path);
      if (target !== root && !target.startsWith(root + sep)) {
        files.push({ path, ok: false, content: "" });
        continue;
      }
      try {
        const content = await readFile(target, "utf8");
        files.push({ path, ok: true, content });
      } catch {
        files.push({ path, ok: false, content: "" });
      }
    }
    return { files };
  },
});
