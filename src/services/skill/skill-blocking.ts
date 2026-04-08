import { SkillWhitelistService } from "@/services/skill/SkillWhitelistService";

function normalizeSkillId(skillId: string): string {
    return skillId.trim();
}

type SkillAliasSource = {
    identifier?: string;
    shortId?: string;
    eventId?: string;
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

function buildSkillAliasIndex(): Map<string, Set<string>> {
    const whitelistService = SkillWhitelistService.getInstance();
    const aliasIndex = new Map<string, Set<string>>();

    const registerAliases = (skill: SkillAliasSource): void => {
        const aliases = collectAliasesForSkill(skill);
        if (aliases.size === 0) {
            return;
        }

        for (const alias of aliases) {
            aliasIndex.set(alias, aliases);
        }
    };

    for (const skill of whitelistService.getInstalledSkills?.() ?? []) {
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
    blockedSkillIds: string[] | undefined
): Set<string> {
    if (!blockedSkillIds || blockedSkillIds.length === 0) {
        return new Set();
    }

    const expandedSet = new Set<string>();
    const aliasIndex = buildSkillAliasIndex();

    for (const blockedId of blockedSkillIds) {
        for (const alias of expandSkillAliases(blockedId, aliasIndex)) {
            if (alias) {
                expandedSet.add(alias);
            }
        }
    }

    return expandedSet;
}

export function filterBlockedSkills(skillIds: string[], blockedSet: Set<string>): string[] {
    if (blockedSet.size === 0) {
        return skillIds;
    }

    const aliasIndex = buildSkillAliasIndex();

    return skillIds.filter((skillId) => {
        for (const alias of expandSkillAliases(skillId, aliasIndex)) {
            if (blockedSet.has(alias)) {
                return false;
            }
        }
        return true;
    });
}

export function isSkillBlocked(skillId: string, blockedSet: Set<string>): boolean {
    if (blockedSet.size === 0) {
        return false;
    }

    const aliasIndex = buildSkillAliasIndex();
    for (const alias of expandSkillAliases(skillId, aliasIndex)) {
        if (blockedSet.has(alias)) {
            return true;
        }
    }
    return false;
}
