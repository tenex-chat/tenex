import type { ConversationEntry } from "@/conversations/types";
import { resolveToolCallEventIdMap } from "@/conversations/utils/resolve-tool-call-event-id-map";
import { getIdentityDisplayService } from "@/services/identity/IdentityDisplayService";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import type { ToolCallPart } from "ai";

const DEFAULT_SHORT_ID_LENGTH = 12;
const DEFAULT_MAX_TOOL_DESCRIPTION_LENGTH = 150;
const DEFAULT_MAX_TOOL_INPUT_JSON_LENGTH = 200;

const FULL_HEX_EVENT_ID_REGEX = /^[0-9a-f]{64}$/i;

export interface ConversationTimelineEntry {
  entry: ConversationEntry;
  relativeSeconds: number;
  author: string;
  recipients: string[];
}

export interface ConversationTimeline {
  t0: number;
  entries: ConversationTimelineEntry[];
}

export interface ConversationTimelineOptions {
  includeMessageTypes?: Array<ConversationEntry["messageType"]>;
  requireTargetedPubkeys?: boolean;
  includeToolCalls?: boolean;
}

export interface ConversationXmlRenderOptions {
  conversationId?: string;
  includeMessageTypes?: Array<ConversationEntry["messageType"]>;
  requireTargetedPubkeys?: boolean;
  includeToolCalls?: boolean;
  shortIdLength?: number;
  maxToolDescriptionLength?: number;
  maxToolInputJsonLength?: number;
}

export interface ConversationXmlRenderResult {
  xml: string;
  shortIdToEventId: Map<string, string>;
  firstShortId: string | null;
  lastShortId: string | null;
}

type ConversationPrincipal =
  | ConversationEntry["senderPrincipal"]
  | NonNullable<ConversationEntry["targetedPrincipals"]>[number]
  | undefined;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function computeBaselineTimestamp(entries: ConversationEntry[]): number {
  for (const entry of entries) {
    if (entry.timestamp !== undefined) {
      return entry.timestamp;
    }
  }
  return 0;
}

function shouldIncludeEntry(
  entry: ConversationEntry,
  options: ConversationTimelineOptions
): boolean {
  const includeToolCalls = options.includeToolCalls ?? true;

  if (entry.messageType === "tool-result") {
    return false;
  }

  if (entry.messageType === "tool-call" && !includeToolCalls) {
    return false;
  }

  if (options.includeMessageTypes && !options.includeMessageTypes.includes(entry.messageType)) {
    return false;
  }

  if (options.requireTargetedPubkeys && (!entry.targetedPubkeys || entry.targetedPubkeys.length === 0)) {
    return false;
  }

  return true;
}

function getShortEventId(
  eventId: string,
  shortIdLength: number,
  usedShortIds: Set<string>
): string {
  const base = eventId.substring(0, shortIdLength) || "event";
  let candidate = base;
  let suffix = 2;

  while (usedShortIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }

  usedShortIds.add(candidate);
  return candidate;
}

function formatDelegationMarkerContent(entry: ConversationEntry): string | null {
  const marker = entry.delegationMarker;
  if (!marker?.delegationConversationId || !marker?.recipientPubkey || !marker?.status) {
    return null;
  }

  const identityDisplayService = getIdentityDisplayService();
  const shortConversationId = marker.delegationConversationId.slice(0, PREFIX_LENGTH);
  const recipientName = identityDisplayService.resolveDisplayNameSync({
    linkedPubkey: marker.recipientPubkey,
  });

  if (marker.status === "pending") {
    return `⏳ Delegation ${shortConversationId} → ${recipientName} in progress`;
  }

  if (marker.status === "completed") {
    return `✅ Delegation ${shortConversationId} → ${recipientName} completed`;
  }

  return `⚠️ Delegation ${shortConversationId} → ${recipientName} aborted`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return currentValue.toString();
      }

      if (typeof currentValue === "object" && currentValue !== null) {
        if (seen.has(currentValue)) {
          return "[Circular]";
        }
        seen.add(currentValue);
      }

      return currentValue;
    });

    if (serialized === undefined) {
      return "";
    }

    return serialized;
  } catch {
    return "[Unserializable]";
  }
}

function truncateWithSuffix(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const truncatedChars = value.length - maxLength;
  return `${value.slice(0, maxLength)}... [truncated ${truncatedChars} chars]`;
}

