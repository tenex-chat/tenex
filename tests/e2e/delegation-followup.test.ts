import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupE2ETest, cleanupE2ETest, sendMessage, type E2ETestContext } from '@/test-utils/e2e-context';
import type { MockLLMScenario } from '@/test-utils/mock-llm/types';
import type { ModelMessage } from 'ai';

describe('Multi-turn Delegation with Follow-ups', () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest();
    });
    
    afterEach(async () => {
        await cleanupE2ETest(context);
    });
    
    it('should handle follow-up questions after delegation', async () => {
        // Create scenario for PM with follow-ups
        const pmScenario: MockLLMScenario = {
            name: 'pm-with-followups',
            description: 'PM delegates and asks follow-up questions',
            steps: [
                {
                    trigger: {
                        messageContains: 'Design an auth system'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate_phase',
                            args: {
                                phase: 'DESIGN',
                                phase_instructions: 'Design phase for authentication',
                                recipient: 'architect',
                                fullRequest: 'Design a complete authentication system for our app',
                                title: 'Authentication System Design'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        messageContains: 'DELEGATION RESPONSE RECEIVED'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: {
                                message: 'Should we use OAuth2 or SAML for the authentication?'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        messageContains: 'OAuth2'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: {
                                message: 'What about refresh token rotation strategy?'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        messageContains: 'rotating refresh tokens'
                    },
                    action: {
                        content: 'Based on the architect\'s design, we will implement OAuth2 with PKCE flow and rotating refresh tokens with a 7-day expiry. The system will support social login providers and include proper session management.'
                    }
                }
            ]
        };
        
        // Create scenario for Architect responding
        const architectScenario: MockLLMScenario = {
            name: 'architect-responses',
            description: 'Architect responds to delegation and follow-ups',
            steps: [
                {
                    trigger: {
                        messageContains: 'Design a complete authentication system'
                    },
                    action: {
                        content: 'I\'ve designed a comprehensive authentication system using modern security practices. The system includes user registration, login, and session management capabilities.'
                    }
                },
                {
                    trigger: {
                        messageContains: 'OAuth2 or SAML'
                    },
                    action: {
                        content: 'I recommend OAuth2 with PKCE flow for the authentication. OAuth2 is more widely supported, easier to implement, and provides better mobile app compatibility than SAML.'
                    }
                },
                {
                    trigger: {
                        messageContains: 'refresh token rotation strategy'
                    },
                    action: {
                        content: 'Use rotating refresh tokens with a 7-day expiry period. Each time a refresh token is used, issue a new one and invalidate the old one. This provides good security while maintaining reasonable user experience.'
                    }
                }
            ]
        };
        
        // Register scenarios
        context.mockLLM.addScenario(pmScenario);
        context.mockLLM.addScenario(architectScenario);
        
        // Send initial message
        const result = await sendMessage(context, 'Design an auth system', 'user123');
        
        // Verify the delegation chain happened
        const events = context.publishedEvents;
        
        // Should have multiple delegation events
        const delegationEvents = events.filter(e => e.kind === 1111);
        expect(delegationEvents.length).toBeGreaterThan(1);
        
        // Final response should include details from all follow-ups
        const finalResponse = events[events.length - 1];
        expect(finalResponse.content).toContain('OAuth2');
        expect(finalResponse.content).toContain('PKCE');
        expect(finalResponse.content).toContain('rotating refresh tokens');
        expect(finalResponse.content).toContain('7-day');
    });
    
    it('should inject follow-up context after each delegation', async () => {
        const capturedMessages: ModelMessage[] = [];
        
        // Create a scenario that captures the messages
        const pmScenario: MockLLMScenario = {
            name: 'pm-context-capture',
            description: 'Capture injected context',
            steps: [
                {
                    trigger: {
                        messageContains: 'Check time'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate',
                            args: {
                                recipients: ['timekeeper'],
                                fullRequest: 'What time is it?'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        // This should contain the injected follow-up context
                        messageContains: 'DELEGATION RESPONSE RECEIVED'
                    },
                    action: {
                        beforeResponse: (messages) => {
                            capturedMessages.push(...messages);
                        },
                        content: 'The time has been checked.'
                    }
                }
            ]
        };
        
        context.mockLLM.addScenario(pmScenario);
        
        // Add timekeeper response
        context.mockLLM.addScenario({
            name: 'timekeeper',
            description: 'Responds with time',
            steps: [{
                trigger: { messageContains: 'What time is it' },
                action: { content: 'It is 4:00 PM' }
            }]
        });
        
        await sendMessage(context, 'Check time with the timekeeper', 'user123');
        
        // Verify context injection
        const systemMessages = capturedMessages.filter(m => m.role === 'system');
        const hasFollowUpContext = systemMessages.some(m => 
            typeof m.content === 'string' && 
            m.content.includes('delegate_followup')
        );
        
        expect(hasFollowUpContext).toBe(true);
    });
    
    it('should track recent delegation for implicit recipient', async () => {
        const pmScenario: MockLLMScenario = {
            name: 'pm-implicit-followup',
            description: 'PM uses follow-up without specifying recipient',
            steps: [
                {
                    trigger: {
                        messageContains: 'database design'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate',
                            args: {
                                recipients: ['architect'],
                                fullRequest: 'Design the database schema'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        messageContains: 'DELEGATION RESPONSE RECEIVED'
                    },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: {
                                // No 'to' parameter - should use recent delegation
                                message: 'Should we use PostgreSQL or MongoDB?'
                            }
                        }
                    }
                },
                {
                    trigger: {
                        messageContains: 'PostgreSQL'
                    },
                    action: {
                        content: 'Database will use PostgreSQL as recommended.'
                    }
                }
            ]
        };
        
        context.mockLLM.addScenario(pmScenario);
        
        // Architect responses
        context.mockLLM.addScenario({
            name: 'architect-db',
            description: 'Architect database responses',
            steps: [
                {
                    trigger: { messageContains: 'database schema' },
                    action: { content: 'I\'ve designed a normalized relational schema.' }
                },
                {
                    trigger: { messageContains: 'PostgreSQL or MongoDB' },
                    action: { content: 'Use PostgreSQL for strong consistency and ACID compliance.' }
                }
            ]
        });
        
        const result = await sendMessage(context, 'Need database design', 'user123');
        
        // Verify follow-up worked without explicit recipient
        const events = context.publishedEvents;
        const followUpEvents = events.filter(e => 
            e.content?.includes('[FOLLOW-UP]')
        );
        
        expect(followUpEvents.length).toBeGreaterThan(0);
    });
    
    it('should allow chaining multiple follow-ups', async () => {
        const pmScenario: MockLLMScenario = {
            name: 'pm-chained-followups',
            description: 'PM chains multiple follow-ups',
            steps: [
                {
                    trigger: { messageContains: 'API design' },
                    action: {
                        toolCall: {
                            name: 'delegate',
                            args: {
                                recipients: ['architect'],
                                fullRequest: 'Design the REST API'
                            }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'RESTful API design' },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: { message: 'What about versioning strategy?' }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'URL path versioning' },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: { message: 'How should we handle rate limiting?' }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'token bucket algorithm' },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: { message: 'What about error response format?' }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'RFC 7807' },
                    action: {
                        content: 'API design complete with versioning, rate limiting, and error handling.'
                    }
                }
            ]
        };
        
        // Architect responses for each follow-up
        const architectResponses = [
            { trigger: 'REST API', response: 'I\'ve created a RESTful API design.' },
            { trigger: 'versioning strategy', response: 'Use URL path versioning (e.g., /v1/users).' },
            { trigger: 'rate limiting', response: 'Implement token bucket algorithm with Redis.' },
            { trigger: 'error response format', response: 'Follow RFC 7807 (Problem Details for HTTP APIs).' }
        ];
        
        context.mockLLM.addScenario(pmScenario);
        context.mockLLM.addScenario({
            name: 'architect-api',
            description: 'Architect API responses',
            steps: architectResponses.map(r => ({
                trigger: { messageContains: r.trigger },
                action: { content: r.response }
            }))
        });
        
        await sendMessage(context, 'Design the API', 'user123');
        
        // Verify all follow-ups were processed
        const events = context.publishedEvents;
        const followUpCount = events.filter(e => 
            e.content?.includes('[FOLLOW-UP]')
        ).length;
        
        expect(followUpCount).toBe(3); // Three follow-up questions
    });
    
    it('should handle follow-up with delegate_phase tool', async () => {
        const pmScenario: MockLLMScenario = {
            name: 'pm-phase-followup',
            description: 'PM uses follow-up after delegate_phase',
            steps: [
                {
                    trigger: { messageContains: 'security review' },
                    action: {
                        toolCall: {
                            name: 'delegate_phase',
                            args: {
                                phase: 'VERIFICATION',
                                phase_instructions: 'Security audit phase',
                                recipient: 'security',
                                fullRequest: 'Review the authentication implementation',
                                title: 'Security Audit'
                            }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'DELEGATION RESPONSE RECEIVED' },
                    action: {
                        toolCall: {
                            name: 'delegate_followup',
                            args: {
                                message: 'What specific vulnerabilities did you find?'
                            }
                        }
                    }
                },
                {
                    trigger: { messageContains: 'CSRF' },
                    action: {
                        content: 'Security issues identified: CSRF vulnerability needs addressing.'
                    }
                }
            ]
        };
        
        context.mockLLM.addScenario(pmScenario);
        context.mockLLM.addScenario({
            name: 'security-audit',
            description: 'Security agent responses',
            steps: [
                {
                    trigger: { messageContains: 'Review the authentication' },
                    action: { content: 'Security review complete. Found some issues.' }
                },
                {
                    trigger: { messageContains: 'vulnerabilities' },
                    action: { content: 'Found CSRF vulnerability in form submissions.' }
                }
            ]
        });
        
        await sendMessage(context, 'Do a security review', 'user123');
        
        // Verify delegate_phase works with follow-ups
        const events = context.publishedEvents;
        expect(events.some(e => e.content?.includes('VERIFICATION'))).toBe(true);
        expect(events.some(e => e.content?.includes('[FOLLOW-UP]'))).toBe(true);
        expect(events.some(e => e.content?.includes('CSRF'))).toBe(true);
    });
});