export interface AttributionPayload {
    sourceType: string;
    content: string;
    provenance: {
        authorType?: string;
        timestamp?: string;
        uri?: string;
    };
}
