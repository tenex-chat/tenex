import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import type { ConfigService } from "@/services/ConfigService";
import type { TelegramBotClient } from "@/services/telegram/TelegramBotClient";

const MIME_TO_EXT: Record<string, string> = {
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
};

function extensionFromMimeType(mimeType?: string): string {
    if (!mimeType) return "";
    const mapped = MIME_TO_EXT[mimeType];
    if (mapped) return mapped;
    const parts = mimeType.split("/");
    return parts.length === 2 ? `.${parts[1]}` : "";
}

export interface MediaDownloadResult {
    localPath: string;
}

export class TelegramMediaDownloadService {
    private readonly configService: ConfigService;

    constructor(configService: ConfigService) {
        this.configService = configService;
    }

    async download(
        botClient: TelegramBotClient,
        fileId: string,
        fileUniqueId: string,
        mimeType?: string
    ): Promise<MediaDownloadResult> {
        const { file_path: filePath } = await botClient.getFile(fileId);
        const downloadUrl = botClient.getFileDownloadUrl(filePath);

        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error(
                `Failed to download Telegram file: ${response.status} ${response.statusText}`
            );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = extensionFromMimeType(mimeType);
        const mediaDir = this.configService.getConfigPath("telegram/media");
        await mkdir(mediaDir, { recursive: true });

        const localPath = join(mediaDir, `${fileUniqueId}${ext}`);
        await writeFile(localPath, buffer);

        return { localPath };
    }
}
