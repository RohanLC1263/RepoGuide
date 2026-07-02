export interface MemoryProposal {
    externalId?: string;
    content: string;
    source: string;
    stale?: boolean;
    action?: 'create' | 'update' | 'mark_stale';
    scope: string; // e.g., 'repository', 'module', 'file'
    scopeKeys: string[];
    tags: string[];
    confidence: number; // 0.0 to 1.0
    repositoryId: string;
}
