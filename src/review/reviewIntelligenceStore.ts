import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { ReviewRecommendation, ReviewRecommendedReviewer, ReviewScope, ReviewEvidence, ReviewOutcome } from './reviewIntelligenceTypes';

export class ReviewIntelligenceStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS review_recommendations (
                id TEXT PRIMARY KEY,
                change_id TEXT,
                risk_level TEXT,
                review_depth TEXT,
                reviewer_count INTEGER,
                created_at TEXT
            );

            CREATE TABLE IF NOT EXISTS review_recommended_reviewers (
                recommendation_id TEXT,
                author_email TEXT,
                reviewer_score REAL,
                FOREIGN KEY(recommendation_id) REFERENCES review_recommendations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS review_scope (
                recommendation_id TEXT,
                file_path TEXT,
                scope_type TEXT,
                FOREIGN KEY(recommendation_id) REFERENCES review_recommendations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS review_evidence (
                recommendation_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT,
                FOREIGN KEY(recommendation_id) REFERENCES review_recommendations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS review_outcomes (
                review_id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                reviewer_email TEXT,
                reviewer_name TEXT,
                reviewer_accepted INTEGER,
                defects_found INTEGER,
                post_merge_incidents INTEGER,
                review_duration_hours REAL,
                created_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_rev_rec_change ON review_recommendations(change_id);
            CREATE INDEX IF NOT EXISTS idx_rev_reviewers_rec ON review_recommended_reviewers(recommendation_id);
            CREATE INDEX IF NOT EXISTS idx_rev_scope_rec ON review_scope(recommendation_id);
            CREATE INDEX IF NOT EXISTS idx_rev_evidence_rec ON review_evidence(recommendation_id);
            CREATE INDEX IF NOT EXISTS idx_rev_outcomes_email ON review_outcomes(reviewer_email);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM review_evidence;
                DELETE FROM review_scope;
                DELETE FROM review_recommended_reviewers;
                DELETE FROM review_recommendations;
                DELETE FROM review_outcomes;
            `);
        });
        tx();
    }

    public saveRecommendation(
        rec: ReviewRecommendation, 
        reviewers: ReviewRecommendedReviewer[], 
        scopes: ReviewScope[], 
        evidences: ReviewEvidence[]
    ): void {
        const tx = executeTransaction(this.db, () => {
            const insRec = this.db.prepare(`
                INSERT OR REPLACE INTO review_recommendations 
                (id, change_id, risk_level, review_depth, reviewer_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            insRec.run(rec.id, rec.changeId, rec.riskLevel, rec.reviewDepth, rec.reviewerCount, rec.createdAt.toISOString());

            const insRev = this.db.prepare(`
                INSERT INTO review_recommended_reviewers (recommendation_id, author_email, reviewer_score)
                VALUES (?, ?, ?)
            `);
            for (const r of reviewers) {
                insRev.run(r.recommendationId, r.authorEmail, r.reviewerScore);
            }

            const insScope = this.db.prepare(`
                INSERT INTO review_scope (recommendation_id, file_path, scope_type)
                VALUES (?, ?, ?)
            `);
            for (const s of scopes) {
                insScope.run(s.recommendationId, s.filePath, s.scopeType);
            }

            const insEvid = this.db.prepare(`
                INSERT INTO review_evidence (recommendation_id, evidence_type, evidence_id, evidence_text)
                VALUES (?, ?, ?, ?)
            `);
            for (const e of evidences) {
                insEvid.run(e.recommendationId, e.evidenceType, e.evidenceId, e.evidenceText);
            }
        });
        tx();
    }

    public saveOutcome(outcome: ReviewOutcome): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO review_outcomes 
            (review_id, entity_type, entity_id, reviewer_email, reviewer_name, reviewer_accepted, defects_found, post_merge_incidents, review_duration_hours, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            outcome.reviewId, outcome.entityType, outcome.entityId, outcome.reviewerEmail, outcome.reviewerName, 
            outcome.reviewerAccepted ? 1 : 0, outcome.defectsFound, 
            outcome.postMergeIncidents, outcome.reviewDurationHours, 
            outcome.createdAt.toISOString()
        );
    }
}
