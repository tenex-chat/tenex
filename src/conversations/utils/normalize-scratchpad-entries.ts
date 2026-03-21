export function normalizeScratchpadEntries(
    entries: Record<string, unknown> | undefined
): Record<string, string> | undefined {
    const normalizedEntries = Object.entries(entries ?? {})
        .flatMap(([key, value]) => {
            if (typeof value !== "string") {
                return [];
            }

            const normalizedKey = key.trim();
            const normalizedValue = value.trim();

            if (normalizedKey.length === 0 || normalizedValue.length === 0) {
                return [];
            }

            return [[normalizedKey, normalizedValue] as const];
        })
        .sort(([left], [right]) => left.localeCompare(right));

    if (normalizedEntries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(normalizedEntries);
}
