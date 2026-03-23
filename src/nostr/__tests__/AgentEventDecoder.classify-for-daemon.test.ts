import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { classifyForDaemon } from "../AgentEventDecoder";

describe("AgentEventDecoder.classifyForDaemon", () => {
    it("classifies TenexAgentConfigUpdate as config_update", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.TenexAgentConfigUpdate;
        event.tags = [["p", "agent-pubkey"]];
        event.content = "";

        expect(classifyForDaemon(event)).toBe("config_update");
    });

    it("classifies EventMetadata as conversation for project routing", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.EventMetadata;
        event.tags = [["a", "31933:owner-pubkey:project-d-tag"], ["e", "conversation-event-id"]];
        event.content = "";

        expect(classifyForDaemon(event)).toBe("conversation");
    });

    it("classifies report events as other so they can fall through to project routing", () => {
        const event = new NDKEvent();
        event.kind = 30023;
        event.tags = [["a", "31933:owner-pubkey:project-d-tag"]];
        event.content = "report";

        expect(classifyForDaemon(event)).toBe("other");
    });
});
