import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * RAG (Retrieval-Augmented Generation) system instructions fragment
 */
export const ragInstructionsFragment: PromptFragment = {
    id: "rag-instructions",
    priority: 25,
    template: () => `# RAG (Retrieval-Augmented Generation) System

The RAG system provides semantic search and vector-based retrieval capabilities for enhanced agent memory and context management.

## Architecture Overview

The RAG system follows clean architecture principles with clear separation of concerns:
- **RAGService**: Facade that coordinates all operations
- **RAGDatabaseService**: Handles database lifecycle and connections
- **RAGOperations**: Implements business logic for CRUD operations
- **EmbeddingProvider**: Abstraction for embedding generation (local or cloud-based)

## Configuration

### Setting Up Embedding Models

Configure your preferred embedding model using the CLI:

\`\`\`bash
# Global configuration (applies to all projects)
tenex setup embed

# Project-specific configuration
tenex setup embed --project
\`\`\`

The system supports:
- **Local Transformers**: Run models directly on your machine (no API key required)
  - all-MiniLM-L6-v2 (default, fast)
  - all-mpnet-base-v2 (better quality)
  - Custom HuggingFace models
- **OpenAI**: Cloud-based embeddings (requires API key)
  - text-embedding-3-small (fast, good quality)
  - text-embedding-3-large (best quality)

## Available Tools

### 1. rag_create_collection
Create a new vector database collection for storing embeddings.

\`\`\`typescript
rag_create_collection({
  name: "project_knowledge",  // Alphanumeric with underscores only
  schema: {                    // Optional custom schema
    category: "string"
  }
})
\`\`\`

### 2. rag_add_documents
Add documents to a collection with automatic embedding generation.

\`\`\`typescript
rag_add_documents({
  collection: "project_knowledge",
  documents: [
    {
      content: "Document text content",
      metadata: { type: "documentation", tags: ["api", "rest"] },
      source: "api-docs.md",
      id: "doc_001"  // Optional custom ID
    },
    {
      file_path: "./docs/README.md",  // Can read from files
      metadata: { type: "readme" }
    }
  ]
})
\`\`\`

### 3. rag_query
Perform semantic search on a collection.

\`\`\`typescript
rag_query({
  collection: "project_knowledge",
  query_text: "How does authentication work?",
  top_k: 5,  // Number of results (1-100)
  include_metadata: true  // Include document metadata
})
\`\`\`

### 4. rag_delete_collection
Remove a collection and all its documents.

\`\`\`typescript
rag_delete_collection({
  name: "project_knowledge",
  confirm: true  // Required safety flag
})
\`\`\`

### 5. rag_list_collections
List all available collections.

\`\`\`typescript
rag_list_collections({
  include_stats: false  // Stats feature planned for future
})
\`\`\`

## Best Practices

### Collection Design
- **Single Purpose**: Create focused collections for specific domains
- **Naming Convention**: Use descriptive lowercase names with underscores
  - ✅ \`agent_memory\`, \`code_snippets\`, \`user_preferences\`
  - ❌ \`MyCollection\`, \`data-store\`, \`collection#1\`

### Document Management
- **Metadata Strategy**: Always include relevant metadata for filtering
  \`\`\`typescript
  metadata: {
    type: "code" | "documentation" | "conversation",
    language?: string,
    timestamp?: number,
    tags?: string[],
    source?: string
  }
  \`\`\`
- **Content Size**: Keep individual documents under 1MB for optimal performance
- **Batch Operations**: Add multiple documents in a single call for efficiency

### Query Optimization
- **Natural Language**: Use conversational queries for best results
  - ✅ "How to implement user authentication with JWT tokens"
  - ❌ "auth jwt impl func"
- **Result Limits**: Use appropriate \`top_k\` values (5-10 for most cases)
- **Relevance Scores**: Results include scores (0-1) indicating similarity

### Error Handling
All tools use standardized error responses:
\`\`\`json
{
  "success": false,
  "error": "Descriptive error message",
  "toolName": "rag_query"
}
\`\`\`

## Use Cases

### 1. Agent Self-Reflection
Build persistent memory across conversations:

\`\`\`typescript
// Store insights and decisions
rag_create_collection({ name: "agent_insights" })

rag_add_documents({
  collection: "agent_insights",
  documents: [{
    content: "User prefers TypeScript over JavaScript for all new projects",
    metadata: { 
      type: "preference",
      confidence: 0.9,
      learned_from: "conversation_123"
    }
  }]
})

// Later, retrieve relevant context
rag_query({
  collection: "agent_insights",
  query_text: "What are the user's programming language preferences?"
})
\`\`\`

### 2. Project Knowledge Base
Index project documentation and code:

\`\`\`typescript
rag_create_collection({ name: "project_docs" })

// Index all markdown files
rag_add_documents({
  collection: "project_docs",
  documents: [
    { file_path: "README.md" },
    { file_path: "docs/api.md" },
    { file_path: "docs/architecture.md" }
  ]
})

// Query for specific information
rag_query({
  collection: "project_docs",
  query_text: "API authentication methods"
})
\`\`\`

### 3. Enhanced Lesson Learning
Combine with lesson_learn for semantic retrieval:

\`\`\`typescript
// After learning a lesson
lesson_learn({
  title: "Async error handling",
  lesson: "Always use try-catch with async/await"
})

// Store in RAG for semantic search
rag_add_documents({
  collection: "lessons",
  documents: [{
    content: lesson.detailed || lesson.lesson,
    metadata: {
      title: lesson.title,
      category: lesson.category,
      hashtags: lesson.hashtags
    }
  }]
})

// Find related lessons semantically
rag_query({
  collection: "lessons",
  query_text: "How to handle promise rejections"
})
\`\`\`

### 4. Code Pattern Recognition
Store and retrieve code patterns:

\`\`\`typescript
rag_create_collection({ name: "code_patterns" })

rag_add_documents({
  collection: "code_patterns",
  documents: [{
    content: "const useAuth = () => { const [user, setUser] = useState(null); ... }",
    metadata: {
      pattern: "React Hook",
      language: "TypeScript",
      framework: "React",
      complexity: "medium"
    }
  }]
})

rag_query({
  collection: "code_patterns",
  query_text: "authentication hook implementation"
})
\`\`\`

## Integration with Other Tools

### With codebase_search
Index search results for faster future retrieval:
\`\`\`typescript
// After codebase_search finds relevant files
rag_add_documents({
  collection: "indexed_code",
  documents: searchResults.map(result => ({
    file_path: result.path,
    metadata: { type: result.type }
  }))
})
\`\`\`

### With delegate
Share collections between agents:
\`\`\`typescript
delegate({
  task: "Analyze the project documentation",
  tools: ["rag_query"],
  context: "Use collection 'project_docs' for analysis"
})
\`\`\`

### With report_write
Store reports for easy retrieval:
\`\`\`typescript
report_write({ title: "Performance Analysis", content: "..." })

rag_add_documents({
  collection: "reports",
  documents: [{
    content: report.content,
    metadata: { 
      title: report.title,
      type: "report",
      created_at: Date.now()
    }
  }]
})
\`\`\`

## Performance Considerations

1. **Embedding Generation**: First-time model loading may take a few seconds
2. **Batch Size**: Documents are processed in batches of 100 for optimal performance
3. **Vector Dimensions**: Varies by model (384 for MiniLM, 768 for mpnet)
4. **Storage**: LanceDB uses efficient columnar storage with compression
5. **Query Speed**: Sub-second for collections under 100K documents

## Troubleshooting

### Common Issues

1. **Collection Already Exists**
   - Solution: Use unique names or delete existing collection first

2. **Empty Query Results**
   - Check if documents were successfully added
   - Verify collection name is correct
   - Try broader query terms

3. **Slow Embedding Generation**
   - First run downloads model (one-time)
   - Consider using smaller model for speed
   - Use cloud-based embeddings for better performance

4. **Configuration Not Found**
   - Run \`tenex setup embed\` to configure
   - Check \`.tenex/embed.json\` exists
   - Verify environment variables for API keys

Remember: RAG empowers agents with persistent, searchable knowledge that enhances capabilities across conversations!`,
};

// Register the fragment
fragmentRegistry.register(ragInstructionsFragment);
