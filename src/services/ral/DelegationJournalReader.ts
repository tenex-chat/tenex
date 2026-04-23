import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "@/services/ConfigService";
import type {
  CompletedDelegation,
  DelegationMessage,
  PendingDelegation,
  PendingDelegationType,
  PendingSubDelegationRef,
} from "./types";

type ReplayStatus =
  | "allocated"
  | "claimed"
  | "waiting_for_delegation"
  | "completed"
  | "no_response"
  | "error"
  | "aborted"
  | "crashed";

interface ReplayIdentity {
  projectId: string;
  agentPubkey: string;
  conversationId: string;
  ralNumber: number;
}

interface ReplayPendingDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  senderPubkey: string;
  prompt: string;
  type?: PendingDelegationType;
  ralNumber: number;
  parentDelegationConversationId?: string;
  pendingSubDelegations?: PendingSubDelegationRef[];
  deferredCompletion?: {
    recipientPubkey: string;
    response: string;
    completedAt: number;
    fullTranscript?: DelegationMessage[];
  };
  followupEventId?: string;
  projectId?: string;
  suggestions?: string[];
  killed?: boolean;
  killedAt?: number;
}

interface ReplayCompletedDelegation {
  delegationConversationId: string;
  senderPubkey: string;
  recipientPubkey: string;
  response: string;
  completedAt: number;
  completionEventId: string;
  fullTranscript?: DelegationMessage[];
}

interface ReplayEntry {
  identity: ReplayIdentity;
  status: ReplayStatus;
  pendingDelegations: ReplayPendingDelegation[];
  completedDelegations: ReplayCompletedDelegation[];
}

interface JournalRecord {
  schemaVersion?: number;
  sequence: number;
  timestamp?: number;
  event: string;
  [key: string]: unknown;
}

interface JournalSnapshot {
  schemaVersion?: number;
  lastSequence?: number;
  states?: unknown[];
}

function identityKey(identity: ReplayIdentity): string {
  return `${identity.projectId}|${identity.agentPubkey}|${identity.conversationId}|${identity.ralNumber}`;
}

function ralDir(daemonDir: string): string {
  return path.join(daemonDir, "ral");
}

function journalPath(daemonDir: string): string {
  return path.join(ralDir(daemonDir), "journal.jsonl");
}

function snapshotPath(daemonDir: string): string {
  return path.join(ralDir(daemonDir), "snapshot.json");
}

function normalizeStatus(value: unknown): ReplayStatus {
  if (typeof value !== "string") return "allocated";
  switch (value) {
    case "allocated":
    case "claimed":
    case "waiting_for_delegation":
    case "completed":
    case "no_response":
    case "error":
    case "aborted":
    case "crashed":
      return value;
    default:
      return "allocated";
  }
}

function readIdentity(record: Record<string, unknown>): ReplayIdentity {
  return {
    projectId: String(record.projectId ?? ""),
    agentPubkey: String(record.agentPubkey ?? ""),
    conversationId: String(record.conversationId ?? ""),
    ralNumber: Number(record.ralNumber ?? 0),
  };
}

function readPendingDelegation(value: unknown): ReplayPendingDelegation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const delegationConversationId = String(record.delegationConversationId ?? "");
  if (!delegationConversationId) return null;
  return {
    delegationConversationId,
    recipientPubkey: String(record.recipientPubkey ?? ""),
    senderPubkey: String(record.senderPubkey ?? ""),
    prompt: String(record.prompt ?? ""),
    type: record.type as PendingDelegationType | undefined,
    ralNumber: Number(record.ralNumber ?? 0),
    parentDelegationConversationId:
      typeof record.parentDelegationConversationId === "string"
        ? record.parentDelegationConversationId
        : undefined,
    pendingSubDelegations: Array.isArray(record.pendingSubDelegations)
      ? (record.pendingSubDelegations as PendingSubDelegationRef[])
      : undefined,
    deferredCompletion:
      record.deferredCompletion && typeof record.deferredCompletion === "object"
        ? (record.deferredCompletion as ReplayPendingDelegation["deferredCompletion"])
        : undefined,
    followupEventId:
      typeof record.followupEventId === "string" ? record.followupEventId : undefined,
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    suggestions: Array.isArray(record.suggestions)
      ? record.suggestions.map(String)
      : undefined,
    killed: typeof record.killed === "boolean" ? record.killed : undefined,
    killedAt: typeof record.killedAt === "number" ? record.killedAt : undefined,
  };
}

