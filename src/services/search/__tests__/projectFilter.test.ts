import { describe, expect, it } from "bun:test";
import { buildProjectFilter } from "../projectFilter";

describe("buildProjectFilter", () => {
    it("returns undefined when no projectId is provided", () => {
        expect(buildProjectFilter()).toBeUndefined();
        expect(buildProjectFilter(undefined)).toBeUndefined();
    });

    it("returns undefined when projectId is 'ALL'", () => {
        expect(buildProjectFilter("ALL")).toBeUndefined();
        expect(buildProjectFilter("all")).toBeUndefined();
        expect(buildProjectFilter("All")).toBeUndefined();
    });

    it("returns SQL LIKE filter matching both projectId and project_id", () => {
        const filter = buildProjectFilter("project-123");
        // Must match both camelCase (canonical) and snake_case (legacy) metadata keys
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"project-123"%' OR metadata LIKE '%"project_id":"project-123"%')`
        );
    });

    it("escapes single quotes in projectId", () => {
        const filter = buildProjectFilter("project's-id");
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"project''s-id"%' OR metadata LIKE '%"project_id":"project''s-id"%')`
        );
    });

    it("handles complex projectId formats (NIP-33 address)", () => {
        const tagId = "31933:abc123:my-project";
        const filter = buildProjectFilter(tagId);
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"31933:abc123:my-project"%' OR metadata LIKE '%"project_id":"31933:abc123:my-project"%')`
        );
    });
});
