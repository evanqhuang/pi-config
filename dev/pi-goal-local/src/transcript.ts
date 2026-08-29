import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_ENTRY_CHARS = 12_000;
const MAX_EVIDENCE_CHARS = 80_000;

function relevant(entry: SessionEntry): unknown {
  switch (entry.type) {
    case "message":
      return { type: "message", message: entry.message };
    case "custom_message":
      return { type: "custom_message", customType: entry.customType, content: entry.content };
    case "compaction":
      return { type: "compaction", summary: entry.summary };
    case "branch_summary":
      return { type: "branch_summary", summary: entry.summary };
    default:
      return undefined;
  }
}

export function buildGoalEvidence(entries: readonly SessionEntry[]): string {
  const chunks: string[] = [];
  for (const entry of entries) {
    const item = relevant(entry);
    if (item === undefined) continue;
    try { chunks.push(JSON.stringify(item).slice(0, MAX_ENTRY_CHARS)); } catch { /* ignore unserializable entry */ }
  }
  return chunks.join("\n").slice(-MAX_EVIDENCE_CHARS);
}

export function fingerprintEvidence(evidence: string): string {
  return createHash("sha256").update(evidence).digest("hex").slice(0, 32);
}