function readCompletedDelegation(value: unknown): ReplayCompletedDelegation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const delegationConversationId = String(record.delegationConversationId ?? "");
  if (!delegationConversationId) return null;
  return {
    delegationConversationId,
    senderPubkey: String(record.senderPubkey ?? ""),
    recipientPubkey: String(record.recipientPubkey ?? ""),
    response: String(record.response ?? ""),
    completedAt: Number(record.completedAt ?? 0),
    completionEventId: String(record.completionEventId ?? ""),
    fullTranscript: Array.isArray(record.fullTranscript)
      ? (record.fullTranscript as DelegationMessage[])
      : undefined,
  };
}

function ensureEntry(
  entries: Map<string, ReplayEntry>,
  identity: ReplayIdentity,
  status: ReplayStatus
): ReplayEntry {
  const key = identityKey(identity);
  const existing = entries.get(key);
  if (existing) return existing;
  const entry: ReplayEntry = {
    identity,
    status,
    pendingDelegations: [],
    completedDelegations: [],
  };
  entries.set(key, entry);
  return entry;
}

function upsertPendingDelegation(entry: ReplayEntry, pending: ReplayPendingDelegation): void {
  const index = entry.pendingDelegations.findIndex(
    (existing) => existing.delegationConversationId === pending.delegationConversationId
  );
  if (index >= 0) {
    entry.pendingDelegations[index] = pending;
    return;
  }
  entry.pendingDelegations.push(pending);
}

function applyDelegationCompletion(
  entry: ReplayEntry,
  completion: ReplayCompletedDelegation
): void {
  if (
    entry.completedDelegations.some(
      (existing) => existing.completionEventId === completion.completionEventId
    )
  ) {
    return;
  }

  const index = entry.pendingDelegations.findIndex(
    (pending) =>
      pending.delegationConversationId === completion.delegationConversationId &&
      pending.recipientPubkey === completion.senderPubkey &&
      pending.senderPubkey === completion.recipientPubkey
  );
  if (index < 0) return;

  const pending = entry.pendingDelegations[index];
  const hasPendingSubDelegations =
    Array.isArray(pending.pendingSubDelegations) && pending.pendingSubDelegations.length > 0;

  if (hasPendingSubDelegations) {
    pending.deferredCompletion = {
      recipientPubkey: completion.senderPubkey,
      response: completion.response,
      completedAt: completion.completedAt,
      fullTranscript: completion.fullTranscript,
    };
    return;
  }

  entry.pendingDelegations.splice(index, 1);
  entry.completedDelegations.push(completion);
}

