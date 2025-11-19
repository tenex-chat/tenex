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
