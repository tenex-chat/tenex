/**
 * Tests for multimodal content conversion
 *
 * These utilities convert text content with image URLs into
 * AI SDK multimodal content format (TextPart + ImagePart arrays).
 */

import { describe, it, expect } from "bun:test";
import type { TextPart, ImagePart } from "ai";
import {
    convertToMultimodalContent,
    hasImageUrls,
    type MultimodalContent,
} from "../multimodal-content";

describe("multimodal-content", () => {
    describe("hasImageUrls", () => {
        it("should return true when content contains image URLs", () => {
            expect(hasImageUrls("Check this: https://example.com/image.jpg")).toBe(true);
        });

        it("should return false when content has no image URLs", () => {
            expect(hasImageUrls("Just text with https://example.com")).toBe(false);
        });

        it("should return false for empty content", () => {
            expect(hasImageUrls("")).toBe(false);
        });
    });

    describe("convertToMultimodalContent", () => {
        it("should return string for content without image URLs", () => {
            const result = convertToMultimodalContent("Hello, world!");
            expect(result).toBe("Hello, world!");
        });

        it("should convert single image URL to multimodal content", () => {
            const content = "Check out this image: https://example.com/photo.jpg";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            // First part should be text
            const textPart = result[0] as TextPart;
            expect(textPart.type).toBe("text");
            expect(textPart.text).toBe("Check out this image: https://example.com/photo.jpg");

            // Second part should be image
            const imagePart = result[1] as ImagePart;
            expect(imagePart.type).toBe("image");
            expect(imagePart.image).toBeInstanceOf(URL);
            expect((imagePart.image as URL).href).toBe("https://example.com/photo.jpg");
        });

        it("should handle multiple image URLs", () => {
            const content = "Two images: https://example.com/a.png and https://example.com/b.gif";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(3); // 1 text + 2 images

            const textPart = result[0] as TextPart;
            expect(textPart.type).toBe("text");

            const image1 = result[1] as ImagePart;
            expect(image1.type).toBe("image");
            expect((image1.image as URL).href).toBe("https://example.com/a.png");

            const image2 = result[2] as ImagePart;
            expect(image2.type).toBe("image");
            expect((image2.image as URL).href).toBe("https://example.com/b.gif");
        });

        it("should preserve empty string input", () => {
            const result = convertToMultimodalContent("");
            expect(result).toBe("");
        });

        it("should handle markdown image syntax", () => {
            const content = "![Alt text](https://example.com/markdown-image.png)";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://example.com/markdown-image.png");
        });

        it("should handle URLs with query parameters", () => {
            const content = "Image: https://cdn.example.com/photo.jpg?width=800&height=600";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://cdn.example.com/photo.jpg?width=800&height=600");
        });

        it("should deduplicate repeated image URLs", () => {
            const content = `
                First: https://example.com/same.jpg
                Second: https://example.com/same.jpg
            `;
            const result = convertToMultimodalContent(content) as MultimodalContent;

            // Should have text + only 1 image (deduplicated)
            expect(result.length).toBe(2);
            expect((result[0] as TextPart).type).toBe("text");
            expect((result[1] as ImagePart).type).toBe("image");
        });

        it("should handle complex content with attribution prefix", () => {
            const content = "[@User -> @Agent] Here's an image for you: https://example.com/shared.png";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            const textPart = result[0] as TextPart;
            expect(textPart.text).toContain("[@User -> @Agent]");

            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://example.com/shared.png");
        });

        it("should ignore non-image URLs in the content", () => {
            const content = "Visit https://example.com and see https://example.com/page.html";
            const result = convertToMultimodalContent(content);

            // No image URLs, should return string
            expect(typeof result).toBe("string");
            expect(result).toBe(content);
        });

        it("should handle HTTP URLs (not just HTTPS)", () => {
            const content = "Old image: http://legacy.example.com/old.jpg";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("http://legacy.example.com/old.jpg");
        });

        it("should handle all supported image extensions", () => {
            const extensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

            for (const ext of extensions) {
                const content = `Image: https://example.com/test${ext}`;
                const result = convertToMultimodalContent(content) as MultimodalContent;

                expect(Array.isArray(result)).toBe(true);
                expect(result.length).toBe(2);
                const imagePart = result[1] as ImagePart;
                expect(imagePart.type).toBe("image");
            }
        });
    });
});