function applyRecord(entries: Map<string, ReplayEntry>, record: JournalRecord): void {
  const identity = readIdentity(record);
  if (!identity.projectId || !identity.agentPubkey || !identity.conversationId) return;

  switch (record.event) {
    case "allocated": {
      const entry = ensureEntry(entries, identity, "allocated");
      entry.status = "allocated";
      entry.pendingDelegations = [];
      entry.completedDelegations = [];
      return;
    }
    case "claimed": {
      const entry = ensureEntry(entries, identity, "claimed");
      entry.status = "claimed";
      return;
    }
    case "delegation_registered": {
      const pending = readPendingDelegation(record.pendingDelegation);
      if (!pending) return;
      const entry = ensureEntry(entries, identity, "claimed");
      upsertPendingDelegation(entry, pending);
      return;
    }
    case "waiting_for_delegation": {
      const entry = ensureEntry(entries, identity, "waiting_for_delegation");
      entry.status = "waiting_for_delegation";
      const pendingList = Array.isArray(record.pendingDelegations)
        ? record.pendingDelegations
        : [];
      entry.pendingDelegations = pendingList
        .map(readPendingDelegation)
        .filter((p): p is ReplayPendingDelegation => p !== null);
      entry.completedDelegations = [];
      return;
    }
    case "delegation_completed": {
      const completion = readCompletedDelegation(record.completion);
      if (!completion) return;
      const entry = ensureEntry(entries, identity, "claimed");
      applyDelegationCompletion(entry, completion);
      return;
    }
    case "delegation_killed": {
      const delegationConversationId =
        typeof record.delegationConversationId === "string"
          ? record.delegationConversationId
          : "";
      if (!delegationConversationId) return;
      const entry = ensureEntry(entries, identity, "claimed");
      for (const pending of entry.pendingDelegations) {
        if (pending.delegationConversationId === delegationConversationId) {
          pending.killed = true;
          pending.killedAt =
            typeof record.killedAt === "number" ? record.killedAt : Date.now();
        }
      }
      return;
    }
    case "completed":
    case "no_response":
    case "error":
    case "aborted":
    case "crashed": {
      const entry = ensureEntry(entries, identity, normalizeStatus(record.event));
      entry.status = normalizeStatus(record.event);
      entry.pendingDelegations = [];
      entry.completedDelegations = [];
      return;
    }
    default:
      return;
  }
}

function parseSnapshotEntry(value: unknown): ReplayEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const identitySource = record.identity as Record<string, unknown> | undefined;
  if (!identitySource) return null;
  const identity = readIdentity(identitySource);
  if (!identity.projectId || !identity.agentPubkey || !identity.conversationId) return null;
  const status = normalizeStatus(record.status);
  const pendingList = Array.isArray(record.pendingDelegations)
    ? record.pendingDelegations
    : [];
  const completedList = Array.isArray(record.completedDelegations)
    ? record.completedDelegations
    : [];
  return {
    identity,
    status,
    pendingDelegations: pendingList
      .map(readPendingDelegation)
      .filter((p): p is ReplayPendingDelegation => p !== null),
    completedDelegations: completedList
      .map(readCompletedDelegation)
      .filter((c): c is ReplayCompletedDelegation => c !== null),
  };
}

function toPendingDelegation(pending: ReplayPendingDelegation): PendingDelegation {
  const base = {
    delegationConversationId: pending.delegationConversationId,
    recipientPubkey: pending.recipientPubkey,
    senderPubkey: pending.senderPubkey,
    prompt: pending.prompt,
    ralNumber: pending.ralNumber,
    parentDelegationConversationId: pending.parentDelegationConversationId,
    pendingSubDelegations: pending.pendingSubDelegations,
    deferredCompletion: pending.deferredCompletion
      ? {
          recipientPubkey: pending.deferredCompletion.recipientPubkey,
          response: pending.deferredCompletion.response,
          completedAt: pending.deferredCompletion.completedAt,
          fullTranscript: pending.deferredCompletion.fullTranscript,
        }
      : undefined,
    killed: pending.killed,
    killedAt: pending.killedAt,
  };
  if (pending.type === "followup") {
    return { ...base, type: "followup", followupEventId: pending.followupEventId };
  }
  if (pending.type === "external") {
    return { ...base, type: "external", projectId: pending.projectId };
  }
  if (pending.type === "ask") {
    return { ...base, type: "ask", suggestions: pending.suggestions };
  }
  return { ...base, type: "standard" };
}

function toCompletedDelegation(
  completion: ReplayCompletedDelegation,
  ralNumber: number
): CompletedDelegation {
  const transcript = completion.fullTranscript ?? [];
  return {
    delegationConversationId: completion.delegationConversationId,
    recipientPubkey: completion.recipientPubkey,
    senderPubkey: completion.senderPubkey,
    transcript,
    completedAt: completion.completedAt,
    ralNumber,
    status: "completed",
  };
}

export interface DelegationLocation {
  agentPubkey: string;
  conversationId: string;
  ralNumber: number;
}

export interface DelegationLookup {
  agentPubkey: string;
  conversationId: string;
  ralNumber: number;
  pending?: PendingDelegation;
  completed?: CompletedDelegation;
}

