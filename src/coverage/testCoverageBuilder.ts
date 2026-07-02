import { DatabaseSync } from 'node:sqlite';
import { TestCoverageStore } from './testCoverageStore';
import { CoverageStatus, CoverageRiskLevel } from './testCoverageTypes';
import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';
import * as fs from 'fs';
import * as path from 'path';

export class TestCoverageBuilder implements RepositoryBuilder {
    constructor(private db: DatabaseSync, private store: TestCoverageStore, private rootPath: string = process.cwd()) {}

    public async build(): Promise<void> {
        // 1. Clear previous build
        this.store.clearAll();

        // 2. Try parsing coverage-final.json if exists
        await this.parseJestCoverage();

        // 3. Aggregate File -> ADR Coverage using bulk GROUP BY
        this.aggregateAdrCoverage();

        // 4. Aggregate ADR -> Subsystem Coverage
        this.aggregateSubsystemCoverage();

        // 5. Compute Risk Scores for all entities
        this.computeCoverageRisk();

        // 6. Record Snapshots
        this.recordSnapshots();
    }

    private async parseJestCoverage() {
        const coveragePath = path.join(this.rootPath, 'coverage', 'coverage-final.json');
        if (!fs.existsSync(coveragePath)) {
            // For E2E / testing, we may pre-seed coverage into the DB, so don't fail.
            return;
        }

        const now = new Date().toISOString();
        const content = await fs.promises.readFile(coveragePath, 'utf-8');
        const coverageData = JSON.parse(content);

        // Batch insert for performance
        const insertEntity = this.db.prepare(`
            INSERT INTO coverage_entities (entity_type, entity_id, coverage_percent, covered_lines, total_lines, coverage_status, calculated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertEvidence = this.db.prepare(`
            INSERT INTO coverage_evidence (coverage_id, source_type, source_id, evidence_text)
            VALUES (?, ?, ?, ?)
        `);

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const [filePath, fileData] of Object.entries(coverageData) as any[]) {
                // fileData.s maps statement IDs to execution counts
                const statements = fileData.s || {};
                let totalStatements = 0;
                let coveredStatements = 0;

                for (const [id, count] of Object.entries(statements)) {
                    totalStatements++;
                    if ((count as number) > 0) coveredStatements++;
                }

                const coveragePercent = totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
                const status = this.getCoverageStatus(coveragePercent);
                const normalizedPath = filePath.replace(/\\\\/g, '/'); // Normalize windows paths
                
                // Map to relative path for our RepoGuide standard if possible
                const relativePath = path.relative(this.rootPath, normalizedPath).replace(/\\\\/g, '/');

                insertEntity.run(
                    'FILE', relativePath, coveragePercent, coveredStatements, totalStatements, status, now
                );
                
                insertEvidence.run(
                    relativePath, 
                    'JEST', 
                    coveragePath, 
                    `Lines covered: ${coveredStatements}/${totalStatements}`
                );
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private aggregateAdrCoverage() {
        const now = new Date().toISOString();
        
        // This query fetches coverage of ADRs based on the files they link to.
        const adrCoverage = this.db.prepare(`
            SELECT 
                a.adr_id,
                SUM(c.covered_lines) as covered,
                SUM(c.total_lines) as total
            FROM coverage_entities c
            JOIN adr_file_links a ON c.entity_id = a.file_path
            WHERE c.entity_type = 'FILE'
            GROUP BY a.adr_id
        `).all() as any[];

        const insert = this.db.prepare(`
            INSERT INTO coverage_entities (entity_type, entity_id, coverage_percent, covered_lines, total_lines, coverage_status, calculated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const row of adrCoverage) {
                const percent = row.total > 0 ? (row.covered / row.total) * 100 : 0;
                const status = this.getCoverageStatus(percent);
                insert.run('ADR', row.adr_id, percent, row.covered, row.total, status, now);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private aggregateSubsystemCoverage() {
        const now = new Date().toISOString();

        // Assuming ADRs belong to subsystems or we use directory prefixes.
        // For RepoGuide, Subsystem mapping often uses directory paths of files or ADR metadata.
        // If we don't have an explicit subsystem table, we can infer subsystem from top-level directory of files.
        const subsystemCoverage = this.db.prepare(`
            SELECT 
                SUBSTR(entity_id, 1, INSTR(entity_id || '/', '/') - 1) as subsystem_id,
                SUM(covered_lines) as covered,
                SUM(total_lines) as total
            FROM coverage_entities
            WHERE entity_type = 'FILE' AND INSTR(entity_id, '/') > 0
            GROUP BY subsystem_id
        `).all() as any[];

        const insert = this.db.prepare(`
            INSERT INTO coverage_entities (entity_type, entity_id, coverage_percent, covered_lines, total_lines, coverage_status, calculated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const row of subsystemCoverage) {
                if (!row.subsystem_id) continue;
                const percent = row.total > 0 ? (row.covered / row.total) * 100 : 0;
                const status = this.getCoverageStatus(percent);
                insert.run('SUBSYSTEM', row.subsystem_id, percent, row.covered, row.total, status, now);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private computeCoverageRisk() {
        // RiskScore = MIN(100, (100 - Coverage)*0.5 + HotspotScore*0.25 + BlastRadiusScore*0.25)
        
        // We join against knowledge_hotspots and intent_aware_impacts
        // Because Blast Radius engine might store impacts slightly differently, we will fetch what we can.
        // For simplicity, we assume missing hotspot/blast scores default to 0.

        const entities = this.db.prepare(`
            SELECT c.entity_type, c.entity_id, c.coverage_percent,
                   COALESCE(kh.hotspot_score, 0) as hotspot_score,
                   COALESCE(ia.impact_score, 0) as blast_score
            FROM coverage_entities c
            LEFT JOIN knowledge_hotspots kh ON c.entity_type = kh.entity_type AND c.entity_id = kh.entity_id
            LEFT JOIN intent_aware_impacts ia ON c.entity_id = ia.target_entity_id
        `).all() as any[];

        const insert = this.db.prepare(`
            INSERT INTO coverage_risk (entity_type, entity_id, risk_score, risk_level)
            VALUES (?, ?, ?, ?)
        `);

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const row of entities) {
                const coveragePenalty = (100 - row.coverage_percent) * 0.5;
                const hotspotPenalty = row.hotspot_score * 0.25;
                const blastPenalty = row.blast_score * 0.25;
                
                const rawScore = coveragePenalty + hotspotPenalty + blastPenalty;
                const finalScore = Math.min(100, Math.max(0, rawScore));
                
                const level = this.getRiskLevel(finalScore);
                insert.run(row.entity_type, row.entity_id, finalScore, level);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private recordSnapshots() {
        const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        this.db.exec(`
            INSERT OR REPLACE INTO coverage_history (entity_type, entity_id, snapshot_date, coverage_percent)
            SELECT entity_type, entity_id, '${now}', coverage_percent
            FROM coverage_entities
        `);
    }

    private getCoverageStatus(percent: number): CoverageStatus {
        if (percent >= 90) return 'EXCELLENT';
        if (percent >= 75) return 'GOOD';
        if (percent >= 50) return 'WEAK';
        return 'CRITICAL';
    }

    private getRiskLevel(score: number): CoverageRiskLevel {
        if (score >= 80) return 'CRITICAL';
        if (score >= 60) return 'HIGH';
        if (score >= 30) return 'MEDIUM';
        return 'LOW';
    }
}
