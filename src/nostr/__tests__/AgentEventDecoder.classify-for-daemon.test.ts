import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { AgentEventDecoder } from "../AgentEventDecoder";

describe("AgentEventDecoder.classifyForDaemon", () => {
    it("classifies TenexAgentConfigUpdate as config_update", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.TenexAgentConfigUpdate;
        event.tags = [["p", "agent-pubkey"]];
        event.content = "";

        expect(AgentEventDecoder.classifyForDaemon(event)).toBe("config_update");
    });

    it("classifies EventMetadata as conversation for project routing", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.EventMetadata;
        event.tags = [["a", "31933:owner-pubkey:project-d-tag"], ["e", "conversation-event-id"]];
        event.content = "";

        expect(AgentEventDecoder.classifyForDaemon(event)).toBe("conversation");
    });
});
