import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { ProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";

export interface LessonMetrics {
    totalLessons: number;
    lessonsByAgent: Map<string, number>;
    lessonsByPhase: Map<string, number>;
    mostCommonKeywords: Array<{ keyword: string; count: number }>;
    averageLessonLength: number;
    oldestLesson?: Date;
    newestLesson?: Date;
}

/**
 * Calculate comprehensive metrics for lessons in a project
 */
export function calculateLessonMetrics(projectCtx: ProjectContext): LessonMetrics {
    const allLessons = projectCtx.getAllLessons();

    const lessonsByAgent = new Map<string, number>();
    const lessonsByPhase = new Map<string, number>();
    const keywordCounts = new Map<string, number>();
    let totalLength = 0;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    let newestTimestamp = 0;

    for (const lesson of allLessons) {
        // Count by agent
        const agentName =
            Array.from(projectCtx.agents.values()).find((a) => a.pubkey === lesson.pubkey)?.name ||
            "Unknown";
        lessonsByAgent.set(agentName, (lessonsByAgent.get(agentName) || 0) + 1);

        // Count by phase
        const phase = lesson.tags.find((tag) => tag[0] === "phase")?.[1] || "unknown";
        lessonsByPhase.set(phase, (lessonsByPhase.get(phase) || 0) + 1);

        // Count keywords
        const keywords = lesson.tags.filter((tag) => tag[0] === "t");
        for (const [, keyword] of keywords) {
            if (keyword) {
                keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
            }
        }

        // Track lesson length
        const content = lesson.lesson || lesson.content || "";
        totalLength += content.length;

        // Track timestamps
        const timestamp = lesson.created_at || 0;
        if (timestamp < oldestTimestamp && timestamp > 0) oldestTimestamp = timestamp;
        if (timestamp > newestTimestamp) newestTimestamp = timestamp;
    }

    // Sort keywords by frequency
    const mostCommonKeywords = Array.from(keywordCounts.entries())
        .map(([keyword, count]) => ({ keyword, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    return {
        totalLessons: allLessons.length,
        lessonsByAgent,
        lessonsByPhase,
        mostCommonKeywords,
        averageLessonLength:
            allLessons.length > 0 ? Math.round(totalLength / allLessons.length) : 0,
        oldestLesson:
            oldestTimestamp !== Number.POSITIVE_INFINITY
                ? new Date(oldestTimestamp * 1000)
                : undefined,
        newestLesson: newestTimestamp > 0 ? new Date(newestTimestamp * 1000) : undefined,
    };
}

/**
 * Track lesson usage in prompts
 */
export function logLessonUsage(
    agentName: string,
    agentPubkey: string,
    lessonsShown: Array<{
        title: string;
        eventId: string;
        fromAgent: string;
        keywords: string[];
    }>
): void {
    logger.info("📖 Lesson usage tracking", {
        agent: agentName,
        agentPubkey,
        lessonsUsedCount: lessonsShown.length,
        lessonsUsed: lessonsShown.map((l) => ({
            title: l.title,
            eventId: l.eventId,
            fromAgent: l.fromAgent,
            keywordCount: l.keywords.length,
        })),
        timestamp: new Date().toISOString(),
    });
}

/**
 * Track lesson creation patterns
 */
export function logLessonCreationPattern(
    lesson: NDKAgentLesson,
    agentName: string,
    context: {
        phase: string;
        conversationId: string;
        totalLessonsForAgent: number;
        totalLessonsInProject: number;
    }
): void {
    const keywords = lesson.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);

    logger.info("🎓 Lesson creation pattern", {
        agent: agentName,
        title: lesson.title,
        eventId: lesson.id,
        phase: context.phase,
        conversationId: context.conversationId,
        keywordCount: keywords.length,
        keywords: keywords.join(", "),
        lessonLength: (lesson.lesson || lesson.content || "").length,
        totalLessonsForAgent: context.totalLessonsForAgent,
        totalLessonsInProject: context.totalLessonsInProject,
        timestamp: new Date().toISOString(),
    });
}
