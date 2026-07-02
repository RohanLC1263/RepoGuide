import { AttributionPayload } from './attributionTypes';

export class AttributionFormatter {
    format(payloads: AttributionPayload[]): string {
        if (!payloads || payloads.length === 0) {
            return '';
        }

        let output = '\n\n### Architectural Context\n\n';
        
        for (const payload of payloads) {
            const dateStr = payload.provenance.timestamp 
                ? new Date(payload.provenance.timestamp).toISOString().split('T')[0] 
                : 'unknown date';
            const authorStr = payload.provenance.authorType || 'system';
            
            output += `* **${payload.sourceType}** (${authorStr}, ${dateStr}): ${payload.content}\n`;
        }

        return output;
    }
}
