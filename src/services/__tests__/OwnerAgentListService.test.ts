import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ndkClientModule from "@/nostr/ndkClient";
import { Nip46SigningService } from "@/services/nip46";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { OwnerAgentListService } from "../OwnerAgentListService";

describe("OwnerAgentListService", () => {
    let getNDKSpy: ReturnType<typeof spyOn>;
    let getNip46ServiceSpy: ReturnType<typeof spyOn> | undefined;
    let publishSpy: ReturnType<typeof spyOn>;
    let signSpy: ReturnType<typeof spyOn>;
    let infoSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let debugSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        getNDKSpy = spyOn(ndkClientModule, "getNDK").mockReturnValue({
            subscribe: mock(() => ({
                stop: mock(() => undefined),
            })),
        } as any);
        publishSpy = spyOn(NDKEvent.prototype, "publish").mockImplementation(mock(async () => undefined as any));
        signSpy = spyOn(NDKEvent.prototype, "sign").mockImplementation(mock(async () => undefined as any));
        infoSpy = spyOn(logger, "info").mockImplementation(() => undefined);
        warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);
        debugSpy = spyOn(logger, "debug").mockImplementation(() => undefined);

        (OwnerAgentListService as any).instance?.shutdown?.();
        (OwnerAgentListService as any).instance = undefined;
    });

    afterEach(() => {
        (OwnerAgentListService as any).instance?.shutdown?.();
        (OwnerAgentListService as any).instance = undefined;

        getNDKSpy.mockRestore();
        getNip46ServiceSpy?.mockRestore();
        publishSpy.mockRestore();
        signSpy.mockRestore();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        debugSpy.mockRestore();
    });

    it("skips pending kind:14199 publishes when NIP-46 is disabled", async () => {
        getNip46ServiceSpy = spyOn(Nip46SigningService, "getInstance").mockReturnValue({
            isEnabled: () => false,
        } as any);

        const service = OwnerAgentListService.getInstance();
        service.initialize(["owner-pubkey"]);
        service.registerAgents("project-1", ["agent-pubkey-1"]);

        await (service as any).publishPendingUpdates();

        expect(signSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(
            "[OwnerAgentListService] NIP-46 disabled — skipping 14199 publish",
            { ownerCount: 1 },
        );
    });

    it("no-ops registration when no owner pubkeys are configured", async () => {
        const service = OwnerAgentListService.getInstance();
        service.initialize([]);
        service.registerAgents("project-1", ["agent-pubkey-1"]);

        expect((service as any).agentProjectSources.size).toBe(0);

        await (service as any).publishPendingUpdates();

        expect(signSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
    });
});
