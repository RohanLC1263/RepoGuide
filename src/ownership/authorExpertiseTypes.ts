export type EntityType = 'FILE' | 'ADR' | 'INTENT' | 'DIRECTORY';

export interface AuthorExpertise {
    authorEmail: string;
    authorName: string;
    entityType: EntityType;
    entityId: string;
    
    // Core metrics
    expertiseScore: number;
    contributionCount: number;
    
    // Coverage
    coveragePercentage: number; // 1.0 for FILE, fraction for ADR/INTENT
    
    // Temporal metrics
    firstContributionAt: Date;
    lastContributionAt: Date;
    knowledgeAgeDays: number;
}

export interface AuthorExpertiseEvidence {
    authorEmail: string;
    entityType: EntityType;
    entityId: string;
    commitSha: string;
}

export interface AuthorExpertiseQueryEngineApi {
    getExpertsForFile(path: string): AuthorExpertise[];
    getExpertsForADR(adrId: string): AuthorExpertise[];
    getExpertsForIntent(intentId: string): AuthorExpertise[];
    getExpertsForDirectory(directoryPath: string): AuthorExpertise[];
    getExpertsForFiles(paths: string[]): AuthorExpertise[];
    
    getAuthorKnowledge(authorEmail: string): AuthorExpertise[];
    getTopExperts(limit: number): AuthorExpertise[];
    
    getKnowledgeRisk(entityType: EntityType, entityId: string): { activeExperts: number, staleExperts: number, maxKnowledgeAgeDays: number };
    getCoverage(entityType: EntityType, entityId: string): { authorEmail: string, coveragePercentage: number }[];
    getEvidence(authorEmail: string, entityType: EntityType, entityId: string): string[];
}
