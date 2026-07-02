import { CanonicalFact } from '../canonicalFact';
import { FactEvaluationResult, IdentityDriftRecord } from './factEvaluationModels';
import { RejectedConstruct } from './canonicalFactNormalizer';

export class SemanticRegressionDashboard {
    /**
     * Renders a human-readable summary of the evaluation results.
     * The dashboard strictly presents the pre-computed evaluation and
     * never performs logic, reasoning, normalization, or graph queries.
     */
    public render(evaluation: FactEvaluationResult): string {
        const sections: string[] = [];

        sections.push(this.renderSummaryMetrics(evaluation));
        
        if (evaluation.identityDrift.length > 0) {
            sections.push(this.renderIdentityDrift(evaluation.identityDrift));
        }

        if (evaluation.missing.length > 0) {
            sections.push(this.renderMissingFacts(evaluation.missing));
        }

        if (evaluation.unexpected.length > 0) {
            sections.push(this.renderUnexpectedFacts(evaluation.unexpected));
        }

        if (evaluation.matching.length > 0) {
            sections.push(this.renderMatchingFacts(evaluation.matching));
        }

        if (evaluation.rejectedConstructs.length > 0) {
            sections.push(this.renderRejectedConstructs(evaluation.rejectedConstructs));
        }

        return sections.join('\n\n');
    }

    private renderSummaryMetrics(evaluation: FactEvaluationResult): string {
        const totalLegacy = evaluation.matching.length + evaluation.missing.length + evaluation.identityDrift.length;
        const totalSemantic = evaluation.matching.length + evaluation.unexpected.length + evaluation.identityDrift.length;
        const totalDrift = evaluation.identityDrift.length;

        const lines = [
            '======================================================================',
            '                  SEMANTIC REGRESSION DASHBOARD                       ',
            '======================================================================',
            '',
            'SUMMARY METRICS:',
            `  Legacy Facts Validated:   ${totalLegacy}`,
            `  Semantic Facts Evaluated: ${totalSemantic}`,
            `  Matches:                  ${evaluation.matching.length}`,
            `  Missing:                  ${evaluation.missing.length}`,
            `  Unexpected:               ${evaluation.unexpected.length}`,
            `  Identity Drift:           ${totalDrift}`,
            `  Rejected Constructs:      ${evaluation.rejectedConstructs.length}`,
            '======================================================================'
        ];

        return lines.join('\n');
    }

    private renderMissingFacts(missing: CanonicalFact[]): string {
        const lines = ['--- MISSING FACTS ---'];
        missing.forEach((f, i) => {
            lines.push(`[${i + 1}] ID: ${f.factId} | Type: ${f.factType}`);
            lines.push(`    Payload: ${JSON.stringify(f.payload)}`);
        });
        return lines.join('\n');
    }

    private renderUnexpectedFacts(unexpected: CanonicalFact[]): string {
        const lines = ['--- UNEXPECTED FACTS ---'];
        unexpected.forEach((f, i) => {
            lines.push(`[${i + 1}] ID: ${f.factId} | Type: ${f.factType}`);
            lines.push(`    Payload: ${JSON.stringify(f.payload)}`);
        });
        return lines.join('\n');
    }

    private renderMatchingFacts(matching: CanonicalFact[]): string {
        const lines = ['--- MATCHING FACTS ---'];
        // For matching facts we only show a summary of their IDs if there are many.
        matching.forEach((f, i) => {
            lines.push(`[${i + 1}] ID: ${f.factId} | Type: ${f.factType}`);
        });
        return lines.join('\n');
    }

    private renderIdentityDrift(driftRecords: IdentityDriftRecord[]): string {
        const lines = ['--- IDENTITY DRIFT ---'];
        driftRecords.forEach((d, i) => {
            lines.push(`[${i + 1}] Drift Pair:`);
            lines.push(`    [Original] ID: ${d.original.factId}`);
            lines.push(`               Payload: ${JSON.stringify(d.original.payload)}`);
            lines.push(`    [Drifted]  ID: ${d.drifted.factId}`);
            lines.push(`               Payload: ${JSON.stringify(d.drifted.payload)}`);
        });
        return lines.join('\n');
    }

    private renderRejectedConstructs(rejected: RejectedConstruct[]): string {
        const lines = ['--- REJECTED CONSTRUCTS ---'];
        rejected.forEach((r, i) => {
            lines.push(`[${i + 1}] Fact ID: ${r.factId}`);
            lines.push(`    Reason: ${r.reason}`);
        });
        return lines.join('\n');
    }
}
