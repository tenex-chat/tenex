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

    it("returns SQL LIKE filter matching both projectId and project_id with ESCAPE clause", () => {
        const filter = buildProjectFilter("project-123");
        // Must match both camelCase (canonical) and snake_case (legacy) metadata keys
        // ESCAPE clause is required for DataFusion (no default escape char)
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"project-123"%' ESCAPE '\\\\' OR metadata LIKE '%"project_id":"project-123"%' ESCAPE '\\\\')`
        );
    });

    it("escapes single quotes in projectId", () => {
        const filter = buildProjectFilter("project's-id");
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"project''s-id"%' ESCAPE '\\\\' OR metadata LIKE '%"project_id":"project''s-id"%' ESCAPE '\\\\')`
        );
    });

    it("escapes SQL LIKE wildcards in projectId", () => {
        const filter = buildProjectFilter("project%100_test");
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"project\\%100\\_test"%' ESCAPE '\\\\' OR metadata LIKE '%"project_id":"project\\%100\\_test"%' ESCAPE '\\\\')`
        );
    });

    it("handles complex projectId formats (NIP-33 address)", () => {
        const tagId = "31933:abc123:my-project";
        const filter = buildProjectFilter(tagId);
        expect(filter).toBe(
            `(metadata LIKE '%"projectId":"31933:abc123:my-project"%' ESCAPE '\\\\' OR metadata LIKE '%"project_id":"31933:abc123:my-project"%' ESCAPE '\\\\')`
        );
    });
});
