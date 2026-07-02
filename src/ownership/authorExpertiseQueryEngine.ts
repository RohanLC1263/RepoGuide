import { AuthorExpertiseStore } from './authorExpertiseStore';
import { AuthorExpertise, AuthorExpertiseQueryEngineApi, EntityType } from './authorExpertiseTypes';

export class AuthorExpertiseQueryEngine implements AuthorExpertiseQueryEngineApi {
    constructor(private store: AuthorExpertiseStore) {}

    public getExpertsForFile(path: string): AuthorExpertise[] {
        return this.store.getExperts('FILE', path);
    }

    public getExpertsForADR(adrId: string): AuthorExpertise[] {
        return this.store.getExperts('ADR', adrId);
    }

    public getExpertsForIntent(intentId: string): AuthorExpertise[] {
        return this.store.getExperts('INTENT', intentId);
    }

    public getExpertsForDirectory(directoryPath: string): AuthorExpertise[] {
        return this.store.getExpertsForDirectory(directoryPath);
    }

    public getExpertsForFiles(paths: string[]): AuthorExpertise[] {
        return this.store.getExpertsForFiles(paths);
    }

    public getAuthorKnowledge(authorEmail: string): AuthorExpertise[] {
        return this.store.getAuthorKnowledge(authorEmail);
    }

    public getTopExperts(limit: number = 10): AuthorExpertise[] {
        return this.store.getTopExperts(limit);
    }

    public getKnowledgeRisk(entityType: EntityType, entityId: string) {
        const experts = this.store.getExperts(entityType, entityId);
        
        const STALE_THRESHOLD_DAYS = 90;
        let activeExperts = 0;
        let staleExperts = 0;
        let maxAge = 0;

        for (const e of experts) {
            if (e.knowledgeAgeDays > maxAge) maxAge = e.knowledgeAgeDays;
            
            if (e.knowledgeAgeDays > STALE_THRESHOLD_DAYS) {
                staleExperts++;
            } else {
                activeExperts++;
            }
        }

        return {
            activeExperts,
            staleExperts,
            maxKnowledgeAgeDays: maxAge
        };
    }

    public getCoverage(entityType: EntityType, entityId: string): { authorEmail: string, coveragePercentage: number }[] {
        const experts = this.store.getExperts(entityType, entityId);
        return experts.map(e => ({ authorEmail: e.authorEmail, coveragePercentage: e.coveragePercentage }));
    }

    public getEvidence(authorEmail: string, entityType: EntityType, entityId: string): string[] {
        return this.store.getEvidence(authorEmail, entityType, entityId);
    }
}
