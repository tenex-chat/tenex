import { SkillWhitelistService } from "@/services/skill/SkillWhitelistService";

function normalizeSkillId(skillId: string): string {
    return skillId.trim();
}

function collectAliasesForSkill(
    skill: {
        identifier?: string;
        shortId?: string;
        eventId?: string;
    }
): Set<string> {
    const aliases = new Set<string>();

    if (skill.identifier) {
        aliases.add(normalizeSkillId(skill.identifier));
    }
    if (skill.shortId) {
        aliases.add(normalizeSkillId(skill.shortId));
    }
    if (skill.eventId) {
        aliases.add(normalizeSkillId(skill.eventId));
    }

    return aliases;
}

export function buildExpandedBlockedSet(
    blockedSkillIds: string[] | undefined
): Set<string> {
    if (!blockedSkillIds || blockedSkillIds.length === 0) {
        return new Set();
    }

    const expandedSet = new Set<string>();
    const whitelistService = SkillWhitelistService.getInstance();
    const installedSkills = whitelistService.getInstalledSkills();
    const whitelistedSkills = whitelistService.getWhitelistedSkills();
    const aliasMap = new Map<string, Set<string>>();

    for (const skill of installedSkills) {
        const aliases = collectAliasesForSkill(skill);
        for (const alias of aliases) {
            aliasMap.set(alias, aliases);
        }
    }

    for (const item of whitelistedSkills) {
        const aliases = aliasMap.get(normalizeSkillId(item.identifier ?? ""))
            ?? aliasMap.get(normalizeSkillId(item.shortId ?? ""))
            ?? aliasMap.get(normalizeSkillId(item.eventId ?? ""))
            ?? new Set<string>();

        if (item.identifier) {
            aliases.add(normalizeSkillId(item.identifier));
        }
        if (item.shortId) {
            aliases.add(normalizeSkillId(item.shortId));
        }
        if (item.eventId) {
            aliases.add(normalizeSkillId(item.eventId));
        }

        for (const alias of aliases) {
            aliasMap.set(alias, aliases);
        }
    }

    for (const blockedId of blockedSkillIds) {
        const normalizedBlockedId = normalizeSkillId(blockedId);
        if (!normalizedBlockedId) {
            continue;
        }

        expandedSet.add(normalizedBlockedId);
        const aliases = aliasMap.get(normalizedBlockedId);
        if (aliases) {
            for (const alias of aliases) {
                expandedSet.add(alias);
            }
        }
    }

    return expandedSet;
}

export function filterBlockedSkills(
    skillIds: string[],
    blockedSkillIds: string[] | undefined
): { allowed: string[]; blocked: string[] } {
    const blockedSet = buildExpandedBlockedSet(blockedSkillIds);
    if (blockedSet.size === 0) {
        return { allowed: skillIds, blocked: [] };
    }

    const allowed: string[] = [];
    const blocked: string[] = [];

    for (const id of skillIds) {
        if (blockedSet.has(normalizeSkillId(id))) {
            blocked.push(id);
        } else {
            allowed.push(id);
        }
    }

    return { allowed, blocked };
}

export function isSkillBlocked(
    skillId: string,
    blockedSkillIds: string[] | undefined
): boolean {
    const blockedSet = buildExpandedBlockedSet(blockedSkillIds);
    return blockedSet.has(normalizeSkillId(skillId));
}
