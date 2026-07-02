export interface IncidentFactor {
    factor_id: string; // UUID
    incident_id: string;
    factor_type: string;
    contribution_score: number;
}

export interface IncidentPattern {
    pattern_id: string; // UUID
    incident_type: string;
    factor_pattern: string; // Comma separated list of factors
    frequency: number;
    confidence: number;
}

export interface IncidentPrediction {
    entity_id: string;
    entity_type: string;
    risk_score: number;
    severity: string; // LOW, MEDIUM, HIGH, CRITICAL
    confidence: number;
    primary_risk_driver: string;
}
