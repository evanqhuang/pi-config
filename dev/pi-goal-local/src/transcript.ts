import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  GOAL_CONTINUE_MESSAGE,
  GOAL_START_MESSAGE,
  GOAL_STATUS_MESSAGE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
} from "./types.js";

const MAX_ENTRY_CHARS = 12_000;
const MAX_EVIDENCE_CHARS = 80_000;
const PROGRESS_BOUNDARIES = new Set([GOAL_START_MESSAGE, GOAL_CONTINUE_MESSAGE]);
const GOAL_INTERNAL_MESSAGES = new Set([
  GOAL_START_MESSAGE,
  GOAL_CONTINUE_MESSAGE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
  GOAL_STATUS_MESSAGE,
]);

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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function customType(item: Record<string, unknown>): string | undefined {
  if (item.type === "custom_message") {
    return typeof item.customType === "string" ? item.customType : undefined;
  }
  if (item.type !== "message") return undefined;
  const message = record(item.message);
  return message?.role === "custom" && typeof message.customType === "string"
    ? message.customType
    : undefined;
}

function stableContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const result: unknown[] = [];
  for (const block of content) {
    const value = record(block);
    if (!value) {
      result.push(block);
      continue;
    }
    if (value.type === "thinking") continue;
    if (value.type === "toolCall") {
      const { id: _id, ...stable } = value;
      result.push(stable);
      continue;
    }
    result.push(value);
  }
  return result;
}

function stableEvidenceItem(item: Record<string, unknown>): unknown {
  if (item.type !== "message") return item;
  const message = record(item.message);
  if (!message) return item;

  const {
    timestamp: _timestamp,
    usage: _usage,
    provider: _provider,
    model: _model,
    api: _api,
    toolCallId: _toolCallId,
    ...stable
  } = message;
  if ("content" in stable) stable.content = stableContent(stable.content);
  return { type: "message", message: stable };
}

/**
 * Fingerprint only the work produced since the latest goal start/continuation.
 *
 * The controller passes cumulative goal evidence. Hashing that raw transcript
 * means every loop looks like progress merely because another continuation,
 * timestamp, usage object, or tool-call ID was appended. Strip those volatile
 * fields and reset at the latest goal-owned work boundary so identical repeated
 * work produces the same fingerprint and the no-progress budget can actually
 * stop an autonomous loop.
 */
export function fingerprintEvidence(evidence: string): string {
  let sawBoundary = false;
  let segment: string[] = [];

  for (const line of evidence.split("\n")) {
    if (!line) continue;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(line)); } catch { /* preserve malformed/truncated evidence below */ }

    if (!parsed) {
      segment.push(line);
      continue;
    }

    const type = customType(parsed);
    if (type && PROGRESS_BOUNDARIES.has(type)) {
      sawBoundary = true;
      segment = [];
      continue;
    }
    if (type && GOAL_INTERNAL_MESSAGES.has(type)) continue;

    try {
      segment.push(JSON.stringify(stableEvidenceItem(parsed)));
    } catch {
      segment.push(line);
    }
  }

  const basis = sawBoundary ? segment.join("\n") : (segment.join("\n") || evidence);
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
