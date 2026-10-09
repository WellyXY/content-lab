import { randomUUID } from "node:crypto";

import type { ContentLabDatabase } from "../db/database.js";

/**
 * Owner memory: corrections, rules and preferences the owner gave the Agent.
 * They are trusted instructions, scoped so the pipeline can apply only the
 * relevant ones to each analysis, assessment and playbook.
 */
export type MemoryKind = "rule" | "correction" | "preference" | "fact";

export interface Memory {
  id: string;
  scope: string;
  kind: MemoryKind;
  content: string;
  source: string;
  author: string | null;
  createdAt: string;
}

const SCOPE = /^(global|market:[A-Z]{2,4}|creator:[A-Za-z0-9._-]{1,64}|post:[A-Za-z0-9-]{8,64})$/;

export function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  const [kind, value] = trimmed.split(":", 2);
  const normalized = kind === "market" && value ? `market:${value.toUpperCase()}` : kind === "creator" && value ? `creator:${value.replace(/^@/, "")}` : trimmed;
  if (!SCOPE.test(normalized)) throw new Error("scope must be global, market:XX, creator:handle or post:id");
  return normalized;
}

export function addMemory(db: ContentLabDatabase, input: { scope: string; kind: MemoryKind; content: string; source: string; author?: string | null; threadKey?: string | null }, now = new Date().toISOString()): Memory {
  const content = input.content.replace(/\s+/g, " ").trim();
  if (content.length < 4 || content.length > 600) throw new Error("memory content must be 4–600 characters");
  const memory: Memory = { id: randomUUID().slice(0, 8), scope: normalizeScope(input.scope), kind: input.kind, content, source: input.source, author: input.author ?? null, createdAt: now };
  db.prepare("INSERT INTO memories(id, scope, kind, content, source, author, thread_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(memory.id, memory.scope, memory.kind, memory.content, memory.source, memory.author, input.threadKey ?? null, now);
  return memory;
}

export function archiveMemory(db: ContentLabDatabase, id: string, now = new Date().toISOString()): boolean {
  return db.prepare("UPDATE memories SET archived_at=? WHERE id=? AND archived_at IS NULL").run(now, id).changes > 0;
}

export function listMemories(db: ContentLabDatabase, scopes?: string[]): Memory[] {
  const rows = (scopes?.length
    ? db.prepare(`SELECT * FROM memories WHERE archived_at IS NULL AND scope IN (${scopes.map(() => "?").join(",")}) ORDER BY created_at`).all(...scopes)
    : db.prepare("SELECT * FROM memories WHERE archived_at IS NULL ORDER BY created_at").all()) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ id: String(row.id), scope: String(row.scope), kind: row.kind as MemoryKind, content: String(row.content), source: String(row.source), author: (row.author as string | null) ?? null, createdAt: String(row.created_at) }));
}

/** The memories that apply to one post (or, without a post, to a market). */
export function memoriesFor(db: ContentLabDatabase, target: { market?: string | null; creator?: string | null; postId?: string | null }): Memory[] {
  const scopes = ["global"];
  if (target.market) scopes.push(`market:${target.market.toUpperCase()}`);
  if (target.creator) scopes.push(`creator:${target.creator.replace(/^@/, "")}`);
  if (target.postId) scopes.push(`post:${target.postId}`);
  return listMemories(db, scopes);
}

/** Prompt block for the pipeline; empty when there is nothing to apply. */
export function ownerMemoryBlock(memories: Memory[]): string {
  if (!memories.length) return "";
  return [
    "Owner memory (trusted instructions from the owner; follow them, and when one conflicts with your own judgment, follow the memory):",
    ...memories.map((memory) => `- [${memory.kind} · ${memory.scope}] ${memory.content}`),
  ].join("\n");
}