/**
 * Reads the RAL journal (snapshot + append-only journal) to expose
 * current delegation state without maintaining any authoritative TS-side
 * mirror. Rust's journal is the single source of truth; this reader
 * replays events to derive state the TS worker needs for reads.
 *
 * A session-local overlay captures events this worker has emitted during
 * the current session (delegation_registered, delegation_killed). The
 * overlay ensures in-session writes are visible to subsequent reads
 * even if Rust has not yet flushed the journal entry to disk. Overlay
 * records are idempotent with the journal; once Rust catches up, the
 * merged state converges.
 */
export class DelegationJournalReader {
  private static shared: DelegationJournalReader | null = null;

  private cacheMtimes: { snapshot: number; journal: number } | null = null;
  private cacheEntries: Map<string, ReplayEntry> | null = null;
  private readonly overlay: JournalRecord[] = [];
  private overlaySequence = Number.MAX_SAFE_INTEGER / 2;

  static getInstance(): DelegationJournalReader {
    if (!DelegationJournalReader.shared) {
      DelegationJournalReader.shared = new DelegationJournalReader();
    }
    return DelegationJournalReader.shared;
  }

  static resetForTests(): void {
    DelegationJournalReader.shared = null;
  }

  private daemonDir(): string {
    return config.getConfigPath("daemon");
  }

  private readStates(): Map<string, ReplayEntry> {
    const daemonDir = this.daemonDir();
    const snapshotFile = snapshotPath(daemonDir);
    const journalFile = journalPath(daemonDir);

    let snapshotMtime = 0;
    let journalMtime = 0;
    try {
      snapshotMtime = fs.statSync(snapshotFile).mtimeMs;
    } catch {
      snapshotMtime = 0;
    }
    try {
      journalMtime = fs.statSync(journalFile).mtimeMs;
    } catch {
      journalMtime = 0;
    }

    if (
      this.cacheEntries &&
      this.cacheMtimes &&
      this.cacheMtimes.snapshot === snapshotMtime &&
      this.cacheMtimes.journal === journalMtime
    ) {
      return this.cacheEntries;
    }

    const entries = new Map<string, ReplayEntry>();
    let lastSequence = 0;

    if (snapshotMtime > 0) {
      try {
        const raw = fs.readFileSync(snapshotFile, "utf-8");
        const snapshot = JSON.parse(raw) as JournalSnapshot;
        for (const rawState of snapshot.states ?? []) {
          const entry = parseSnapshotEntry(rawState);
          if (entry) entries.set(identityKey(entry.identity), entry);
        }
        lastSequence = typeof snapshot.lastSequence === "number" ? snapshot.lastSequence : 0;
      } catch {
        // Ignore snapshot parse errors; journal replay from the beginning is the fallback.
      }
    }

    if (journalMtime > 0) {
      try {
        const raw = fs.readFileSync(journalFile, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const record = JSON.parse(trimmed) as JournalRecord;
            if (typeof record.sequence === "number" && record.sequence > lastSequence) {
              applyRecord(entries, record);
              lastSequence = record.sequence;
            }
          } catch {
            // Partial tail writes can leave an incomplete final line; safe to skip.
          }
        }
      } catch {
        // Ignore journal read errors; snapshot-only state is the fallback.
      }
    }

    for (const overlayRecord of this.overlay) {
      applyRecord(entries, overlayRecord);
    }

