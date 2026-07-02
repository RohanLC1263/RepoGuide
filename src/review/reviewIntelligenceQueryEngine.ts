import { DatabaseSync } from 'node:sqlite';
import { 
    ReviewRecommendation, 
    ReviewRecommendedReviewer, 
    ReviewScope, 
    ReviewEvidence,
    ReviewOutcome
} from './reviewIntelligenceTypes';

export class ReviewIntelligenceQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getReviewRecommendation(changeId: string): ReviewRecommendation | null {
        const row = this.db.prepare(`
            SELECT * FROM review_recommendations WHERE change_id = ?
        `).get(changeId) as any;
        if (!row) return null;
        return {
            id: row.id,
            changeId: row.change_id,
            riskLevel: row.risk_level,
            reviewDepth: row.review_depth,
            reviewerCount: row.reviewer_count,
            createdAt: new Date(row.created_at)
        };
    }

    public getSuggestedReviewers(recommendationId: string): ReviewRecommendedReviewer[] {
        const rows = this.db.prepare(`
            SELECT * FROM review_recommended_reviewers 
            WHERE recommendation_id = ?
            ORDER BY reviewer_score DESC
        `).all(recommendationId) as any[];
        return rows.map(r => ({
            recommendationId: r.recommendation_id,
            authorEmail: r.author_email,
            reviewerScore: r.reviewer_score
        }));
    }

    public getReviewScope(recommendationId: string): ReviewScope[] {
        const rows = this.db.prepare(`
            SELECT * FROM review_scope WHERE recommendation_id = ?
        `).all(recommendationId) as any[];
        return rows.map(r => ({
            recommendationId: r.recommendation_id,
            filePath: r.file_path,
            scopeType: r.scope_type
        }));
    }

    public getReviewEvidence(recommendationId: string): ReviewEvidence[] {
        const rows = this.db.prepare(`
            SELECT * FROM review_evidence WHERE recommendation_id = ?
        `).all(recommendationId) as any[];
        return rows.map(r => ({
            recommendationId: r.recommendation_id,
            evidenceType: r.evidence_type,
            evidenceId: r.evidence_id,
            evidenceText: r.evidence_text
        }));
    }

    public getReviewOutcomes(reviewerEmail?: string): ReviewOutcome[] {
        let rows;
        if (reviewerEmail) {
            rows = this.db.prepare(`
                SELECT * FROM review_outcomes WHERE reviewer_email = ? ORDER BY created_at DESC
            `).all(reviewerEmail) as any[];
        } else {
            rows = this.db.prepare(`
                SELECT * FROM review_outcomes ORDER BY created_at DESC
            `).all() as any[];
        }
        return rows.map(r => ({
            reviewId: r.review_id,
            entityType: r.entity_type,
            entityId: r.entity_id,
            reviewerEmail: r.reviewer_email,
            reviewerName: r.reviewer_name,
            reviewerAccepted: r.reviewer_accepted === 1,
            defectsFound: r.defects_found,
            postMergeIncidents: r.post_merge_incidents,
            reviewDurationHours: r.review_duration_hours,
            createdAt: new Date(r.created_at)
        }));
    }
}