function extractToolCallParts(entry: ConversationEntry): ToolCallPart[] {
  if (!entry.toolData || entry.toolData.length === 0) {
    return [];
  }

  return entry.toolData
    .map((tool) => tool as unknown as Record<string, unknown>)
    .filter((tool) => (tool.type ?? entry.messageType) === "tool-call")
    .map((tool) => ({
      type: "tool-call",
      toolCallId: typeof tool.toolCallId === "string" ? tool.toolCallId : "",
      toolName: typeof tool.toolName === "string" ? tool.toolName : "unknown",
      input: tool.input,
    })) as ToolCallPart[];
}

function resolveConversationRootEventId(
  entries: ConversationEntry[],
  conversationId?: string
): string | null {
  if (conversationId && conversationId.length > 0) {
    return conversationId;
  }

  for (const entry of entries) {
    if (entry.eventId) {
      return entry.eventId;
    }
  }

  return null;
}

function buildToolXmlAttributes(
  entry: ConversationEntry,
  maxToolDescriptionLength: number,
  maxToolInputJsonLength: number
): Record<string, string> {
  const attrs: Record<string, string> = {};

  if (entry.transcriptToolAttributes) {
    Object.assign(attrs, entry.transcriptToolAttributes);
  }

  const toolCallParts = extractToolCallParts(entry);
  const firstPart = toolCallParts[0];
  const firstInput = firstPart?.input as Record<string, unknown> | undefined;

  if (!attrs.description && firstInput && typeof firstInput.description === "string") {
    attrs.description = truncateWithSuffix(firstInput.description, maxToolDescriptionLength);
  }

  const fallbackArgMappings: Array<{ key: string; attribute: string }> = [
    { key: "path", attribute: "file_path" },
    { key: "pattern", attribute: "pattern" },
    { key: "query", attribute: "query" },
    { key: "glob", attribute: "glob" },
    { key: "file_path", attribute: "file_path" },
  ];
  for (const mapping of fallbackArgMappings) {
    if (attrs[mapping.attribute]) {
      continue;
    }
    const candidate = firstInput?.[mapping.key];
    if (typeof candidate === "string" && candidate.length > 0) {
      attrs[mapping.attribute] = candidate;
    }
  }

  const toolName = firstPart?.toolName ?? "unknown";
  if (toolName.startsWith("mcp_") && !attrs.args) {
    attrs.args = truncateWithSuffix(safeStringify(firstInput ?? {}), maxToolInputJsonLength);
  }

  return attrs;
}

function resolveEntryDisplayName(
  pubkey: string | undefined,
  principal: ConversationPrincipal,
  identityDisplayService: ReturnType<typeof getIdentityDisplayService>
): string {
  return identityDisplayService.resolveDisplayNameSync({
    principalId: principal?.id,
    linkedPubkey: pubkey,
    displayName: principal?.displayName,
    username: principal?.username,
  });
}

export function buildConversationTimeline(
  entries: ConversationEntry[],
  options: ConversationTimelineOptions = {}
): ConversationTimeline {
  const identityDisplayService = getIdentityDisplayService();
  const t0 = computeBaselineTimestamp(entries);
  let lastKnownTimestamp = t0;
  const timelineEntries: ConversationTimelineEntry[] = [];

  for (const entry of entries) {
    const effectiveTimestamp = entry.timestamp ?? lastKnownTimestamp;
    const relativeSeconds = Math.floor(effectiveTimestamp - t0);

    if (entry.timestamp !== undefined) {
      lastKnownTimestamp = entry.timestamp;
    }

    if (!shouldIncludeEntry(entry, options)) {
      continue;
    }

    const authorPubkey = entry.senderPrincipal?.linkedPubkey ?? entry.senderPubkey ?? entry.pubkey;
    const author = resolveEntryDisplayName(authorPubkey, entry.senderPrincipal, identityDisplayService);
    const recipients = (entry.targetedPubkeys ?? []).map((pubkey, index) =>
      resolveEntryDisplayName(
        entry.targetedPrincipals?.[index]?.linkedPubkey ?? pubkey,
        entry.targetedPrincipals?.[index],
        identityDisplayService
      )
    );

    timelineEntries.push({
      entry,
      relativeSeconds,
      author,
      recipients,
    });
  }

  return {
    t0,
    entries: timelineEntries,
  };
}

