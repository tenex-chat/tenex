import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { AgentEventDecoder } from "../AgentEventDecoder";

describe("AgentEventDecoder.isNeverRouteKind", () => {
    it("treats TenexStreamTextDelta as never-route", () => {
        const event = new NDKEvent();
        event.kind = NDKKind.TenexStreamTextDelta;
        event.tags = [];
        event.content = "delta";

        expect(AgentEventDecoder.isNeverRouteKind(event)).toBe(true);
    });
});
