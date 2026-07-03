import { KnowledgeSubject } from './repositoryKnowledgeTypes';

/**
 * Maps the `entity_type`/`entity_id` pairs used throughout the RepositoryBrain domain builders
 * (causalReasoningBuilder, decisionOutcomeBuilder, incidentIntelligenceBuilder, and friends) onto
 * the frozen `KnowledgeSubject` shape. Shared so the three builders agree on one mapping.
 */
export function mapEntityToSubject(entityType: string, entityId: string): KnowledgeSubject {
    switch (entityType) {
        case 'FILE':
            return { kind: 'file', id: entityId, file: entityId };
        case 'ADR':
            return { kind: 'decision', id: entityId };
        case 'MODULE':
            return { kind: 'module', id: entityId };
        default:
            return { kind: 'repository', id: `${entityType}:${entityId}` };
    }
}
