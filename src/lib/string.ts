/**
 * Converts a string to kebab-case format
 * @param str - The input string to convert
 * @returns The kebab-case formatted string
 * @example
 * toKebabCase("HelloWorld") // "hello-world"
 * toKebabCase("hello_world") // "hello-world"
 * toKebabCase("Hello World") // "hello-world"
 */
export function toKebabCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
}

/**
 * Sluggify free-form text into a stable, prompt-safe identifier.
 *
 * Unlike toKebabCase(), this also removes punctuation, trims separator runs,
 * and normalizes diacritics so human-facing titles can be safely used as IDs.
 */
export function slugifyIdentifier(str: string): string {
    return toKebabCase(
        str
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^A-Za-z0-9]+/g, "-")
    )
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
