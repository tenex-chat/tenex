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
    shouldSkipImageUrl,
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

    describe("shouldSkipImageUrl", () => {
        describe("RFC 2606 reserved domains", () => {
            it("should skip URLs with top-level example domains", () => {
                // Note: Using string concatenation to avoid triggering image URL parsing
                const exampleCom = "https://" + "example.com" + "/photo.jpg";
                const exampleOrg = "https://" + "example.org" + "/photo.png";
                const exampleNet = "https://" + "example.net" + "/image.gif";
                const exampleEdu = "https://" + "example.edu" + "/banner.webp";

                expect(shouldSkipImageUrl(exampleCom)).toBe(true);
                expect(shouldSkipImageUrl(exampleOrg)).toBe(true);
                expect(shouldSkipImageUrl(exampleNet)).toBe(true);
                expect(shouldSkipImageUrl(exampleEdu)).toBe(true);
            });

            it("should skip URLs with subdomains of example domains", () => {
                const cdnExample = "https://cdn." + "example.com" + "/photo.jpg";
                const wwwExample = "https://www." + "example.org" + "/image.png";
                const imgExample = "https://img." + "example.net" + "/banner.gif";

                expect(shouldSkipImageUrl(cdnExample)).toBe(true);
                expect(shouldSkipImageUrl(wwwExample)).toBe(true);
                expect(shouldSkipImageUrl(imgExample)).toBe(true);
            });

            it("should skip URLs with .example TLD", () => {
                expect(shouldSkipImageUrl("https://mysite.example/photo.jpg")).toBe(true);
                expect(shouldSkipImageUrl("https://test.mysite.example/image.png")).toBe(true);
            });
        });

        describe("localhost and loopback addresses", () => {
            it("should skip localhost URLs", () => {
                expect(shouldSkipImageUrl("http://localhost/image.jpg")).toBe(true);
                expect(shouldSkipImageUrl("http://localhost:3000/photo.png")).toBe(true);
                expect(shouldSkipImageUrl("https://localhost:8080/banner.gif")).toBe(true);
            });

            it("should skip IPv4 loopback addresses", () => {
                expect(shouldSkipImageUrl("http://127.0.0.1/image.jpg")).toBe(true);
                expect(shouldSkipImageUrl("http://127.0.0.1:8000/photo.png")).toBe(true);
                expect(shouldSkipImageUrl("http://0.0.0.0/banner.gif")).toBe(true);
            });

            it("should skip .localhost TLD", () => {
                expect(shouldSkipImageUrl("http://myapp.localhost/image.jpg")).toBe(true);
                expect(shouldSkipImageUrl("http://api.myapp.localhost:3000/photo.png")).toBe(true);
            });
        });

        describe("other reserved TLDs (RFC 6761)", () => {
            it("should skip .test TLD", () => {
                expect(shouldSkipImageUrl("https://mysite.test/image.jpg")).toBe(true);
                expect(shouldSkipImageUrl("https://app.mysite.test/photo.png")).toBe(true);
            });

            it("should skip .invalid TLD", () => {
                expect(shouldSkipImageUrl("https://broken.invalid/image.jpg")).toBe(true);
            });

            it("should skip .local TLD", () => {
                expect(shouldSkipImageUrl("https://printer.local/image.jpg")).toBe(true);
                expect(shouldSkipImageUrl("http://server.local:8080/photo.png")).toBe(true);
            });
        });

        describe("valid fetchable URLs", () => {
            it("should NOT skip real domain URLs", () => {
                expect(shouldSkipImageUrl("https://images.unsplash.com/photo.jpg")).toBe(false);
                expect(shouldSkipImageUrl("https://cdn.jsdelivr.net/image.png")).toBe(false);
                expect(shouldSkipImageUrl("https://github.com/user/repo/image.gif")).toBe(false);
                expect(shouldSkipImageUrl("https://i.imgur.com/photo.webp")).toBe(false);
            });

            it("should NOT skip domains that contain 'example' but are not reserved", () => {
                // These are real domains that happen to contain 'example' in their name
                expect(shouldSkipImageUrl("https://myexample.com/photo.jpg")).toBe(false);
                expect(shouldSkipImageUrl("https://examplesite.io/image.png")).toBe(false);
            });

            it("should NOT skip domains that contain 'local' but are not .local TLD", () => {
                expect(shouldSkipImageUrl("https://localstack.io/image.jpg")).toBe(false);
                expect(shouldSkipImageUrl("https://localhost-cdn.com/photo.png")).toBe(false);
            });
        });

        describe("edge cases", () => {
            it("should skip empty URLs", () => {
                expect(shouldSkipImageUrl("")).toBe(true);
            });

            it("should skip invalid URLs", () => {
                expect(shouldSkipImageUrl("not-a-url")).toBe(true);
                expect(shouldSkipImageUrl("/path/to/image.jpg")).toBe(true);
            });

            it("should handle URLs with query parameters and fragments", () => {
                const exampleWithQuery = "https://" + "example.com" + "/photo.jpg?size=large";
                const exampleWithFragment = "https://" + "example.com" + "/photo.jpg#section";

                expect(shouldSkipImageUrl(exampleWithQuery)).toBe(true);
                expect(shouldSkipImageUrl(exampleWithFragment)).toBe(true);
            });

            it("should be case-insensitive for hostname matching", () => {
                const upperExample = "https://EXAMPLE.COM/photo.jpg";
                const mixedExample = "https://Example.Org/image.png";
                const upperLocalhost = "https://LOCALHOST/banner.gif";

                expect(shouldSkipImageUrl(upperExample)).toBe(true);
                expect(shouldSkipImageUrl(mixedExample)).toBe(true);
                expect(shouldSkipImageUrl(upperLocalhost)).toBe(true);
            });
        });
    });
});
