/**
 * Tests for multimodal content conversion
 *
 * These utilities convert text content with image URLs into
 * AI SDK multimodal content format (TextPart + ImagePart arrays).
 *
 * Note: Tests use real-looking domains (e.g., images.unsplash.com, cdn.jsdelivr.net)
 * because the module now skips reserved/example domains (example.com, localhost, etc.)
 * that would fail to fetch and crash the agent. See shouldSkipImageUrl for details.
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
            // Note: hasImageUrls still detects image URLs including on example domains
            // (it just checks for presence, doesn't filter by fetchability)
            expect(hasImageUrls("Check this: https://images.unsplash.com/image.jpg")).toBe(true);
        });

        it("should return false when content has no image URLs", () => {
            expect(hasImageUrls("Just text with https://somesite.com")).toBe(false);
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
            const content = "Check out this image: https://images.unsplash.com/photo.jpg";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            // First part should be text
            const textPart = result[0] as TextPart;
            expect(textPart.type).toBe("text");
            expect(textPart.text).toBe("Check out this image: https://images.unsplash.com/photo.jpg");

            // Second part should be image
            const imagePart = result[1] as ImagePart;
            expect(imagePart.type).toBe("image");
            expect(imagePart.image).toBeInstanceOf(URL);
            expect((imagePart.image as URL).href).toBe("https://images.unsplash.com/photo.jpg");
        });

        it("should handle multiple image URLs", () => {
            const content = "Two images: https://images.unsplash.com/a.png and https://cdn.jsdelivr.net/b.gif";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(3); // 1 text + 2 images

            const textPart = result[0] as TextPart;
            expect(textPart.type).toBe("text");

            const image1 = result[1] as ImagePart;
            expect(image1.type).toBe("image");
            expect((image1.image as URL).href).toBe("https://images.unsplash.com/a.png");

            const image2 = result[2] as ImagePart;
            expect(image2.type).toBe("image");
            expect((image2.image as URL).href).toBe("https://cdn.jsdelivr.net/b.gif");
        });

        it("should preserve empty string input", () => {
            const result = convertToMultimodalContent("");
            expect(result).toBe("");
        });

        it("should handle markdown image syntax", () => {
            const content = "![Alt text](https://images.unsplash.com/markdown-image.png)";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://images.unsplash.com/markdown-image.png");
        });

        it("should handle URLs with query parameters", () => {
            const content = "Image: https://cdn.jsdelivr.net/photo.jpg?width=800&height=600";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://cdn.jsdelivr.net/photo.jpg?width=800&height=600");
        });

        it("should deduplicate repeated image URLs", () => {
            const content = `
                First: https://images.unsplash.com/same.jpg
                Second: https://images.unsplash.com/same.jpg
            `;
            const result = convertToMultimodalContent(content) as MultimodalContent;

            // Should have text + only 1 image (deduplicated)
            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);
            expect((result[0] as TextPart).type).toBe("text");
            expect((result[1] as ImagePart).type).toBe("image");
        });

        it("should handle complex content with attribution prefix", () => {
            const content = "[@User -> @Agent] Here's an image for you: https://images.unsplash.com/shared.png";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            const textPart = result[0] as TextPart;
            expect(textPart.text).toContain("[@User -> @Agent]");

            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("https://images.unsplash.com/shared.png");
        });

        it("should ignore non-image URLs in the content", () => {
            const content = "Visit https://github.com and see https://github.com/page.html";
            const result = convertToMultimodalContent(content);

            // No image URLs, should return string
            expect(typeof result).toBe("string");
            expect(result).toBe(content);
        });

        it("should handle HTTP URLs (not just HTTPS)", () => {
            const content = "Old image: http://legacy.imgcdn.net/old.jpg";
            const result = convertToMultimodalContent(content) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            const imagePart = result[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe("http://legacy.imgcdn.net/old.jpg");
        });

        it("should handle all supported image extensions", () => {
            const extensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

            for (const ext of extensions) {
                // Use a real domain that won't be skipped
                const content = `Image: https://cdn.realsite.io/test${ext}`;
                const result = convertToMultimodalContent(content) as MultimodalContent;

                expect(Array.isArray(result)).toBe(true);
                expect(result.length).toBe(2);
                const imagePart = result[1] as ImagePart;
                expect(imagePart.type).toBe("image");
            }
        });
    });

    describe("non-fetchable URL handling (bug fix)", () => {
        it("should return string when all image URLs are on non-fetchable domains", () => {
            // Using example domains that should be skipped
            const exampleContent = "Check this: https://" + "example.com" + "/photo.jpg";
            const result = convertToMultimodalContent(exampleContent);

            // Should return string, not array, because the image URL was skipped
            expect(typeof result).toBe("string");
            expect(result).toBe(exampleContent);
        });

        it("should skip localhost image URLs", () => {
            const localhostContent = "Local image: http://localhost:3000/image.png";
            const result = convertToMultimodalContent(localhostContent);

            expect(typeof result).toBe("string");
            expect(result).toBe(localhostContent);
        });

        it("should skip loopback address image URLs", () => {
            const loopbackContent = "Image: http://127.0.0.1:8000/photo.jpg";
            const result = convertToMultimodalContent(loopbackContent);

            expect(typeof result).toBe("string");
            expect(result).toBe(loopbackContent);
        });

        it("should convert real domain URLs while skipping example domains", () => {
            // Mix of real and example domain URLs
            const exampleUrl = "https://" + "example.com" + "/skip-this.jpg";
            const realUrl = "https://images.unsplash.com/fetch-this.png";
            const mixedContent = `Images: ${exampleUrl} and ${realUrl}`;

            const result = convertToMultimodalContent(mixedContent) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2); // TextPart + 1 ImagePart (only the real URL)

            const textPart = result[0] as TextPart;
            expect(textPart.type).toBe("text");
            expect(textPart.text).toBe(mixedContent);

            const imagePart = result[1] as ImagePart;
            expect(imagePart.type).toBe("image");
            expect((imagePart.image as URL).href).toBe(realUrl);
        });

        it("should skip subdomains of example domains", () => {
            const cdnExampleContent = "CDN image: https://cdn." + "example.org" + "/banner.webp";
            const result = convertToMultimodalContent(cdnExampleContent);

            expect(typeof result).toBe("string");
            expect(result).toBe(cdnExampleContent);
        });

        it("should skip .test TLD domains", () => {
            const testTldContent = "Test image: https://myapp.test/photo.jpg";
            const result = convertToMultimodalContent(testTldContent);

            expect(typeof result).toBe("string");
            expect(result).toBe(testTldContent);
        });

        it("should NOT skip domains that just contain 'example' as substring", () => {
            const realContent = "Real site: https://myexample.io/photo.jpg";
            const result = convertToMultimodalContent(realContent) as MultimodalContent;

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);

            const imagePart = result[1] as ImagePart;
            expect(imagePart.type).toBe("image");
            expect((imagePart.image as URL).href).toBe("https://myexample.io/photo.jpg");
        });
    });
});
