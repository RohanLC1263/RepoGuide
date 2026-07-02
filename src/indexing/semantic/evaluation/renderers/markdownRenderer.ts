import { DashboardRenderer } from './rendererContract';
import { EvaluationResult } from '../evaluationModels';

export class MarkdownRenderer implements DashboardRenderer {
    public readonly format = 'markdown';

    public render(result: EvaluationResult): string {
        const toPct = (val: number) => (val * 100).toFixed(1) + '%';
        
        let md = `# Semantic Regression Dashboard\n\n`;
        
        md += `## Evaluation Run\n`;
        md += `- **Evaluation ID**: \`${result.evaluationId}\`\n`;
        md += `- **Fixture ID**: \`${result.fixtureId}\`\n`;
        md += `- **Candidate**: \`${result.candidateIdentifier}\`\n`;
        md += `- **Timestamp**: ${new Date(result.timestampMs).toISOString()}\n\n`;

        md += `## Quality Summary\n`;
        md += `| Metric | Score |\n`;
        md += `| --- | --- |\n`;
        md += `| Precision | ${toPct(result.providerQuality.precision)} |\n`;
        md += `| Recall | ${toPct(result.providerQuality.recall)} |\n`;
        md += `| False Positives | ${result.providerQuality.falsePositives} |\n`;
        md += `| False Negatives | ${result.providerQuality.falseNegatives} |\n\n`;

        md += `## Capability Breakdown\n`;
        md += `| Capability | Precision | Recall | TP | FP | FN |\n`;
        md += `| --- | --- | --- | --- | --- | --- |\n`;
        for (const cap of result.capabilityResults) {
            md += `| ${cap.capabilityId} | ${toPct(cap.precision)} | ${toPct(cap.recall)} | ${cap.truePositives} | ${cap.falsePositives} | ${cap.falseNegatives} |\n`;
        }
        md += `\n`;

        if (result.findings.length > 0) {
            md += `## Findings\n`;
            for (const finding of result.findings) {
                const badge = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '🟠' : '🔵';
                md += `- ${badge} **[${finding.category}]** ${finding.recommendation}\n`;
            }
        } else {
            md += `## Findings\n*No findings.* 🎉\n`;
        }

        return md;
    }
}
