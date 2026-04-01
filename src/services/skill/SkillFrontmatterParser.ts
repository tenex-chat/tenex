export const FRONTMATTER_DELIMITER = "---";
export const FRONTMATTER_METADATA_FIELD = "metadata";
export const TENEX_METADATA_EVENT_ID_KEY = "tenex-event-id";

export interface StoredSkillMetadata {
    eventId?: string;
    name?: string;
    description?: string;
}

export interface ParsedSkillDocument {
    content: string;
    metadata?: StoredSkillMetadata;
}

export function normalizeStoredSkillMetadata(
    metadata: StoredSkillMetadata | undefined
): StoredSkillMetadata | undefined {
    if (!metadata) {
        return undefined;
    }

    const normalized: StoredSkillMetadata = {
        eventId: metadata.eventId?.trim() || undefined,
        name: metadata.name?.trim() || undefined,
        description: metadata.description?.trim() || undefined,
    };

    return Object.values(normalized).some((value) => value !== undefined)
        ? normalized
        : undefined;
}

export function countIndent(line: string): number {
    return line.length - line.trimStart().length;
}

export function stripInlineYamlComment(value: string): string {
    let inSingleQuotes = false;
    let inDoubleQuotes = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const previousCharacter = index > 0 ? value[index - 1] : "";

        if (character === "'" && !inDoubleQuotes) {
            inSingleQuotes = !inSingleQuotes;
            continue;
        }

        if (character === "\"" && !inSingleQuotes && previousCharacter !== "\\") {
            inDoubleQuotes = !inDoubleQuotes;
            continue;
        }

        if (
            character === "#" &&
            !inSingleQuotes &&
            !inDoubleQuotes &&
            (index === 0 || /\s/.test(previousCharacter))
        ) {
            return value.slice(0, index).trimEnd();
        }
    }

    return value;
}

export function parseYamlScalarValue(value: string): string {
    const trimmedValue = stripInlineYamlComment(value.trim());

    if (!trimmedValue) {
        return "";
    }

    if (
        trimmedValue.length >= 2 &&
        trimmedValue.startsWith("\"") &&
        trimmedValue.endsWith("\"")
    ) {
        try {
            return JSON.parse(trimmedValue) as string;
        } catch {
            return trimmedValue.slice(1, -1);
        }
    }

    if (
        trimmedValue.length >= 2 &&
        trimmedValue.startsWith("'") &&
        trimmedValue.endsWith("'")
    ) {
        return trimmedValue.slice(1, -1).replace(/''/g, "'");
    }

    return trimmedValue;
}

export function readYamlValue(
    lines: string[],
    startIndex: number,
    parentIndent: number,
    rawValue: string
): { nextIndex: number; value: string } {
    const trimmedValue = rawValue.trim();
    if (trimmedValue !== "|" && trimmedValue !== ">") {
        return {
            nextIndex: startIndex + 1,
            value: parseYamlScalarValue(rawValue),
        };
    }

    const collectedLines: string[] = [];
    let lineIndex = startIndex + 1;
    let blockIndent = -1;

    while (lineIndex < lines.length) {
        const nextLine = lines[lineIndex];
        const nextIndent = countIndent(nextLine);

        if (nextLine.trim().length === 0) {
            collectedLines.push("");
            lineIndex += 1;
            continue;
        }

        if (nextIndent <= parentIndent) {
            break;
        }

        if (blockIndent === -1) {
            blockIndent = nextIndent;
        }

        const contentStart = Math.min(nextLine.length, blockIndent);
        collectedLines.push(nextLine.slice(contentStart));
        lineIndex += 1;
    }

    return {
        nextIndex: lineIndex,
        value: trimmedValue === ">" ? collectedLines.join(" ").trim() : collectedLines.join("\n").trim(),
    };
}

export function parseSkillFrontmatter(frontmatterBlock: string): StoredSkillMetadata | undefined {
    const lines = frontmatterBlock.replace(/\r\n/g, "\n").split("\n");
    const metadataValues: Record<string, string> = {};
    let name: string | undefined;
    let description: string | undefined;
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        const line = lines[lineIndex];
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#")) {
            lineIndex += 1;
            continue;
        }

        const indent = countIndent(line);
        if (indent > 0) {
            lineIndex += 1;
            continue;
        }

        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) {
            lineIndex += 1;
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1);

        if (key === FRONTMATTER_METADATA_FIELD && stripInlineYamlComment(rawValue).trim().length === 0) {
            lineIndex += 1;
            while (lineIndex < lines.length) {
                const nestedLine = lines[lineIndex];
                const nestedTrimmedLine = nestedLine.trim();

                if (!nestedTrimmedLine || nestedTrimmedLine.startsWith("#")) {
                    lineIndex += 1;
                    continue;
                }

                const nestedIndent = countIndent(nestedLine);
                if (nestedIndent <= indent) {
                    break;
                }

                const nestedSeparatorIndex = nestedTrimmedLine.indexOf(":");
                if (nestedSeparatorIndex <= 0) {
                    lineIndex += 1;
                    continue;
                }

                const nestedKey = nestedTrimmedLine.slice(0, nestedSeparatorIndex).trim();
                const nestedRawValue = nestedTrimmedLine.slice(nestedSeparatorIndex + 1);
                const nestedValue = readYamlValue(lines, lineIndex, nestedIndent, nestedRawValue);
                metadataValues[nestedKey] = nestedValue.value;
                lineIndex = nestedValue.nextIndex;
            }
            continue;
        }

        const parsedValue = readYamlValue(lines, lineIndex, indent, rawValue);
        if (key === "name" && parsedValue.value) {
            name = parsedValue.value;
        }
        if (key === "description" && parsedValue.value) {
            description = parsedValue.value;
        }
        lineIndex = parsedValue.nextIndex;
    }

    return normalizeStoredSkillMetadata({
        eventId: metadataValues[TENEX_METADATA_EVENT_ID_KEY],
        name,
        description,
    });
}

export function parseSkillDocument(rawContent: string): ParsedSkillDocument {
    const normalizedContent = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

    if (!normalizedContent.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
        return {
            content: normalizedContent.trim(),
        };
    }

    const lines = normalizedContent.split("\n");
    const closingDelimiterIndex = lines.findIndex(
        (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER
    );

    if (closingDelimiterIndex === -1) {
        return {
            content: normalizedContent.trim(),
        };
    }

    const frontmatterBlock = lines.slice(1, closingDelimiterIndex).join("\n");
    const body = lines.slice(closingDelimiterIndex + 1).join("\n").trim();
    const metadata = parseSkillFrontmatter(frontmatterBlock);

    return {
        content: body,
        metadata,
    };
}

export function formatYamlScalar(value: string): string {
    return JSON.stringify(value);
}

export function serializeSkillDocument(content: string, metadata: StoredSkillMetadata): string {
    const lines = [
        FRONTMATTER_DELIMITER,
        `name: ${formatYamlScalar(metadata.name ?? "skill")}`,
        `description: ${formatYamlScalar(metadata.description ?? "")}`,
    ];

    const metadataEntries = [[TENEX_METADATA_EVENT_ID_KEY, metadata.eventId]].filter(
        (entry): entry is [string, string] => Boolean(entry[1])
    );

    if (metadataEntries.length > 0) {
        lines.push(`${FRONTMATTER_METADATA_FIELD}:`);
        for (const [key, value] of metadataEntries) {
            lines.push(`  ${key}: ${formatYamlScalar(value)}`);
        }
    }

    return `${lines.join("\n")}\n${FRONTMATTER_DELIMITER}\n\n${content.trim()}`;
}
