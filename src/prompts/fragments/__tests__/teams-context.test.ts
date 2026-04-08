import { describe, expect, it } from "bun:test";
import { render } from "../teams-context";

describe("teams-context", () => {
    it("renders team membership and active scope", () => {
        const result = render({
            teams: [
                {
                    name: "design",
                    description: "Design team",
                    teamLead: "lead-design",
                    members: ["lead-design", "alice", "bob"],
                },
                {
                    name: "ops",
                    description: "Operations team",
                    teamLead: "lead-ops",
                    members: ["lead-ops", "carol"],
                },
            ],
            activeTeam: "ops",
        });

        expect(result).toContain("<teams-context>");
        expect(result).toContain("You belong to teams: design, ops");
        expect(result).toContain("design: lead=lead-design, members=lead-design, alice, bob");
        expect(result).toContain("ops (active): lead=lead-ops, members=lead-ops, carol");
    });

    it("renders nothing when there are no teams and no active scope", () => {
        expect(render({ teams: [] })).toBe("");
    });

    it("renders active team scope clearly when agent has no team membership", () => {
        const result = render({
            teams: [],
            activeTeam: "frontend",
        });

        expect(result).toContain("<teams-context>");
        expect(result).toContain("You are operating in team scope: frontend");
        expect(result).not.toContain("You belong to teams:");
        expect(result).toContain("</teams-context>");
    });

    it("marks active team case-insensitively in member team list", () => {
        const result = render({
            teams: [
                {
                    name: "Frontend",
                    description: "Frontend team",
                    teamLead: "lead-fe",
                    members: ["lead-fe", "alice"],
                },
            ],
            activeTeam: "frontend",
        });

        expect(result).toContain("Frontend (active):");
        expect(result).not.toContain("Active team: frontend");
    });
});
