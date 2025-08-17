# PM-Centric Routing Implementation Tracker

## Core Principle
**NO BACKWARDS COMPATIBILITY. CLEAN ARCHITECTURE ONLY.**
We are building the system right, not maintaining legacy code.

## Implementation Milestones

### MILESTONE 1: Phase Management Tools ✅
- [ ] Create switch_phase tool
- [ ] Register in tool registry  
- [ ] Add to PM's toolset exclusively
- [ ] Test phase transitions work

### MILESTONE 2: Remove Orchestrator Infrastructure
- [ ] Delete orchestrator agent from built-in agents
- [ ] Update handleNewConversation to route to PM
- [ ] Update handleTask to route to PM
- [ ] Remove getProjectAgent() references
- [ ] Remove isOrchestrator checks everywhere
- [ ] Delete orchestrator-specific code from AgentRegistry

### MILESTONE 3: NDKTask-Based Delegation
- [ ] Update delegate tool to create NDKTask events
- [ ] Update complete tool to handle task completions
- [ ] Add delegate to ALL agents' default toolsets
- [ ] Implement task activation in event handler
- [ ] Implement response synthesis for dormant agents
- [ ] Add claude session management for tasks

### MILESTONE 4: Agent Instructions Overhaul
- [ ] Rewrite PM instructions with routing logic
- [ ] Update Planner for phase leadership
- [ ] Update Executor for claude_code orchestration
- [ ] Update Executor toolset (remove file tools, keep only claude_code, delegate, complete)
- [ ] Add delegation instructions to all specialists

### MILESTONE 5: Clean Up Legacy Systems
- [ ] Remove phase validation from PhaseManager
- [ ] Delete OrchestratorTurnTracker completely
- [ ] Remove orchestrator prompt fragments
- [ ] Clean up unused routing imports
- [ ] Remove PHASE_TRANSITIONS constants

### MILESTONE 6: Testing & Validation
- [ ] Create test conversations for new flow
- [ ] Verify PM routing works
- [ ] Test delegation chains
- [ ] Validate phase transitions
- [ ] Check loop prevention

## Implementation Notes

### Gaps Discovered
- 

### Questions Arising
- 

### Critical Decisions Made
- 

### Code to Remove (Be Ruthless)
- src/agents/built-in/orchestrator.ts
- src/agents/execution/RoutingBackend.ts (already deleted)
- src/agents/execution/ClaudeBackend.ts (already deleted)
- src/conversations/services/OrchestratorTurnTracker.ts
- src/prompts/fragments/01-orchestrator-identity.ts
- src/prompts/fragments/25-orchestrator-routing.ts
- All orchestrator debugger code

### Things That Must Work After This
1. PM must be able to engage users in conversation
2. PM must route to appropriate phases
3. Agents must delegate and get responses
4. Complete() must return to delegator
5. Claude sessions must be task-scoped