# Prefix Length Migration Plan

## Summary
Migrate from mixed prefix lengths (18/6 chars) to standardized lengths:
- **Event IDs**: 10 characters (40 bits entropy, ~1.1 trillion combinations)
- **Pubkeys**: 6 characters (24 bits entropy, ~16.7 million combinations)
- **Delegation IDs**: 10 characters (same as event IDs)

## Completed ✓

1. **Core Constants Updated**
   - `src/types/event-ids.ts`: Changed `SHORT_EVENT_ID_LENGTH` from 18 → 10
   - `src/utils/nostr-entity-parser.ts`: Changed `STORAGE_PREFIX_LENGTH` from 18 → 10
   - `src/utils/nostr-entity-parser.ts`: Kept `PUBKEY_DISPLAY_LENGTH` at 6
   - `src/utils/conversation-id.ts`: Event IDs use 10, pubkeys use 6

2. **Updated All Imports**
   - Files using event IDs now import `STORAGE_PREFIX_LENGTH` (10 chars)
   - Files using pubkeys now import `PUBKEY_DISPLAY_LENGTH` (6 chars)
   - 17 files updated across services, tools, utils, and conversations

3. **Tests Updated**
   - `src/utils/__tests__/nostr-entity-parser.test.ts`: Updated to use 10-char prefixes
   - All 46 tests passing

## Remaining Work

### 1. Update PrefixKVStore Storage Length
**File**: `src/services/storage/PrefixKVStore.ts`

**Changes needed**:
- Line 43: Change local `STORAGE_PREFIX_LENGTH` from 18 → 10
- Line 169: Update comment from "18 hex characters" → "10 hex characters"
- Line 179: Update length check from 18 → 10

**Impact**: This is a **BREAKING CHANGE** - requires migration of existing LMDB database.

### 2. Create Database Migration
**New file**: `src/migrations/prefix-kv-reindex.ts`

**Implementation**:
```typescript
/**
 * Migration: Reindex PrefixKVStore from 18-char to 10-char prefixes
 *
 * Steps:
 * 1. Backup existing LMDB database (~/.tenex/data/prefix-kv/)
 * 2. Read all conversation IDs from ConversationStore
 * 3. Clear PrefixKVStore
 * 4. Reindex all IDs with 10-char prefixes
 * 5. Log migration stats (total IDs, success/failures)
 */
export async function migratePrefixKVStore(): Promise<void>
```

**Add to**: `bun doctor migration` command

### 3. Auto-Run Migrations on Daemon Start
**File**: `src/daemon/Daemon.ts` or startup code

**Logic**:
```typescript
// Check config.json for migration version
const configVersion = config.migrations?.version ?? 0;
const CURRENT_VERSION = 1; // Increment with each migration

if (configVersion < CURRENT_VERSION) {
    logger.info(`Detected old config version ${configVersion}, running migrations...`);
    await runDoctorMigration();
    // Update config.json with new version
    await updateConfigVersion(CURRENT_VERSION);
}
```

### 4. Update Delegation Tools
**Files**:
- `src/tools/implementations/delegate_followup.ts`
- Any other delegation-related tools

**Changes**:
- Ensure delegation IDs are displayed as 10-char prefixes
- Update return values to use `shortenEventId()` (10 chars)

### 5. Handle Telegram Conversation IDs
**Problem**: Telegram conversation IDs like `tg_599309204_123` won't fit cleanly in 10 chars

**Options**:
A. **Hash approach**: Hash the telegram ID and take first 10 chars
   ```typescript
   function shortenTelegramId(telegramId: string): string {
       if (telegramId.startsWith('tg_')) {
           // Extract numeric portion and convert to hex
           const numeric = telegramId.match(/\d+/g)?.join('') ?? '';
           return parseInt(numeric).toString(16).substring(0, 10);
       }
       return telegramId.substring(0, 10);
   }
   ```

B. **Prefix approach**: Use a short prefix like `tg:` + last 7 digits
   ```typescript
   function shortenTelegramId(telegramId: string): string {
       if (telegramId.startsWith('tg_')) {
           const parts = telegramId.split('_');
           return `tg:${parts[parts.length - 1].substring(0, 7)}`;
       }
       return telegramId.substring(0, 10);
   }
   ```

**File to update**: `src/utils/conversation-id.ts` or create `src/utils/telegram-id-utils.ts`

### 6. Update Tests
**Files needing test updates**:
- `src/utils/__tests__/nostr-entity-parser.test.ts`: ✓ Already done (10-char prefixes)
- `src/services/storage/__tests__/PrefixKVStore.test.ts`: If exists, update to 10 chars
- `src/tools/implementations/__tests__/conversation_get.test.ts`: Already using `STORAGE_PREFIX_LENGTH`
- `src/tools/implementations/__tests__/conversation_list.test.ts`: Already using `STORAGE_PREFIX_LENGTH`
- `src/tools/implementations/__tests__/delegate_followup.test.ts`: If exists, verify 10-char delegation IDs

### 7. Update Documentation & Comments
**Files to review**:
- `PrefixKVStore.ts`: Update all comments mentioning "18 characters"
- `docs/ARCHITECTURE.md`: If it mentions prefix lengths
- Any other docs referencing ID shortening

## Migration Execution Plan

### Phase 1: Code Updates (Current)
1. ✓ Update constants in `event-ids.ts` and `nostr-entity-parser.ts`
2. ✓ Update all imports and usages
3. ✓ Update tests
4. **TODO**: Update `PrefixKVStore.ts` local constant

### Phase 2: Migration Infrastructure
1. **TODO**: Create `src/migrations/prefix-kv-reindex.ts`
2. **TODO**: Add migration to `bun doctor migration` command
3. **TODO**: Implement auto-run logic in daemon startup
4. **TODO**: Add config version tracking in `config.json`

### Phase 3: Special Cases
1. **TODO**: Implement Telegram ID shortening logic
2. **TODO**: Update delegation tool return values
3. **TODO**: Review and update any hardcoded "18" references

### Phase 4: Testing & Validation
1. **TODO**: Run full test suite
2. **TODO**: Manual testing of migration command
3. **TODO**: Test daemon auto-migration
4. **TODO**: Test Telegram conversation display
5. **TODO**: Verify delegation tool outputs

### Phase 5: Deployment
1. **TODO**: Commit all changes
2. **TODO**: Update CHANGELOG
3. **TODO**: Create backup instructions for users
4. **TODO**: Deploy and monitor

## Risk Assessment

### Breaking Changes
- **PrefixKVStore format change**: Users will need to run migration
- **Existing 18-char references**: May break if not updated

### Mitigation
- Migration command handles data preservation
- Auto-migration on daemon start prevents manual steps
- Config version tracking prevents re-running migrations
- Backup step in migration protects against data loss

## Testing Checklist

- [ ] Unit tests pass (especially `nostr-entity-parser.test.ts`)
- [ ] PrefixKVStore migration completes successfully
- [ ] Daemon auto-migration triggers correctly
- [ ] Event IDs display as 10 characters in all tools
- [ ] Pubkeys display as 6 characters in all tools
- [ ] Delegation IDs display as 10 characters
- [ ] Telegram conversations display correctly (under 10 chars)
- [ ] Prefix lookup works with 10-char prefixes
- [ ] No hardcoded "18" references remain

## Rollback Plan

If migration fails:
1. Restore LMDB backup from `~/.tenex/data/prefix-kv.backup/`
2. Revert code changes
3. Reset config version in `config.json`
