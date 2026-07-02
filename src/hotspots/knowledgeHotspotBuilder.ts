import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class KnowledgeHotspotBuilder implements RepositoryBuilder {
    constructor(private db: DatabaseSync) {}

    public async build(): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            const now = new Date().toISOString();
            const dateStr = now.split('T')[0];

            // Create temp tables to store the interim aggregations
            this.db.exec(`
                DROP TABLE IF EXISTS temp_hotspot_base;
                CREATE TEMP TABLE temp_hotspot_base (
                    entity_id TEXT PRIMARY KEY,
                    entity_type TEXT,
                    health_score REAL DEFAULT 0,
                    blast_radius_score REAL DEFAULT 0,
                    coupling_score REAL DEFAULT 0,
                    bus_factor INTEGER DEFAULT 0,
                    expert_count INTEGER DEFAULT 0,
                    concentration_score REAL DEFAULT 0
                );
            `);

            // Seed entities from architectural_health (which handles ADRs, INTENTs, UNGOVERNED_CLUSTERS)
            this.db.exec(`
                INSERT INTO temp_hotspot_base (entity_id, entity_type, health_score)
                SELECT entity_id, entity_type, health_score
                FROM architectural_health;
            `);

            // Compute Blast Radius Score per Subsystem
            // Normalization: average governance score capped at 100
            this.db.exec(`
                WITH subsystem_impact AS (
                    SELECT 
                        l.adr_id, 
                        AVG(i.governance_score) as avg_impact
                    FROM adr_code_links l
                    JOIN intent_aware_impacts i ON l.node_id = i.root_node_id
                    GROUP BY l.adr_id
                )
                UPDATE temp_hotspot_base
                SET blast_radius_score = (
                    SELECT MIN(100.0, avg_impact)
                    FROM subsystem_impact
                    WHERE subsystem_impact.adr_id = temp_hotspot_base.entity_id
                )
                WHERE entity_type = 'ADR';
            `);

            // Compute Coupling Score per Subsystem
            // Count external edges divided by internal nodes (density) * 10
            this.db.exec(`
                WITH external_edges AS (
                    SELECT 
                        l1.adr_id,
                        COUNT(DISTINCT c.source_path || c.target_path) as edge_count
                    FROM adr_code_links l1
                    JOIN logical_coupling_edges c ON l1.node_id = c.source_path
                    LEFT JOIN adr_code_links l2 ON c.target_path = l2.node_id
                    WHERE l2.adr_id IS NULL OR l1.adr_id != l2.adr_id
                    GROUP BY l1.adr_id
                ),
                internal_nodes AS (
                    SELECT adr_id, COUNT(DISTINCT node_id) as node_count
                    FROM adr_code_links
                    GROUP BY adr_id
                )
                UPDATE temp_hotspot_base
                SET coupling_score = (
                    SELECT MIN(100.0, (CAST(e.edge_count AS REAL) / MAX(1, i.node_count)) * 10.0)
                    FROM external_edges e
                    JOIN internal_nodes i ON e.adr_id = i.adr_id
                    WHERE e.adr_id = temp_hotspot_base.entity_id
                )
                WHERE entity_type = 'ADR';
            `);

            // Compute Bus Factor and Concentration
            // Bus factor: experts with coverage >= 0.2 and age < 365
            // Concentration: max(expertise) / sum(expertise)
            this.db.exec(`
                WITH adr_experts AS (
                    SELECT 
                        l.adr_id as entity_id,
                        e.author_email,
                        MAX(e.expertise_score) as expertise_score,
                        MIN(e.knowledge_age_days) as knowledge_age_days,
                        MAX(e.coverage_percentage) as coverage_percentage
                    FROM adr_code_links l
                    JOIN author_expertise e ON l.node_id = e.entity_id AND e.entity_type = 'FILE'
                    GROUP BY l.adr_id, e.author_email
                ),
                expert_stats AS (
                    SELECT 
                        entity_id,
                        COUNT(CASE WHEN coverage_percentage >= 0.2 AND knowledge_age_days < 365 THEN 1 END) as bus_factor,
                        COUNT(author_email) as expert_count,
                        MAX(expertise_score) as max_expertise,
                        SUM(expertise_score) as sum_expertise
                    FROM adr_experts
                    GROUP BY entity_id
                )
                UPDATE temp_hotspot_base
                SET 
                    bus_factor = (SELECT bus_factor FROM expert_stats WHERE expert_stats.entity_id = temp_hotspot_base.entity_id),
                    expert_count = (SELECT expert_count FROM expert_stats WHERE expert_stats.entity_id = temp_hotspot_base.entity_id),
                    concentration_score = (
                        SELECT CASE WHEN sum_expertise > 0 THEN max_expertise / sum_expertise ELSE 0 END 
                        FROM expert_stats WHERE expert_stats.entity_id = temp_hotspot_base.entity_id
                    )
                WHERE entity_type = 'ADR' AND EXISTS (SELECT 1 FROM expert_stats WHERE expert_stats.entity_id = temp_hotspot_base.entity_id);
            `);

            // Default NULLs to 0
            this.db.exec(`
                UPDATE temp_hotspot_base 
                SET blast_radius_score = COALESCE(blast_radius_score, 0),
                    coupling_score = COALESCE(coupling_score, 0),
                    bus_factor = COALESCE(bus_factor, 0),
                    expert_count = COALESCE(expert_count, 0),
                    concentration_score = COALESCE(concentration_score, 0);
            `);



            // Insert into main knowledge_hotspots
            this.db.exec(`
                DELETE FROM knowledge_hotspots;
                
                INSERT INTO knowledge_hotspots (
                    id, entity_type, entity_id, hotspot_score, severity, 
                    bus_factor, expert_count, knowledge_concentration_score,
                    health_score, blast_radius_score, coupling_score
                )
                SELECT 
                    'HOTSPOT|' || entity_type || '|' || entity_id,
                    entity_type,
                    entity_id,
                    0, -- to be updated in next step
                    'LOW',
                    bus_factor,
                    expert_count,
                    concentration_score,
                    health_score,
                    blast_radius_score,
                    coupling_score
                FROM temp_hotspot_base;
            `);

            // Compute Final Bounded Score
            // BaseRisk = ((100 - health) * 0.4) + (blast * 0.3) + (coupling * 0.3)
            // Multiplier = bus_factor == 0 ? 2.0 : (bus_factor == 1 ? 1.5 : 1.0)
            this.db.exec(`
                UPDATE knowledge_hotspots
                SET hotspot_score = MIN(100.0, 
                    (
                        (MAX(0, 100.0 - health_score) * 0.4) + 
                        (blast_radius_score * 0.3) + 
                        (coupling_score * 0.3)
                    ) * CASE 
                        WHEN bus_factor = 0 THEN 2.0
                        WHEN bus_factor = 1 THEN 1.5
                        ELSE 1.0
                    END
                );
            `);

            // Set Severity
            this.db.exec(`
                UPDATE knowledge_hotspots
                SET severity = CASE 
                    WHEN hotspot_score >= 76 THEN 'CRITICAL'
                    WHEN hotspot_score >= 51 THEN 'HIGH'
                    WHEN hotspot_score >= 26 THEN 'MEDIUM'
                    ELSE 'LOW'
                END;
            `);


            // Snapshot to history
            this.db.exec(`
                INSERT INTO hotspot_history (
                    hotspot_id, snapshot_date, severity, hotspot_score,
                    bus_factor, expert_count, health_score, blast_radius_score, coupling_score
                )
                SELECT 
                    id, '${dateStr}', severity, hotspot_score,
                    bus_factor, expert_count, health_score, blast_radius_score, coupling_score
                FROM knowledge_hotspots;
            `);
        });

        tx();
    }
}
