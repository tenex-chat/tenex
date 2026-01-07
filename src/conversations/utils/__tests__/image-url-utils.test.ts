/**
 * Tests for image URL detection and extraction utilities
 *
 * These utilities detect image URLs in message content and help convert
 * messages to multimodal format for the AI SDK.
 */

import { describe, it, expect } from "bun:test";
import {
    isImageUrl,
    extractImageUrls,
    IMAGE_EXTENSIONS,
} from "../image-url-utils";

describe("image-url-utils", () => {
    describe("isImageUrl", () => {
        it("should detect URLs ending with .jpg", () => {
            expect(isImageUrl("https://example.com/image.jpg")).toBe(true);
        });

        it("should detect URLs ending with .jpeg", () => {
            expect(isImageUrl("https://example.com/image.jpeg")).toBe(true);
        });

        it("should detect URLs ending with .png", () => {
            expect(isImageUrl("https://example.com/image.png")).toBe(true);
        });

        it("should detect URLs ending with .gif", () => {
            expect(isImageUrl("https://example.com/image.gif")).toBe(true);
        });

        it("should detect URLs ending with .webp", () => {
            expect(isImageUrl("https://example.com/image.webp")).toBe(true);
        });

        it("should detect URLs ending with .svg", () => {
            expect(isImageUrl("https://example.com/image.svg")).toBe(true);
        });

        it("should be case-insensitive", () => {
            expect(isImageUrl("https://example.com/image.JPG")).toBe(true);
            expect(isImageUrl("https://example.com/image.PNG")).toBe(true);
            expect(isImageUrl("https://example.com/image.GIF")).toBe(true);
        });

        it("should handle URLs with query parameters", () => {
            expect(isImageUrl("https://example.com/image.jpg?size=large")).toBe(true);
            expect(isImageUrl("https://example.com/image.png?width=100&height=100")).toBe(true);
        });

        it("should handle URLs with fragments", () => {
            expect(isImageUrl("https://example.com/image.jpg#section")).toBe(true);
        });

        it("should return false for non-image URLs", () => {
            expect(isImageUrl("https://example.com/document.pdf")).toBe(false);
            expect(isImageUrl("https://example.com/page.html")).toBe(false);
            expect(isImageUrl("https://example.com/video.mp4")).toBe(false);
            expect(isImageUrl("https://example.com/")).toBe(false);
        });

        it("should return false for non-URL strings", () => {
            expect(isImageUrl("not a url")).toBe(false);
            expect(isImageUrl("image.jpg")).toBe(false);
            expect(isImageUrl("/path/to/image.jpg")).toBe(false);
        });

        it("should return false for empty or invalid input", () => {
            expect(isImageUrl("")).toBe(false);
        });
    });

    describe("extractImageUrls", () => {
        it("should extract a single image URL from text", () => {
            const text = "Check out this image: https://example.com/photo.jpg";
            const result = extractImageUrls(text);
            expect(result).toEqual(["https://example.com/photo.jpg"]);
        });

        it("should extract multiple image URLs from text", () => {
            const text = "Here are two images: https://example.com/a.png and https://example.com/b.gif";
            const result = extractImageUrls(text);
            expect(result).toEqual([
                "https://example.com/a.png",
                "https://example.com/b.gif"
            ]);
        });

        it("should return empty array when no image URLs found", () => {
            const text = "This is just text with no images";
            const result = extractImageUrls(text);
            expect(result).toEqual([]);
        });

        it("should not extract non-image URLs", () => {
            const text = "Visit https://example.com and check https://example.com/page.html";
            const result = extractImageUrls(text);
            expect(result).toEqual([]);
        });

        it("should extract image URLs with query parameters", () => {
            const text = "Image with params: https://example.com/photo.jpg?size=large&quality=high";
            const result = extractImageUrls(text);
            expect(result).toEqual(["https://example.com/photo.jpg?size=large&quality=high"]);
        });

        it("should handle URLs in markdown image syntax", () => {
            const text = "![Alt text](https://example.com/image.png)";
            const result = extractImageUrls(text);
            expect(result).toEqual(["https://example.com/image.png"]);
        });

        it("should handle URLs in markdown link syntax", () => {
            const text = "[Click here](https://example.com/image.jpg)";
            const result = extractImageUrls(text);
            expect(result).toEqual(["https://example.com/image.jpg"]);
        });

        it("should handle mixed content with images and non-images", () => {
            const text = `
                Here's a document: https://example.com/doc.pdf
                And an image: https://example.com/photo.png
                And a video: https://example.com/video.mp4
                And another image: https://cdn.example.com/banner.webp
            `;
            const result = extractImageUrls(text);
            expect(result).toEqual([
                "https://example.com/photo.png",
                "https://cdn.example.com/banner.webp"
            ]);
        });

        it("should deduplicate repeated image URLs", () => {
            const text = `
                Image 1: https://example.com/photo.jpg
                Same image again: https://example.com/photo.jpg
            `;
            const result = extractImageUrls(text);
            expect(result).toEqual(["https://example.com/photo.jpg"]);
        });

        it("should handle empty string", () => {
            expect(extractImageUrls("")).toEqual([]);
        });

        it("should handle HTTP URLs (not just HTTPS)", () => {
            const text = "Old image: http://example.com/old.jpg";
            const result = extractImageUrls(text);
            expect(result).toEqual(["http://example.com/old.jpg"]);
        });
    });

    describe("IMAGE_EXTENSIONS", () => {
        it("should include common image extensions", () => {
            expect(IMAGE_EXTENSIONS).toContain(".jpg");
            expect(IMAGE_EXTENSIONS).toContain(".jpeg");
            expect(IMAGE_EXTENSIONS).toContain(".png");
            expect(IMAGE_EXTENSIONS).toContain(".gif");
            expect(IMAGE_EXTENSIONS).toContain(".webp");
            expect(IMAGE_EXTENSIONS).toContain(".svg");
        });
    });
});
