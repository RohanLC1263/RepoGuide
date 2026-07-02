import { DatabaseSync } from 'node:sqlite';
import { CoverageEntity, CoverageQueryEngine, CoverageRisk, CoverageSnapshot } from './testCoverageTypes';

export class TestCoverageQueryEngine implements CoverageQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getCoverage(entityType: string, entityId: string): CoverageEntity | null {
        const stmt = this.db.prepare(`
            SELECT * FROM coverage_entities 
            WHERE entity_type = ? AND entity_id = ?
        `);
        const row = stmt.get(entityType, entityId) as any;
        if (!row) return null;

        return {
            entityType: row.entity_type,
            entityId: row.entity_id,
            coveragePercent: row.coverage_percent,
            coveredLines: row.covered_lines,
            totalLines: row.total_lines,
            coverageStatus: row.coverage_status,
            calculatedAt: row.calculated_at
        };
    }

    public getWeakCoverage(): CoverageEntity[] {
        const stmt = this.db.prepare(`
            SELECT * FROM coverage_entities 
            WHERE coverage_status IN ('WEAK', 'CRITICAL')
            ORDER BY coverage_percent ASC
            LIMIT 10
        `);
        const rows = stmt.all() as any[];
        return rows.map(r => ({
            entityType: r.entity_type,
            entityId: r.entity_id,
            coveragePercent: r.coverage_percent,
            coveredLines: r.covered_lines,
            totalLines: r.total_lines,
            coverageStatus: r.coverage_status,
            calculatedAt: r.calculated_at
        }));
    }

    public getCriticalCoverage(): CoverageEntity[] {
        const stmt = this.db.prepare(`
            SELECT * FROM coverage_entities 
            WHERE coverage_status = 'CRITICAL'
            ORDER BY coverage_percent ASC
            LIMIT 10
        `);
        const rows = stmt.all() as any[];
        return rows.map(r => ({
            entityType: r.entity_type,
            entityId: r.entity_id,
            coveragePercent: r.coverage_percent,
            coveredLines: r.covered_lines,
            totalLines: r.total_lines,
            coverageStatus: r.coverage_status,
            calculatedAt: r.calculated_at
        }));
    }

    public getCoverageHistory(entityType: string, entityId: string): CoverageSnapshot[] {
        const stmt = this.db.prepare(`
            SELECT * FROM coverage_history 
            WHERE entity_type = ? AND entity_id = ?
            ORDER BY snapshot_date ASC
        `);
        const rows = stmt.all() as any[];
        return rows.map(r => ({
            entityType: r.entity_type,
            entityId: r.entity_id,
            snapshotDate: r.snapshot_date,
            coveragePercent: r.coverage_percent
        }));
    }

    public getCoverageRisk(entityType: string, entityId: string): CoverageRisk | null {
        const stmt = this.db.prepare(`
            SELECT * FROM coverage_risk 
            WHERE entity_type = ? AND entity_id = ?
        `);
        const row = stmt.get(entityType, entityId) as any;
        if (!row) return null;

        return {
            entityType: row.entity_type,
            entityId: row.entity_id,
            riskScore: row.risk_score,
            riskLevel: row.risk_level
        };
    }

    public getMostDangerousUntestedAreas(): (CoverageEntity & CoverageRisk)[] {
        const stmt = this.db.prepare(`
            SELECT c.*, r.risk_score, r.risk_level
            FROM coverage_entities c
            JOIN coverage_risk r ON c.entity_type = r.entity_type AND c.entity_id = r.entity_id
            WHERE r.risk_score >= 70
            ORDER BY r.risk_score DESC
            LIMIT 10
        `);
        const rows = stmt.all() as any[];
        return rows.map(r => ({
            entityType: r.entity_type,
            entityId: r.entity_id,
            coveragePercent: r.coverage_percent,
            coveredLines: r.covered_lines,
            totalLines: r.total_lines,
            coverageStatus: r.coverage_status,
            calculatedAt: r.calculated_at,
            riskScore: r.risk_score,
            riskLevel: r.risk_level
        }));
    }
}
