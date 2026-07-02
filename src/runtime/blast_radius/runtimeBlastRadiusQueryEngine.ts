import { DatabaseSync } from 'node:sqlite';
import { BlastRadiusExplanation } from './runtimeBlastRadiusCalculator';

export class RuntimeBlastRadiusQueryEngine {
    constructor(private db: DatabaseSync) {}

    private getLatestCycleId(): string | null {
        const row = this.db.prepare(`
            SELECT orchestrator_cycle_id 
            FROM runtime_blast_radius 
            ORDER BY generated_at DESC 
            LIMIT 1
        `).get() as any;
        return row ? row.orchestrator_cycle_id : null;
    }

    public getBlastRadius(componentId: string, cycleId?: string): { target: string, risk: number }[] {
        const cycle = cycleId || this.getLatestCycleId();
        if (!cycle) return [];

        const rows = this.db.prepare(`
            SELECT explanation_json 
            FROM runtime_blast_radius 
            WHERE orchestrator_cycle_id = ?
        `).all(cycle) as any[];
        
        const affected: { target: string, risk: number }[] = [];
        for (const row of rows) {
            const expl: BlastRadiusExplanation = JSON.parse(row.explanation_json);
            const isSource = expl.contributingSources.some(s => s.source === componentId);
            if (isSource) {
                affected.push({ target: expl.target, risk: expl.finalAggregatedRisk });
            }
        }
        return affected;
    }

    public getAffectedComponents(componentId: string, cycleId?: string): string[] {
        const radius = this.getBlastRadius(componentId, cycleId);
        return radius.map(r => r.target);
    }

    public getCriticalPaths(componentId: string, cycleId?: string): string[][] {
        const cycle = cycleId || this.getLatestCycleId();
        if (!cycle) return [];

        const rows = this.db.prepare(`
            SELECT explanation_json 
            FROM runtime_blast_radius 
            WHERE orchestrator_cycle_id = ?
        `).all(cycle) as any[];
        
        const criticalPaths: string[][] = [];
        for (const row of rows) {
            const expl: BlastRadiusExplanation = JSON.parse(row.explanation_json);
            for (const src of expl.contributingSources) {
                if (src.source === componentId && src.propagatedEnvelopeRisk >= 0.70) {
                    criticalPaths.push(src.envelopePath);
                }
            }
        }
        return criticalPaths;
    }

    public getBlastRadiusExplanation(source: string, target: string, cycleId?: string): BlastRadiusExplanation | null {
        const cycle = cycleId || this.getLatestCycleId();
        if (!cycle) return null;

        const row = this.db.prepare(`
            SELECT explanation_json 
            FROM runtime_blast_radius 
            WHERE orchestrator_cycle_id = ? AND target_component_id = ?
        `).get(cycle, target) as any;
        
        if (!row) return null;
        
        const expl: BlastRadiusExplanation = JSON.parse(row.explanation_json);
        const hasSource = expl.contributingSources.some(s => s.source === source);
        
        return hasSource ? expl : null;
    }

    public getBlastRadiusScore(componentId: string, cycleId?: string): number {
        const cycle = cycleId || this.getLatestCycleId();
        if (!cycle) return 0;

        const row = this.db.prepare(`
            SELECT blast_radius_score 
            FROM runtime_blast_radius 
            WHERE orchestrator_cycle_id = ? AND target_component_id = ?
        `).get(cycle, componentId) as any;
        return row ? row.blast_radius_score : 0;
    }
}
