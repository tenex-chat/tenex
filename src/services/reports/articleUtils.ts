import type { NDKArticle } from "@nostr-dev-kit/ndk";
import type { ReportInfo } from "./ReportService";

/**
 * Centralized utility for converting NDKArticle to ReportInfo.
 * This is the single source of truth for article-to-report conversion,
 * used by both ReportService and ProjectContext.
 */
export function articleToReportInfo(article: NDKArticle): ReportInfo {
    // Extract hashtags from tags (excluding the "memorize" and "memorize_team" tags)
    const hashtags = article.tags
        .filter((tag: string[]) => tag[0] === "t" && tag[1] !== "memorize" && tag[1] !== "memorize_team")
        .map((tag: string[]) => tag[1]);

    // Extract project reference if present
    const projectTag = article.tags.find(
        (tag: string[]) => tag[0] === "a" && tag[1]?.includes(":31933:")
    );
    const projectReference = projectTag ? projectTag[1] : undefined;

    // Check if deleted
    const isDeleted = article.tags.some((tag: string[]) => tag[0] === "deleted");

    // Check if memorized (for the authoring agent only)
    const isMemorized = article.tags.some(
        (tag: string[]) => tag[0] === "t" && tag[1] === "memorize"
    );

    // Check if team-memorized (for ALL agents in the project)
    const isMemorizedTeam = article.tags.some(
        (tag: string[]) => tag[0] === "t" && tag[1] === "memorize_team"
    );

    // Get author hex pubkey directly from the event
    // Internal data should always use hex format, not npub
    const authorPubkey = article.pubkey;

    return {
        id: `nostr:${article.encode()}`,
        slug: article.dTag || "",
        title: article.title,
        summary: article.summary,
        content: article.content,
        author: authorPubkey,
        publishedAt: article.published_at,
        hashtags: hashtags.length > 0 ? hashtags : undefined,
        projectReference,
        isDeleted,
        isMemorized,
        isMemorizedTeam,
    };
}
