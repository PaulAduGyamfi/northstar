import { createHash } from "node:crypto";
import type { CandidateId } from "@northstar/domain";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { MAX_FILE_BYTES, storedFile } from "./file-schema.js";

// Files an application sends (NS-227, APPLY-001): the only writer and reader of stored_file. The
// bytes never go into an event, span, log or error; callers see the hash and the size.

const SHA256 = /^[0-9a-f]{64}$/;

export type StoredFileRef = { sha256: string; byteSize: number };

// Stores the bytes inside the caller's transaction (the same bytes twice store one row) and gives
// their hash. Throws, with no bytes in the message, on an empty or oversize file.
export async function storeFileIn(
  tx: Pick<Db, "insert">,
  input: { candidateId: CandidateId; bytes: Uint8Array; contentType: "application/pdf" },
): Promise<StoredFileRef> {
  const byteSize = input.bytes.byteLength;
  if (byteSize === 0 || byteSize > MAX_FILE_BYTES) throw new Error("stored_file size out of range");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await tx
    .insert(storedFile)
    .values({
      candidateId: input.candidateId,
      sha256,
      contentType: input.contentType,
      byteSize,
      bytes: input.bytes,
    })
    .onConflictDoNothing({ target: [storedFile.candidateId, storedFile.sha256] });
  return { sha256, byteSize };
}

// The candidate's file with this hash, or null: the Apply Gateway's `readFile` port (the worker
// binds the candidate, #230), which re-hashes what it gets.
export async function readStoredFile(
  db: Pick<Db, "select">,
  candidateId: CandidateId,
  sha256: string,
): Promise<Uint8Array | null> {
  if (!SHA256.test(sha256)) return null;
  const [row] = await db
    .select({ bytes: storedFile.bytes })
    .from(storedFile)
    .where(and(eq(storedFile.candidateId, candidateId), eq(storedFile.sha256, sha256)))
    .limit(1);
  return row ? new Uint8Array(row.bytes) : null;
}
