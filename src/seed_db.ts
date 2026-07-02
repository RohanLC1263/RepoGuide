import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import * as fs from 'fs';

// Quick check of the db
const dbPath = path.join('c:', 'Projects', 'RepoGuide', 'repository_brain.sqlite');
if (!fs.existsSync(dbPath)) {
    console.log("DB does not exist at", dbPath);
    // Create and seed it
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS decision_outcomes (
            entity_type TEXT, entity_id TEXT, outcome_type TEXT, outcome_score INTEGER, confidence_score INTEGER, evidence_count INTEGER, incident_count INTEGER, review_failure_count INTEGER, health_trend TEXT, validity_trend TEXT, calculated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS causal_explanations (
            id TEXT, entity_type TEXT, entity_id TEXT, outcome_id TEXT, explanation_type TEXT, explanation_text TEXT, confidence_score INTEGER, generated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS causal_factors (
            explanation_id TEXT, factor_type TEXT, factor_id TEXT, contribution_score INTEGER, description TEXT
        );
        CREATE TABLE IF NOT EXISTS coverage_entities (
            entity_type TEXT, entity_id TEXT, coverage_percent INTEGER, covered_lines INTEGER, total_lines INTEGER, coverage_status TEXT, calculated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS coverage_risk (
            entity_type TEXT, entity_id TEXT, risk_score INTEGER, risk_level TEXT
        );
        CREATE TABLE IF NOT EXISTS knowledge_hotspots (
            id TEXT, entity_type TEXT, entity_id TEXT, hotspot_score INTEGER, severity TEXT, bus_factor INTEGER, expert_count INTEGER, knowledge_concentration_score INTEGER, health_score INTEGER, blast_radius_score INTEGER, coupling_score INTEGER
        );
    `);
    
    // Seed ADR-17
    const stmtOutcome = db.prepare('INSERT INTO decision_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmtOutcome.run('File', 'ADR-17', 'FAILED', 20, 84, 5, 2, 3, 'DEGRADING', 'STABLE', new Date().toISOString());
    stmtOutcome.run('File', 'ADR-1', 'SUCCESSFUL', 95, 90, 5, 0, 0, 'IMPROVING', 'STABLE', new Date().toISOString());

    const stmtExp = db.prepare('INSERT INTO causal_explanations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmtExp.run('exp-1', 'File', 'ADR-17', 'out-1', 'FAILURE_ANALYSIS', 'Failed due to coverage drops and high bus factor', 84, new Date().toISOString());
    stmtExp.run('exp-2', 'LogicalUnit', 'AuthModule', 'out-2', 'RISK_ANALYSIS', 'High blast radius with untested code', 90, new Date().toISOString());

    const stmtFactor = db.prepare('INSERT INTO causal_factors VALUES (?, ?, ?, ?, ?)');
    stmtFactor.run('exp-1', 'COVERAGE', 'cov-1', 40, 'Coverage below 50%');
    stmtFactor.run('exp-1', 'REVIEW', 'rev-1', 30, 'Repeated review failures');

    const stmtHotspot = db.prepare('INSERT INTO knowledge_hotspots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmtHotspot.run('hot-1', 'LogicalUnit', 'AuthModule', 99, 'CRITICAL', 1, 1, 80, 40, 90, 85);

    const stmtCoverageRisk = db.prepare('INSERT INTO coverage_risk VALUES (?, ?, ?, ?)');
    stmtCoverageRisk.run('LogicalUnit', 'PaymentGateway', 95, 'CRITICAL');
    stmtCoverageRisk.run('LogicalUnit', 'AuthModule', 85, 'HIGH');

    console.log("DB created and seeded.");
} else {
    console.log("DB exists.");
}
