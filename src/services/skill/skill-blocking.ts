import { SkillWhitelistService } from "@/services/skill";

function normalizeSkillId(skillId: string): string {
    return skillId.trim();
}

type SkillAliasSource = {
    identifier?: string;
    shortId?: string;
    eventId?: string;
};

export function buildSkillAliasMap(skills: readonly SkillAliasSource[]): Map<string, SkillAliasSource> {
    const skillMap = new Map<string, SkillAliasSource>();

    for (const skill of skills) {
        if (skill.identifier) {
            skillMap.set(normalizeSkillId(skill.identifier), skill);
        }
        if (skill.eventId) {
            skillMap.set(normalizeSkillId(skill.eventId), skill);
        }
    }

    return skillMap;
}

export type BlockedSkillFilterResult = {
    allowed: string[];
    blocked: string[];
};

function collectAliasesForSkill(skill: SkillAliasSource): Set<string> {
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

function buildSkillAliasIndex(skillMap: Map<string, SkillAliasSource>): Map<string, Set<string>> {
    const whitelistService = SkillWhitelistService.getInstance();
    const aliasIndex = new Map<string, Set<string>>();

    const registerAliases = (skill: SkillAliasSource): void => {
        const aliases = collectAliasesForSkill(skill);
        if (aliases.size === 0) {
            return;
        }

        const mergedAliases = new Set<string>();
        for (const alias of aliases) {
            const existing = aliasIndex.get(alias);
            if (existing) {
                for (const existingAlias of existing) {
                    mergedAliases.add(existingAlias);
                }
            }
        }

        for (const alias of aliases) {
            mergedAliases.add(alias);
        }

        for (const alias of mergedAliases) {
            aliasIndex.set(alias, mergedAliases);
        }
    };

    for (const skill of new Set(skillMap.values())) {
        registerAliases(skill);
    }

    for (const item of whitelistService.getWhitelistedSkills?.() ?? []) {
        registerAliases(item);
    }

    return aliasIndex;
}

function expandSkillAliases(skillId: string, aliasIndex: Map<string, Set<string>>): Set<string> {
    const normalizedSkillId = normalizeSkillId(skillId);
    if (!normalizedSkillId) {
        return new Set();
    }

    const aliases = aliasIndex.get(normalizedSkillId);
    return aliases ? new Set(aliases) : new Set([normalizedSkillId]);
}

export function buildExpandedBlockedSet(
    blockedSkillIds: string[] | undefined,
    skillMap: Map<string, SkillAliasSource>
): Set<string> {
    if (!blockedSkillIds || blockedSkillIds.length === 0) {
        return new Set();
    }

    const expandedSet = new Set<string>();
    const aliasIndex = buildSkillAliasIndex(skillMap);

    for (const blockedId of blockedSkillIds) {
        for (const alias of expandSkillAliases(blockedId, aliasIndex)) {
            if (alias) {
                expandedSet.add(alias);
            }
        }
    }

    return expandedSet;
}

export function filterBlockedSkills(
    skillIds: string[],
    blockedSet: Set<string>,
    skillMap: Map<string, SkillAliasSource>
): BlockedSkillFilterResult {
    if (blockedSet.size === 0) {
        return { allowed: skillIds, blocked: [] };
    }

    const aliasIndex = buildSkillAliasIndex(skillMap);
    const allowed: string[] = [];
    const blocked: string[] = [];

    for (const skillId of skillIds) {
        let isBlocked = false;
        for (const alias of expandSkillAliases(skillId, aliasIndex)) {
            if (blockedSet.has(alias)) {
                isBlocked = true;
                break;
            }
        }
        if (isBlocked) {
            blocked.push(skillId);
        } else {
            allowed.push(skillId);
        }
    }

    return { allowed, blocked };
}

export function isSkillBlocked(
    skillId: string,
    blockedSet: Set<string>,
    skillMap: Map<string, SkillAliasSource>
): boolean {
    if (blockedSet.size === 0) {
        return false;
    }

    const aliasIndex = buildSkillAliasIndex(skillMap);
    for (const alias of expandSkillAliases(skillId, aliasIndex)) {
        if (blockedSet.has(alias)) {
            return true;
        }
    }
    return false;
}
