export type RuntimeSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RuntimeComponent {
    component_id: string;
    description?: string;
}

export interface RuntimeEvent {
    event_id: string;
    component_id: string;
    event_type: string;
    severity: RuntimeSeverity;
    payload: string;
    timestamp: Date;
    repository_commit_hash: string;
}

export interface RuntimeRepositoryMapping {
    mapping_id: string;
    component_id: string;
    entity_type: 'FILE' | 'LOGICAL_UNIT';
    entity_id: string;
    snapshot_date: Date;
}

export interface RuntimeHealthHistory {
    component_id: string;
    computed_at: Date;
    health_score: number;
    status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
    primary_driver: string;
}

export interface RuntimePattern {
    pattern_id: string;
    component_id: string;
    pattern_type: string;
    frequency: number;
    confidence: number;
    discovered_at: Date;
    status: 'ACTIVE' | 'RESOLVED' | 'EXPIRED';
}

export interface RuntimeCalibrationWeightHistory {
    event_type: string;
    computed_at: Date;
    weight: number;
    confidence_score: number;
    mode: 'COLD' | 'WARM' | 'CALIBRATED';
}

export interface RuntimeBaseline {
    component_id: string;
    event_type: string;
    computed_at: Date;
    mean_frequency: number;
    variance: number;
}

export interface RuntimeSnapshotManifest {
    repository_commit_hash: string;
}

export interface RuntimeSnapshotEvent {
    event_id: string;
    component_id: string;
    event_type: string;
    severity: RuntimeSeverity;
    payload: string;
    timestamp: string; // ISO string in JSONL
}
