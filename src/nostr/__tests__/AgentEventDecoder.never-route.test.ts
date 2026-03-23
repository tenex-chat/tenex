import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { isNeverRouteKind } from "../AgentEventDecoder";

describe("AgentEventDecoder.isNeverRouteKind", () => {
    it("treats ProjectAgentSnapshot as never-route", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.ProjectAgentSnapshot;
        event.tags = [["p", "agent-pubkey"]];
        event.content = "";

        expect(isNeverRouteKind(event)).toBe(true);
    });

    it("treats TenexStreamTextDelta as never-route", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.TenexStreamTextDelta;
        event.tags = [];
        event.content = "delta";

        expect(isNeverRouteKind(event)).toBe(true);
    });
});