export function renderConversationXml(
  entries: ConversationEntry[],
  options: ConversationXmlRenderOptions = {}
): ConversationXmlRenderResult {
  const shortIdLength = options.shortIdLength ?? DEFAULT_SHORT_ID_LENGTH;
  const maxToolDescriptionLength =
    options.maxToolDescriptionLength ?? DEFAULT_MAX_TOOL_DESCRIPTION_LENGTH;
  const maxToolInputJsonLength =
    options.maxToolInputJsonLength ?? DEFAULT_MAX_TOOL_INPUT_JSON_LENGTH;

  const timeline = buildConversationTimeline(entries, {
    includeMessageTypes: options.includeMessageTypes,
    requireTargetedPubkeys: options.requireTargetedPubkeys,
    includeToolCalls: options.includeToolCalls,
  });

  const toolCallEventIdMap = resolveToolCallEventIdMap(entries);
  const usedShortIds = new Set<string>();
  const shortIdToEventId = new Map<string, string>();
  const renderedIds: string[] = [];

  const getOrCreateShortId = (eventId: string): string => {
    for (const [shortId, fullId] of shortIdToEventId.entries()) {
      if (fullId === eventId) {
        return shortId;
      }
    }

    const shortId = getShortEventId(eventId, shortIdLength, usedShortIds);
    shortIdToEventId.set(shortId, eventId);
    return shortId;
  };

  const rootEventId = resolveConversationRootEventId(entries, options.conversationId);
  const rootId = rootEventId
    ? getOrCreateShortId(rootEventId)
    : "unknown";

  const lines: string[] = [`<conversation id="${escapeXml(rootId)}" t0="${timeline.t0}">`];

  for (const timelineEntry of timeline.entries) {
    const { entry, relativeSeconds, author, recipients } = timelineEntry;

    if (entry.messageType === "tool-result") {
      continue;
    }

    const timeIndicator = `+${relativeSeconds}`;

    if (entry.messageType === "tool-call") {
      const toolParts = extractToolCallParts(entry);
      if (toolParts.length === 0) {
        continue;
      }

      const primaryPart = toolParts[0];
      const toolCallId = primaryPart.toolCallId;
      const candidateToolEventId = entry.eventId || toolCallEventIdMap.get(toolCallId);
      const toolId = candidateToolEventId
        ? (FULL_HEX_EVENT_ID_REGEX.test(candidateToolEventId)
            ? candidateToolEventId
            : getOrCreateShortId(candidateToolEventId))
        : null;
      if (toolId) {
        renderedIds.push(toolId);
        if (candidateToolEventId && FULL_HEX_EVENT_ID_REGEX.test(candidateToolEventId)) {
          shortIdToEventId.set(toolId, candidateToolEventId);
        }
      }

      const idAttr = toolId ? ` id="${escapeXml(toolId)}"` : "";
      const nameAttr = ` name="${escapeXml(primaryPart.toolName || "unknown")}"`;
      const transcriptAttrs = buildToolXmlAttributes(
        entry,
        maxToolDescriptionLength,
        maxToolInputJsonLength
      );
      const extraAttrs = Object.entries(transcriptAttrs)
        .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
        .join("");

      lines.push(
        `  <tool${idAttr} user="${escapeXml(author)}"${nameAttr}${extraAttrs} time="${timeIndicator}" />`
      );
      continue;
    }

    const messageText = entry.messageType === "delegation-marker"
      ? formatDelegationMarkerContent(entry)
      : (entry.content || "(empty)");

    if (messageText === null) {
      continue;
    }

    const shortEventId = entry.eventId ? getOrCreateShortId(entry.eventId) : null;
    if (shortEventId) {
      renderedIds.push(shortEventId);
    }
    const idAttr = shortEventId ? ` id="${escapeXml(shortEventId)}"` : "";
    const recipientAttr = recipients.length > 0
      ? ` recipient="${escapeXml(recipients.join(", "))}"`
      : "";

    lines.push(
      `  <message${idAttr} author="${escapeXml(author)}"${recipientAttr} time="${timeIndicator}">${escapeXml(messageText)}</message>`
    );
  }

  lines.push("</conversation>");

  return {
    xml: lines.join("\n"),
    shortIdToEventId,
    firstShortId: renderedIds[0] ?? null,
    lastShortId: renderedIds[renderedIds.length - 1] ?? null,
  };
}