    this.cacheMtimes = { snapshot: snapshotMtime, journal: journalMtime };
    this.cacheEntries = entries;
    return entries;
  }

  private invalidateCache(): void {
    this.cacheMtimes = null;
    this.cacheEntries = null;
  }

  /**
   * Appends a session-local event to the overlay. Used by the publisher
   * bridge to mirror its own emissions for immediate in-session visibility.
   */
  appendOverlay(record: { event: string; [key: string]: unknown }): void {
    this.overlaySequence += 1;
    const full: JournalRecord = {
      ...record,
      event: record.event,
      sequence: this.overlaySequence,
    };
    this.overlay.push(full);
    this.invalidateCache();
  }

  getConversationPendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): PendingDelegation[] {
    const result: PendingDelegation[] = [];
    for (const entry of this.readStates().values()) {
      if (entry.identity.agentPubkey !== agentPubkey) continue;
      if (entry.identity.conversationId !== conversationId) continue;
      if (ralNumber !== undefined && entry.identity.ralNumber !== ralNumber) continue;
      for (const pending of entry.pendingDelegations) {
        result.push(toPendingDelegation(pending));
      }
    }
    return result;
  }

  getConversationCompletedDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): CompletedDelegation[] {
    const result: CompletedDelegation[] = [];
    for (const entry of this.readStates().values()) {
      if (entry.identity.agentPubkey !== agentPubkey) continue;
      if (entry.identity.conversationId !== conversationId) continue;
      if (ralNumber !== undefined && entry.identity.ralNumber !== ralNumber) continue;
      for (const completed of entry.completedDelegations) {
        result.push(toCompletedDelegation(completed, entry.identity.ralNumber));
      }
    }
    return result;
  }

  findDelegation(delegationEventId: string): DelegationLookup | undefined {
    for (const entry of this.readStates().values()) {
      const pending = entry.pendingDelegations.find(
        (candidate) =>
          candidate.delegationConversationId === delegationEventId ||
          candidate.followupEventId === delegationEventId
      );
      if (pending) {
        return {
          agentPubkey: entry.identity.agentPubkey,
          conversationId: entry.identity.conversationId,
          ralNumber: entry.identity.ralNumber,
          pending: toPendingDelegation(pending),
        };
      }
      const completed = entry.completedDelegations.find(
        (candidate) => candidate.delegationConversationId === delegationEventId
      );
      if (completed) {
        return {
          agentPubkey: entry.identity.agentPubkey,
          conversationId: entry.identity.conversationId,
          ralNumber: entry.identity.ralNumber,
          completed: toCompletedDelegation(completed, entry.identity.ralNumber),
        };
      }
    }
    return undefined;
  }

  isDelegationKilled(delegationConversationId: string): boolean {
    for (const entry of this.readStates().values()) {
      for (const pending of entry.pendingDelegations) {
        if (
          pending.delegationConversationId === delegationConversationId &&
          pending.killed === true
        ) {
          return true;
        }
      }
    }
    return false;
  }

  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean {
    for (const entry of this.readStates().values()) {
      for (const pending of entry.pendingDelegations) {
        if (
          pending.delegationConversationId === conversationId &&
          pending.recipientPubkey === agentPubkey &&
          pending.killed === true
        ) {
          return true;
        }
      }
    }
    return false;
  }

  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    for (const entry of this.readStates().values()) {
      for (const pending of entry.pendingDelegations) {
        if (pending.delegationConversationId === delegationConversationId) {
          return pending.recipientPubkey || null;
        }
      }
      for (const completed of entry.completedDelegations) {
        if (completed.delegationConversationId === delegationConversationId) {
          return completed.recipientPubkey || null;
        }
      }
    }
    return null;
  }

  resolveDelegationPrefix(prefix: string): string | null {
    const lowerPrefix = prefix.toLowerCase();
    for (const entry of this.readStates().values()) {
      for (const pending of entry.pendingDelegations) {
        if (pending.delegationConversationId.toLowerCase().startsWith(lowerPrefix)) {
          return pending.delegationConversationId;
        }
      }
      for (const completed of entry.completedDelegations) {
        if (completed.delegationConversationId.toLowerCase().startsWith(lowerPrefix)) {
          return completed.delegationConversationId;
        }
      }
    }
    return null;
  }

  canonicalizeDelegationId(id: string): string {
    for (const entry of this.readStates().values()) {
      for (const pending of entry.pendingDelegations) {
        if (pending.followupEventId === id) {
          return pending.delegationConversationId;
        }
      }
    }
    return id;
  }

  findLocation(delegationConversationId: string): DelegationLocation | undefined {
    const lookup = this.findDelegation(delegationConversationId);
    if (!lookup) return undefined;
    return {
      agentPubkey: lookup.agentPubkey,
      conversationId: lookup.conversationId,
      ralNumber: lookup.ralNumber,
    };
  }
}
