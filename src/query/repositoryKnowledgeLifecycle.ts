import { KnowledgeLifecycleState } from './repositoryKnowledgeTypes';

/** Exactly the 9 frozen transition rules from ARCHITECTURE_FREEZE.md Part 3. */
export const LIFECYCLE_TRANSITIONS: Record<KnowledgeLifecycleState, KnowledgeLifecycleState[]> = {
    candidate: ['validated'],
    validated: ['promoted'],
    promoted: ['active'],
    active: ['stale', 'contradicted'],
    stale: ['active', 'retired'],
    contradicted: ['retired'],
    retired: ['archived'],
    archived: []
};

export function canTransition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): boolean {
    return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Returns null if the transition is legal, or a diagnostic message if it is not. */
export function assertTransition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): string | null {
    if (canTransition(from, to)) {
        return null;
    }
    const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
    return `Illegal lifecycle transition: ${from} -> ${to}. Allowed from ${from}: [${allowed.join(', ') || 'none'}]`;
}
