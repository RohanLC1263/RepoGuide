import { DashboardRenderer } from './rendererContract';
import { EvaluationResult, CapabilityEvaluation, EvaluationFinding } from '../evaluationModels';

export class CliRenderer implements DashboardRenderer {
    public readonly format = 'cli';

    public render(result: EvaluationResult): string {
        const toPct = (val: number) => (val * 100).toFixed(1) + '%';
        
        let output = `=================================================\n`;
        output += ` SEMANTIC REGRESSION DASHBOARD\n`;
        output += `=================================================\n\n`;
        output += `Evaluation ID : ${result.evaluationId}\n`;
        output += `Fixture ID    : ${result.fixtureId}\n`;
        output += `Candidate     : ${result.candidateIdentifier}\n\n`;

        output += `--- QUALITY SUMMARY ---\n`;
        output += `Precision: ${toPct(result.providerQuality.precision)}\n`;
        output += `Recall   : ${toPct(result.providerQuality.recall)}\n`;
        output += `Total FP : ${result.providerQuality.falsePositives}\n`;
        output += `Total FN : ${result.providerQuality.falseNegatives}\n\n`;

        output += `--- CAPABILITIES ---\n`;
        for (const cap of result.capabilityResults) {
            output += `[${cap.capabilityId}] Precision: ${toPct(cap.precision)}, Recall: ${toPct(cap.recall)} (TP:${cap.truePositives} FP:${cap.falsePositives} FN:${cap.falseNegatives})\n`;
        }
        output += `\n`;

        if (result.findings.length > 0) {
            output += `--- FINDINGS (${result.findings.length}) ---\n`;
            for (const finding of result.findings) {
                output += `[${finding.severity.toUpperCase()}] ${finding.category}: ${finding.recommendation}\n`;
            }
        } else {
            output += `--- NO FINDINGS ---\n`;
        }

        return output;
    }
}
