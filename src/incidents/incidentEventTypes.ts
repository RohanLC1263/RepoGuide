export type IncidentType = 'COVERAGE_INCIDENT' | 'HOTSPOT_INCIDENT' | 'OUTCOME_INCIDENT' | 'HEALTH_INCIDENT' | 'VALIDITY_INCIDENT' | 'REVIEW_INCIDENT';

export type IncidentSeverity = 'RESOLVED' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IncidentState = 'CLEAR' | 'DEGRADED' | 'FAILED';

export interface IncidentEvent {
    id: string; // UUID
    entity_type: string;
    entity_id: string;
    incident_type: IncidentType;
    severity: IncidentSeverity;
    trigger_metric: string;
    trigger_value: string;
    created_at: Date;
}

export interface IncidentStateLock {
    entity_id: string;
    incident_type: IncidentType;
    last_severity: IncidentSeverity;
    lock_expires_at: Date;
}
