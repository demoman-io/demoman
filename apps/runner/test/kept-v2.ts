// A kept flow as `keep` writes it: the recipe, and its receipt beside it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type KeptReceipt,
  type KeptVideo,
  parseKept,
  parseReceipt,
  RECEIPT_DIR,
} from "@demoman/run-core";

export async function readKeptV2(
  repo: string,
  file: string,
): Promise<{ kept: KeptVideo; receipt: KeptReceipt; receiptFile: string }> {
  const parsed = parseKept(await readFile(join(repo, file), "utf8"), file);
  if (!parsed.ok) throw new Error(parsed.detail);
  const receiptFile = `${RECEIPT_DIR}/${file.split("/").at(-1)}`;
  const r = parseReceipt(
    await readFile(join(repo, receiptFile), "utf8"),
    receiptFile,
  );
  if (!r.ok) throw new Error(r.detail);
  return { kept: parsed.kept, receipt: r.receipt, receiptFile };
}
