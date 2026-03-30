import { describe, expect, it, mock } from "bun:test";
import { buildProjectFilter } from "@/services/search/projectFilter";

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: () => "/tmp/tenex-test-config",
    },
}));

import { QdrantProvider } from "../providers/QdrantProvider";
import { SqliteVecProvider } from "../providers/SqliteVecProvider";

describe("QdrantProvider.translateFilter", () => {
    it("decodes SQL LIKE escapes back to literal metadata text", () => {
        const provider = new QdrantProvider({ provider: "qdrant", url: "http://localhost:6333" });
        const filter = buildProjectFilter("project%100_test") as string;

        const translated = (provider as unknown as {
            translateFilter: (value: string) => Record<string, unknown>;
        }).translateFilter(filter);

        expect(translated).toEqual({
            should: [
                {
                    must: [{ key: "metadata", match: { text: "\"projectId\":\"project%100_test\"" } }],
                },
                {
                    must: [{ key: "metadata", match: { text: "\"project_id\":\"project%100_test\"" } }],
                },
            ],
        });
    });

    it("preserves quotes and underscores in translated text matches", () => {
        const provider = new QdrantProvider({ provider: "qdrant", url: "http://localhost:6333" });
        const filter = buildProjectFilter("project's_id") as string;

        const translated = (provider as unknown as {
            translateFilter: (value: string) => Record<string, unknown>;
        }).translateFilter(filter);

        expect(translated).toEqual({
            should: [
                {
                    must: [{ key: "metadata", match: { text: "\"projectId\":\"project's_id\"" } }],
                },
                {
                    must: [{ key: "metadata", match: { text: "\"project_id\":\"project's_id\"" } }],
                },
            ],
        });
    });
});

describe("SqliteVecProvider.search", () => {
    it("applies metadata filters during the vector search query", async () => {
        const provider = new SqliteVecProvider({ provider: "sqlite-vec", path: "/tmp/sqlite-vec-test" });
        const queries: string[] = [];

        const db = {
            prepare: (query: string) => {
                queries.push(query);
                return {
                    all: () => [
                        {
                            id: "doc-1",
                            content: "filtered result",
                            metadata: "{\"projectId\":\"project-a\"}",
                            timestamp: 123,
                            source: "test",
                            distance: 0.25,
                        },
                    ],
                };
            },
        };

        (provider as unknown as { db: unknown }).db = db;

        const results = await provider.search(
            "project_notes",
            [0.1, 0.2],
            5,
            buildProjectFilter("project-a")
        );

        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain("JOIN \"docs_project_notes\" d ON d.id = v.id");
        expect(queries[0]).toContain("d.metadata LIKE");
        expect(results).toEqual([
            {
                document: {
                    id: "doc-1",
                    content: "filtered result",
                    vector: [],
                    metadata: "{\"projectId\":\"project-a\"}",
                    timestamp: 123,
                    source: "test",
                },
                score: 1 / 1.25,
            },
        ]);
    });
});
