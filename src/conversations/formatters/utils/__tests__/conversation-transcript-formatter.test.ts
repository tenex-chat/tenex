import { describe, expect, it } from "bun:test";
import type { ConversationRecordInput } from "@/conversations/types";
import { renderConversationXml } from "../conversation-transcript-formatter";

describe("conversation-transcript-formatter", () => {
  const baseEntries: ConversationRecordInput[] = [
    {
      pubkey: "author-1-pubkey",
      content: "untargeted text",
      messageType: "text",
      timestamp: 100,
      eventId: "1111111111111111111111111111111111111111111111111111111111111111",
    },
    {
      pubkey: "author-1-pubkey",
      content: "",
      messageType: "tool-call",
      timestamp: 101,
      targetedPubkeys: ["recipient-1-pubkey"],
      toolData: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "fs_read",
          input: { path: "README.md", description: "Read project README" },
        },
      ],
      transcriptToolAttributes: {
        file_path: "README.md",
        description: "Read project README",
      },
    },
    {
      pubkey: "author-1-pubkey",
      content: "",
      messageType: "tool-result",
      timestamp: 102,
      targetedPubkeys: ["recipient-1-pubkey"],
      eventId: "2222222222222222222222222222222222222222222222222222222222222222",
      toolData: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "fs_read",
          output: { type: "text", value: "file content" },
        },
      ],
    },
    {
      pubkey: "author-2-pubkey",
      content: "targeted text",
      messageType: "text",
      timestamp: 103,
      targetedPubkeys: ["recipient-1-pubkey"],
      eventId: "3333333333333333333333333333333333333333333333333333333333333333",
    },
  ];

  it("renders a single XML format with root id and +N time", () => {
    const { xml } = renderConversationXml(baseEntries, {
      conversationId: "1111111111111111111111111111111111111111111111111111111111111111",
      includeToolCalls: true,
    });

    expect(xml).toContain('<conversation id="111111111111" t0="100">');
    expect(xml).toContain('time="+0"');
    expect(xml).toContain('time="+1"');
    expect(xml).toContain('time="+3"');
    expect(xml).not.toContain('[+');
    expect(xml).not.toContain(' type="text"');
    expect(xml).not.toContain(' type="result"');
  });

  it("emits tool-use only and uses tool result event id for tool id", () => {
    const { xml } = renderConversationXml(baseEntries, { includeToolCalls: true });

    expect(xml).toContain('<tool id="2222222222222222222222222222222222222222222222222222222222222222"');
    expect(xml).toContain('name="fs_read"');
    expect(xml).toContain('user="');
    expect(xml).toContain('file_path="README.md"');
    expect(xml).toContain('description="Read project README"');
    expect(xml).not.toContain('tool-result');
    expect(xml).not.toContain('Result[');
  });

  it("supports p-tag-only text transcript filtering", () => {
    const { xml } = renderConversationXml(baseEntries, {
      includeMessageTypes: ["text"],
      requireTargetedPubkeys: true,
      includeToolCalls: false,
    });

    expect(xml).toContain("targeted text");
    expect(xml).not.toContain("untargeted text");
    expect(xml).not.toContain("<tool");
  });

  it("prefers principal snapshots for author and recipient labels", () => {
    const entries: ConversationRecordInput[] = [
      {
        pubkey: "linked-user-pubkey",
        senderPrincipal: {
          id: "telegram:user:42",
          transport: "telegram",
          linkedPubkey: "linked-user-pubkey",
          displayName: "Alice Telegram",
        },
        content: "transport-linked message",
        messageType: "text",
        timestamp: 150,
        targetedPubkeys: ["recipient-1-pubkey"],
        targetedPrincipals: [{
          id: "telegram:group:99",
          transport: "telegram",
          displayName: "Ops Room",
        }],
      },
    ];

    const { xml } = renderConversationXml(entries, { includeToolCalls: false });
    expect(xml).toContain('author="Alice Telegram"');
    expect(xml).toContain('recipient="Ops Room"');
  });

  it("falls back to truncated raw args for MCP tools without transcript attrs", () => {
    const entries: ConversationRecordInput[] = [
      {
        pubkey: "author-1-pubkey",
        content: "",
        messageType: "tool-call",
        timestamp: 200,
        eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        toolData: [
          {
            type: "tool-call",
            toolCallId: "mcp-1",
            toolName: "mcp_resource_read",
            input: {
              serverName: "docs",
              resourceUri: "mcp://resource/with/a/very/long/path?query=1",
              extra: "x".repeat(300),
            },
          },
        ],
      },
    ];

    const { xml } = renderConversationXml(entries, { includeToolCalls: true });
    expect(xml).toContain('args="{');
    expect(xml).toContain('[truncated ');
  });
});
