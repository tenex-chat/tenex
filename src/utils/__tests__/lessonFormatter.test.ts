import { beforeEach, describe, expect, it } from "bun:test";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { formatLessonsForAgent } from "../lessonFormatter";

describe("formatLessonsForAgent", () => {
    let mockLessons: NDKAgentLesson[];

    beforeEach(() => {
        mockLessons = [
            {
                title: "Lesson 1",
                lesson: "Content of lesson 1",
                created_at: 1000,
                quality: "high",
                tags: [["phase", "execute"]],
            } as NDKAgentLesson,
            {
                title: "Lesson 2",
                content: "Content of lesson 2",
                created_at: 2000,
                quality: "medium",
                tags: [["phase", "planning"]],
            } as NDKAgentLesson,
            {
                title: "Lesson 3",
                lesson: "Content of lesson 3",
                created_at: 3000,
                quality: "low",
                tags: [],
            } as NDKAgentLesson,
        ];
    });

    it("should return empty string for empty lessons array", () => {
        const result = formatLessonsForAgent([]);
        expect(result).toBe("");
    });

    it("should format lessons with header", () => {
        const result = formatLessonsForAgent(mockLessons);
        expect(result).toContain("## Lessons Learned (3 most recent)");
    });

    it("should sort lessons by creation time (newest first)", () => {
        const result = formatLessonsForAgent(mockLessons);

        // Check that Lesson 3 (newest) comes first
        expect(result.indexOf("Lesson 3")).toBeLessThan(result.indexOf("Lesson 2"));
        expect(result.indexOf("Lesson 2")).toBeLessThan(result.indexOf("Lesson 1"));
    });

    it("should include phase information when available", () => {
        const result = formatLessonsForAgent(mockLessons);
        expect(result).toContain("Lesson 1 (execute)");
        expect(result).toContain("Lesson 2 (planning)");
    });

    it("should include quality information", () => {
        const result = formatLessonsForAgent(mockLessons);
        expect(result).toContain("[high]");
        expect(result).toContain("[medium]");
        expect(result).toContain("[low]");
    });

    it("should handle lessons without title", () => {
        const lessonsWithoutTitle = [
            {
                lesson: "Content without title",
                created_at: 1000,
                tags: [],
            } as NDKAgentLesson,
        ];

        const result = formatLessonsForAgent(lessonsWithoutTitle);
        expect(result).toContain("Untitled Lesson");
    });

    it("should use content field if lesson field is not available", () => {
        const lessonWithContent = [
            {
                title: "Test Lesson",
                content: "This is the content field",
                created_at: 1000,
                tags: [],
            } as NDKAgentLesson,
        ];

        const result = formatLessonsForAgent(lessonWithContent);
        expect(result).toContain("This is the content field");
    });

    it("should handle lessons without content gracefully", () => {
        const emptyLesson = [
            {
                title: "Empty Lesson",
                created_at: 1000,
                tags: [],
            } as NDKAgentLesson,
        ];

        const result = formatLessonsForAgent(emptyLesson);
        expect(result).toContain("Empty Lesson");
        expect(result).toContain("[unknown]");
    });

    it("should limit to 50 lessons maximum", () => {
        const manyLessons: NDKAgentLesson[] = [];
        for (let i = 0; i < 60; i++) {
            manyLessons.push({
                title: `Lesson ${i}`,
                lesson: `Content ${i}`,
                created_at: i,
                tags: [],
            } as NDKAgentLesson);
        }

        const result = formatLessonsForAgent(manyLessons);
        expect(result).toContain("## Lessons Learned (50 most recent)");

        // Should include newest lessons (59, 58, etc)
        expect(result).toContain("Lesson 59");
        // Should not include oldest lessons
        expect(result).not.toContain("Lesson 9");
    });

    it("should format lessons with proper numbering", () => {
        const result = formatLessonsForAgent(mockLessons);
        expect(result).toContain("#1:");
        expect(result).toContain("#2:");
        expect(result).toContain("#3:");
    });

    it("should separate lessons with double newlines", () => {
        const result = formatLessonsForAgent(mockLessons);
        const lessonsSection = result.split("## Lessons Learned")[1];
        const doublNewlines = (lessonsSection.match(/\n\n/g) || []).length;
        expect(doublNewlines).toBeGreaterThanOrEqual(2); // At least 2 separators for 3 lessons
    });
});
