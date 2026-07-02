import { DatabaseSync } from 'node:sqlite';

export interface ConfidenceExplanation {
    baseConfidence: number;
    decayApplied: number;
    corroborationBonus: number;
    finalConfidence: number;
    evidenceSources: string[];
}

export class RuntimeDependencyQueryEngine {
    constructor(private db: DatabaseSync) {}

    // Immediate downstream dependencies (what componentId depends on)
    public getDirectDependencies(componentId: string): string[] {
        const rows = this.db.prepare(`
            SELECT target_component_id as id 
            FROM runtime_component_dependencies 
            WHERE source_component_id = ?
        `).all(componentId) as any[];
        return rows.map(r => r.id);
    }

    // Immediate upstream dependents (what depends on componentId)
    public getDependents(componentId: string): string[] {
        const rows = this.db.prepare(`
            SELECT source_component_id as id 
            FROM runtime_component_dependencies 
            WHERE target_component_id = ?
        `).all(componentId) as any[];
        return rows.map(r => r.id);
    }

    public getDependencyConfidence(sourceId: string, targetId: string): number {
        const row = this.db.prepare(`
            SELECT final_confidence 
            FROM runtime_component_dependencies 
            WHERE source_component_id = ? AND target_component_id = ?
        `).get(sourceId, targetId) as any;
        return row ? row.final_confidence : 0;
    }

    public getDependencyType(sourceId: string, targetId: string): string | null {
        const row = this.db.prepare(`
            SELECT dependency_type 
            FROM runtime_component_dependencies 
            WHERE source_component_id = ? AND target_component_id = ?
        `).get(sourceId, targetId) as any;
        return row ? row.dependency_type : null;
    }

    public getTransitiveDependents(componentId: string, maxDepth: number = 5): string[] {
        const dependents = new Set<string>();
        const visitedNodes = new Set<string>();
        
        const queue: { id: string; depth: number }[] = [{ id: componentId, depth: 0 }];
        visitedNodes.add(componentId);

        while (queue.length > 0) {
            const current = queue.shift()!;
            
            if (current.depth >= maxDepth) continue;

            const immediateDependents = this.getDependents(current.id);
            for (const dep of immediateDependents) {
                dependents.add(dep);
                if (!visitedNodes.has(dep)) {
                    visitedNodes.add(dep);
                    queue.push({ id: dep, depth: current.depth + 1 });
                }
            }
        }
        return Array.from(dependents);
    }

    public getShortestPath(sourceId: string, targetId: string): string[] {
        // Find shortest path from sourceId to targetId through dependents (blast radius direction)
        // If the question is "database_gateway" -> "auth_api", we want to find a path where auth_api depends on ... depends on database_gateway.
        // i.e., traversing getDependents() starting from sourceId until we hit targetId.
        
        const visitedNodes = new Set<string>();
        const queue: { id: string; path: string[] }[] = [{ id: sourceId, path: [sourceId] }];
        visitedNodes.add(sourceId);

        while (queue.length > 0) {
            const current = queue.shift()!;
            
            if (current.id === targetId) {
                return current.path;
            }

            const dependents = this.getDependents(current.id);
            for (const dep of dependents) {
                if (!visitedNodes.has(dep)) {
                    visitedNodes.add(dep);
                    queue.push({ id: dep, path: [...current.path, dep] });
                }
            }
        }
        return [];
    }

    public getAllDependencyPaths(sourceId: string, targetId: string): string[][] {
        const paths: string[][] = [];
        const visitedNodes = new Set<string>();

        const dfs = (currentId: string, currentPath: string[]) => {
            if (currentId === targetId) {
                paths.push([...currentPath]);
                return;
            }

            visitedNodes.add(currentId);
            const dependents = this.getDependents(currentId);
            
            for (const dep of dependents) {
                if (!visitedNodes.has(dep)) {
                    dfs(dep, [...currentPath, dep]);
                }
            }
            visitedNodes.delete(currentId);
        };

        dfs(sourceId, [sourceId]);
        return paths;
    }

    public getConfidenceExplanation(sourceId: string, targetId: string): ConfidenceExplanation {
        const evidenceRows = this.db.prepare(`
            SELECT evidence_source, raw_confidence, discovered_at 
            FROM runtime_dependency_evidence 
            WHERE source_component_id = ? AND target_component_id = ? AND dependency_type != 'TOMBSTONE'
            AND NOT EXISTS (
                SELECT 1 FROM runtime_dependency_evidence t 
                WHERE t.dependency_type = 'TOMBSTONE' 
                AND t.source_component_id = ? AND t.target_component_id = ?
            )
        `).all(sourceId, targetId, sourceId, targetId) as any[];

        if (evidenceRows.length === 0) {
            return {
                baseConfidence: 0,
                decayApplied: 0,
                corroborationBonus: 0,
                finalConfidence: 0,
                evidenceSources: []
            };
        }

        const msPerDay = 24 * 60 * 60 * 1000;
        const now = Date.now();

        let maxDecayed = -1;
        let bestRow: any = null;

        for (const row of evidenceRows) {
            let decayed = row.raw_confidence;
            if (row.evidence_source !== 'EXPLICIT_CONFIG') {
                const ageDays = (now - new Date(row.discovered_at).getTime()) / msPerDay;
                if (ageDays > 7 && ageDays <= 30) {
                    decayed = row.raw_confidence * (1.0 - ((ageDays - 7) / 23.0) * 0.5);
                } else if (ageDays > 30) {
                    decayed = row.raw_confidence * 0.5 * Math.max(0.0, 1.0 - ((ageDays - 30) / 60.0));
                }
            }
            if (decayed > maxDecayed) {
                maxDecayed = decayed;
                bestRow = row;
            }
        }

        const distinctSources = new Set<string>();
        for (const row of evidenceRows) {
            // Count corroboration for sources that yield decayed_confidence >= 0.1 (mirroring view filter conceptually)
            // But we can just count all distinct non-tombstone sources present.
            distinctSources.add(row.evidence_source);
        }

        const baseConfidence = bestRow.raw_confidence;
        const decayApplied = maxDecayed - baseConfidence;
        const distinctCount = distinctSources.size;
        const corroborationBonus = 0.1 * Math.max(0, distinctCount - 1);
        let finalConfidence = maxDecayed + corroborationBonus;
        if (finalConfidence > 1.0) finalConfidence = 1.0;

        return {
            baseConfidence: Number(baseConfidence.toFixed(4)),
            decayApplied: Number(decayApplied.toFixed(4)),
            corroborationBonus: Number(corroborationBonus.toFixed(4)),
            finalConfidence: Number(finalConfidence.toFixed(4)),
            evidenceSources: Array.from(distinctSources)
        };
    }
}
