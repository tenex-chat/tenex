#!/usr/bin/env bun

/**
 * Test script to verify Claude Code session persistence
 * This script simulates multiple agent interactions to ensure session IDs are properly captured and reused
 */

import { logger } from "@/utils/logger";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { ConversationCoordinator } from "@/conversations/services";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { configService } from "@/services/config";
import { getProjectContext } from "@/services";

async function testClaudeCodeSession() {
    logger.info("Starting Claude Code session persistence test");
    
    try {
        // Initialize services
        await configService.loadConfig();
        const projectCtx = getProjectContext();
        
        // Get or create a test agent with Claude Code provider
        const registry = new AgentRegistry();
        await registry.loadAllConfigurations();
        
        // Find an agent configured to use claude_code provider
        const agents = registry.getAllAgents();
        const claudeCodeAgent = agents.find(a => 
            a.llmConfig === 'claudeCode' || a.llmConfig.startsWith('claudeCode:')
        );
        
        if (!claudeCodeAgent) {
            logger.error("No agent configured with claude_code provider found");
            logger.info("Please configure an agent with llmConfig: 'claudeCode' in agents.json");
            return;
        }
        
        logger.info(`Found Claude Code agent: ${claudeCodeAgent.name}`, {
            llmConfig: claudeCodeAgent.llmConfig,
            slug: claudeCodeAgent.slug
        });
        
        // Create a test conversation
        const conversationId = `test-session-${Date.now()}`;
        const conversationCoordinator = new ConversationCoordinator();
        
        // Create a test triggering event
        const signer = new NDKPrivateKeySigner("nsec1j6cqnnc3m3jd48dkzc55jquyx9qxa2fhnr5vsqe6qn2q60fjh2kq83k26d");
        const triggeringEvent = new NDKEvent();
        triggeringEvent.kind = 1;
        triggeringEvent.content = "Test message 1: My name is Alice";
        await signer.sign(triggeringEvent);
        
        // Create execution context
        const context = {
            agent: claudeCodeAgent,
            conversationId,
            conversationCoordinator,
            triggeringEvent,
            projectPath: projectCtx.projectPath,
        };
        
        // First interaction
        logger.info("=== First Interaction ===");
        logger.info("Sending: 'My name is Alice'");
        
        // Create metadata store to check session
        const metadataStore = claudeCodeAgent.createMetadataStore(conversationId);
        const initialSession = metadataStore.get<string>('claudeCodeSessionId');
        logger.info(`Initial session ID: ${initialSession || 'none'}`);
        
        // Simulate first agent execution (would normally be done through AgentExecutor)
        const llmLogger = projectCtx.llmLogger.withAgent(claudeCodeAgent.name);
        const llmService1 = configService.createLLMService(
            llmLogger,
            claudeCodeAgent.llmConfig,
            {
                agentName: claudeCodeAgent.name,
                sessionId: initialSession
            }
        );
        
        // Listen for session capture
        let capturedSessionId: string | undefined;
        llmService1.on('session-captured', ({ sessionId }) => {
            capturedSessionId = sessionId;
            logger.info("Session ID captured from first interaction", { sessionId });
            metadataStore.set('claudeCodeSessionId', sessionId);
        });
        
        // Execute first interaction
        const messages1 = [
            { role: 'user' as const, content: 'My name is Alice' }
        ];
        
        try {
            const result1 = await llmService1.complete(messages1, {});
            logger.info("First interaction complete", {
                response: result1.text?.substring(0, 100),
                sessionCaptured: !!capturedSessionId
            });
        } catch (error) {
            logger.error("First interaction failed", { error });
        }
        
        // Second interaction - should use the captured session
        logger.info("\n=== Second Interaction ===");
        logger.info("Sending: 'What is my name?'");
        
        const storedSession = metadataStore.get<string>('claudeCodeSessionId');
        logger.info(`Stored session ID: ${storedSession || 'none'}`);
        
        if (!storedSession) {
            logger.warn("No session ID stored after first interaction - session persistence may not be working");
        }
        
        // Create second LLM service with stored session
        const llmService2 = configService.createLLMService(
            llmLogger,
            claudeCodeAgent.llmConfig,
            {
                agentName: claudeCodeAgent.name,
                sessionId: storedSession
            }
        );
        
        // Execute second interaction
        const messages2 = [
            { role: 'user' as const, content: 'What is my name?' }
        ];
        
        try {
            const result2 = await llmService2.complete(messages2, {});
            logger.info("Second interaction complete", {
                response: result2.text?.substring(0, 200),
                usedSessionId: storedSession
            });
            
            // Check if the response indicates session continuity
            if (result2.text?.toLowerCase().includes('alice')) {
                logger.info("✅ SUCCESS: Session persistence is working! Claude remembered the name.");
            } else {
                logger.warn("⚠️  WARNING: Claude may not have remembered the context. Response doesn't mention 'Alice'");
            }
        } catch (error) {
            logger.error("Second interaction failed", { error });
        }
        
        logger.info("\n=== Test Complete ===");
        logger.info("Session persistence test finished", {
            sessionId: storedSession,
            metadataFile: `.tenex/metadata/${conversationId}-${claudeCodeAgent.slug}.json`
        });
        
    } catch (error) {
        logger.error("Test failed", { error });
    }
}

// Run the test
testClaudeCodeSession().catch(console.error);