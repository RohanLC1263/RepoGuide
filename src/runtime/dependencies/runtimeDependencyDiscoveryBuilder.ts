import { DatabaseSync } from 'node:sqlite';
import { RuntimeDependencyStore } from './runtimeDependencyStore';

export class RuntimeDependencyDiscoveryBuilder {
    constructor(private db: DatabaseSync, private store: RuntimeDependencyStore) {}

    public discoverExplicitDependencies(configs: { component: string, dependencies: string[] }[]) {
        for (const config of configs) {
            for (const dep of config.dependencies) {
                this.store.appendEvidence({
                    evidence_id: `exp_${config.component}_${dep}_${Date.now()}_${Math.random()}`,
                    source_component_id: config.component,
                    target_component_id: dep,
                    dependency_type: 'HARD_DEPENDENCY',
                    evidence_source: 'EXPLICIT_CONFIG',
                    raw_confidence: 1.0
                });
            }
        }
    }

    public discoverTemporalCorrelations() {
        const events = this.db.prepare(`
            SELECT component_id, status, computed_at
            FROM runtime_health_history
            WHERE status IN ('DEGRADED', 'CRITICAL')
            ORDER BY computed_at ASC
        `).all() as { component_id: string, computed_at: string }[];

        const parsedEvents = events.map(e => ({
            id: e.component_id,
            time: new Date(e.computed_at).getTime()
        }));

        // Debounce events: only keep the first failure per component per 60s incident window
        const debouncedEvents = [];
        const lastSeen = new Map<string, number>();
        for (const e of parsedEvents) {
            const last = lastSeen.get(e.id);
            if (!last || (e.time - last) > 60000) {
                debouncedEvents.push(e);
                lastSeen.set(e.id, e.time);
            }
        }

        // Filter Macro Events (>3 components in 10s window)
        const validEvents = [];
        for (let i = 0; i < debouncedEvents.length; i++) {
            const e = debouncedEvents[i];
            const windowStart = e.time - 5000;
            const windowEnd = e.time + 5000;
            
            const componentsInWindow = new Set<string>();
            for (let j = 0; j < debouncedEvents.length; j++) {
                const other = debouncedEvents[j];
                if (other.time >= windowStart && other.time <= windowEnd) {
                    componentsInWindow.add(other.id);
                }
            }

            // Macro event rejection
            if (componentsInWindow.size <= 3) {
                validEvents.push(e);
            }
        }

        // Find directional pairs (Target degraded 1s to 60s before Source)
        const observations = new Map<string, number>();

        for (let i = 0; i < validEvents.length; i++) {
            const targetEvent = validEvents[i]; // Dependee (e.g. database_gateway)
            
            for (let j = i + 1; j < validEvents.length; j++) {
                const sourceEvent = validEvents[j]; // Depender (e.g. user_service)
                
                const timeDiff = sourceEvent.time - targetEvent.time;
                if (timeDiff >= 1000 && timeDiff <= 60000) {
                    if (targetEvent.id !== sourceEvent.id) {
                        const key = `${sourceEvent.id}|${targetEvent.id}`;
                        observations.set(key, (observations.get(key) || 0) + 1);
                    }
                } else if (timeDiff > 60000) {
                    break; // Array is sorted, we can safely stop looking forward
                }
            }
        }

        // Apply frequency threshold and insert
        for (const [key, count] of observations.entries()) {
            if (count >= 3) {
                const [source_id, target_id] = key.split('|');
                this.store.appendEvidence({
                    evidence_id: `corr_${source_id}_${target_id}_${Date.now()}_${Math.random()}`,
                    source_component_id: source_id,
                    target_component_id: target_id,
                    dependency_type: 'CORRELATED_DEPENDENCY',
                    evidence_source: 'TEMPORAL_CORRELATION',
                    raw_confidence: 0.6 // Hard cap at 0.6
                });
            }
        }
    }
}
