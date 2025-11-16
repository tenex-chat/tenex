/**
 * Tests for OpenRouter pricing service
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenRouterPricingService } from "../pricing";

// Mock fetch for testing
const mockFetch = mock(() => Promise.resolve());
global.fetch = mockFetch as any;

const mockOpenRouterResponse = {
    data: [
        {
            id: "mistralai/mistral-small-3.2-24b-instruct",
            name: "Mistral: Mistral Small 3.2 24B",
            pricing: {
                prompt: "0.0000001",
                completion: "0.0000003",
                request: "0",
                image: "0",
                web_search: "0",
                internal_reasoning: "0",
            },
        },
        {
            id: "google/gemini-2.5-flash",
            name: "Google: Gemini 2.5 Flash",
            pricing: {
                prompt: "0.0000003",
                completion: "0.0000025",
                request: "0",
                image: "0.001238",
                web_search: "0",
                internal_reasoning: "0",
            },
        },
    ],
};

describe("OpenRouterPricingService", () => {
    let service: OpenRouterPricingService;

    beforeEach(() => {
        service = new OpenRouterPricingService();
        mockFetch.mockClear();
    });

    describe("refreshCache", () => {
        it("should fetch and cache pricing data", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockOpenRouterResponse),
            });

            await service.refreshCache();

            expect(mockFetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");

            const mistralPricing = await service.getModelPricing(
                "mistralai/mistral-small-3.2-24b-instruct"
            );
            expect(mistralPricing).toEqual({
                prompt: 0.0000001,
                completion: 0.0000003,
            });
        });

        it("should handle API errors gracefully", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
            });

            await expect(service.refreshCache()).rejects.toThrow(
                "OpenRouter API error: 500 Internal Server Error"
            );
        });
    });

    describe("calculateCost", () => {
        beforeEach(async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockOpenRouterResponse),
            });
            await service.refreshCache();
        });

        it("should calculate cost correctly for known model", async () => {
            const cost = await service.calculateCost("google/gemini-2.5-flash", 10000, 5000);

            // Expected: (10000/1M * 0.0000003) + (5000/1M * 0.0000025) = 0.000000003 + 0.0000000125 = 0.0000000155
            expect(cost).toBeCloseTo(0.0000000155, 10);
        });

        it("should return default cost for unknown model", async () => {
            const cost = await service.calculateCost("unknown-model", 10000, 5000);

            // Expected: (10000 + 5000) / 1M * 1.0 = 0.015
            expect(cost).toBeCloseTo(0.015, 10);
        });
    });

    describe("findModelId", () => {
        beforeEach(async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockOpenRouterResponse),
            });
            await service.refreshCache();
        });

        it("should find exact match", async () => {
            const modelId = await service.findModelId("google/gemini-2.5-flash");
            expect(modelId).toBe("google/gemini-2.5-flash");
        });

        it("should find partial match", async () => {
            const modelId = await service.findModelId("gemini-2.5-flash");
            expect(modelId).toBe("google/gemini-2.5-flash");
        });

        it("should return null for no match", async () => {
            const modelId = await service.findModelId("nonexistent-model");
            expect(modelId).toBeNull();
        });
    });
});
