export class DotenvParseError extends Error {
    readonly line: number;
    readonly reason: string;

    constructor(line: number, reason: string) {
        super(`Invalid .env syntax on line ${line}: ${reason}`);
        this.name = "DotenvParseError";
        this.line = line;
        this.reason = reason;
    }
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseDoubleQuotedValue(value: string): string {
    return value.replace(/\\([\\nrt"])/g, (_match, escaped: string) => {
        switch (escaped) {
            case "n":
                return "\n";
            case "r":
                return "\r";
            case "t":
                return "\t";
            case "\"":
                return "\"";
            case "\\":
                return "\\";
            default:
                return escaped;
        }
    });
}

function stripInlineComment(value: string): string {
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const previousCharacter = index > 0 ? value[index - 1] : "";
        if (character === "#" && (index === 0 || /\s/.test(previousCharacter))) {
            return value.slice(0, index).trimEnd();
        }
    }

    return value.trimEnd();
}

function parseValue(rawValue: string, lineNumber: number): string {
    if (rawValue.length === 0) {
        return "";
    }

    const quote = rawValue[0];
    if (quote !== "\"" && quote !== "'") {
        return stripInlineComment(rawValue);
    }

    let index = 1;
    let value = "";

    while (index < rawValue.length) {
        const character = rawValue[index];

        if (character === quote && (quote === "'" || rawValue[index - 1] !== "\\")) {
            const remainder = rawValue.slice(index + 1).trim();
            if (remainder.length > 0 && !remainder.startsWith("#")) {
                throw new DotenvParseError(
                    lineNumber,
                    "unexpected characters after quoted value"
                );
            }

            return quote === "\"" ? parseDoubleQuotedValue(value) : value;
        }

        value += character;
        index += 1;
    }

    throw new DotenvParseError(lineNumber, "unterminated quoted value");
}

export function parseDotenv(content: string): Record<string, string> {
    const parsed: Record<string, string> = {};
    const lines = content.split(/\r?\n/);

    for (const [index, originalLine] of lines.entries()) {
        const lineNumber = index + 1;
        const trimmedLine = originalLine.trim();

        if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
            continue;
        }

        let line = originalLine.trimStart();
        if (line.startsWith("export") && /\s/.test(line[6] ?? "")) {
            line = line.slice(6).trimStart();
        }

        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) {
            throw new DotenvParseError(lineNumber, "expected KEY=value assignment");
        }

        const key = line.slice(0, separatorIndex).trim();
        if (!KEY_PATTERN.test(key)) {
            throw new DotenvParseError(lineNumber, `invalid variable name "${key}"`);
        }

        const rawValue = line.slice(separatorIndex + 1).trimStart();
        parsed[key] = parseValue(rawValue, lineNumber);
    }

    return parsed;
}
