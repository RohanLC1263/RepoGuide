import { MemoryRecord } from '../memory/memoryTypes';

export const evaluationCorpus: Omit<MemoryRecord, 'id' | 'repositoryId'>[] = [
    {
        content: 'RepoGuide is designed with a local-first architecture to ensure privacy, zero latency, and seamless offline capability. All data, including LanceDB, operates entirely on the local machine.',
        scope: 'architecture',
        scopeKeys: [],
        tags: ['architecture', 'local-first', 'privacy'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'LanceDB was selected over PostgreSQL and SQLite for our MemoryStore due to its native integration with vector search and its ability to run embedded locally without requiring background daemon management.',
        scope: 'architecture',
        scopeKeys: [],
        tags: ['architecture', 'database', 'lancedb', 'vector-search'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'The Mentor system exists to provide specialized, domain-specific guidance (e.g., Security Mentor, Performance Mentor) rather than relying on a monolithic generalist prompt.',
        scope: 'product',
        scopeKeys: [],
        tags: ['product', 'mentor-system', 'modular-ai'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'BM25 was introduced alongside vector embeddings to form a hybrid search approach. Vector search alone struggled with exact keyword matches.',
        scope: 'technical',
        scopeKeys: [],
        tags: ['technical', 'search', 'bm25', 'hybrid-search'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'The Evidence Pipeline replaced legacy retrieval because the legacy system was a rigid, single-pass fetcher. The Evidence Pipeline allows for multi-stage, iterative retrieval.',
        scope: 'technical',
        scopeKeys: [],
        tags: ['technical', 'evidence-pipeline', 'retrieval'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    }
    // ... remaining 15 golden memories truncated for brevity
];

export const evaluationQueries = [
    { id: 'W1', query: 'Why do we use LanceDB?', expectedTags: ['lancedb'] },
    { id: 'W2', query: 'Why was the Evidence Pipeline introduced?', expectedTags: ['evidence-pipeline'] },
    { id: 'W3', query: 'Why is RepoGuide local-first?', expectedTags: ['local-first'] },
    { id: 'W4', query: 'Why do we use BM25?', expectedTags: ['bm25'] },
    { id: 'W5', query: 'Why does the Mentor system exist?', expectedTags: ['mentor-system'] }
    // ... remaining 25 queries truncated for brevity
];
