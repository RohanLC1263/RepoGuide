export interface ChangeRiskPrediction {
    entity_id: string;
    base_failure_probability: number;
    primary_risk_driver: string;
    sample_size: number;
}

export interface ExpectedIncident {
    incident_type: string;
    probability: number;
    reasoning: string;
}

export interface RecommendedReviewer {
    author: string;
    expertise_score: number;
    reasoning: string;
}

export interface ChangeSetPrediction {
    severity: 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
    failure_probability: number;
    confidence: number;
    risk_drivers: string[];
    recommended_reviewers: RecommendedReviewer[];
    expected_incident_types: ExpectedIncident[];
    missing_logical_couplings: string[];
}
