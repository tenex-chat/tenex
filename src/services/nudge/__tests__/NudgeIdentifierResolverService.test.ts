import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as nudgeWhitelistModule from "../NudgeWhitelistService";
import { NudgeIdentifierResolverService } from "../NudgeIdentifierResolverService";

const mockGetWhitelistedNudges = mock();

describe("NudgeIdentifierResolverService", () => {
    const NUDGE_ID_1 = "a".repeat(64);
    const NUDGE_ID_2 = "b".repeat(64);
    const SHORT_ID_1 = NUDGE_ID_1.slice(0, 12);
    let whitelistSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        whitelistSpy = spyOn(
            nudgeWhitelistModule.NudgeSkillWhitelistService,
            "getInstance"
        ).mockReturnValue({
            getWhitelistedNudges: mockGetWhitelistedNudges,
        } as never);
        mockGetWhitelistedNudges.mockReset();
        mockGetWhitelistedNudges.mockReturnValue([
            { eventId: NUDGE_ID_1, kind: 4201, identifier: "be-brief", shortId: SHORT_ID_1 },
            { eventId: NUDGE_ID_2, kind: 4201, identifier: "use-shell", shortId: NUDGE_ID_2.slice(0, 12) },
        ]);
    });

    afterEach(() => {
        whitelistSpy?.mockRestore();
        mock.restore();
    });

    it("resolves advertised slug ids and short ids back to canonical event ids", () => {
        const result = NudgeIdentifierResolverService.getInstance().resolveNudgeIdentifiers([
            "be-brief",
            SHORT_ID_1,
            NUDGE_ID_2,
        ]);

        expect(result).toEqual({
            resolvedNudgeEventIds: [NUDGE_ID_1, NUDGE_ID_2],
            unresolvedIdentifiers: [],
        });
    });

    it("reports non-canonical unknown identifiers as unresolved", () => {
        const result = NudgeIdentifierResolverService.getInstance().resolveNudgeIdentifiers([
            "unknown-nudge",
        ]);

        expect(result).toEqual({
            resolvedNudgeEventIds: [],
            unresolvedIdentifiers: ["unknown-nudge"],
        });
    });
});
