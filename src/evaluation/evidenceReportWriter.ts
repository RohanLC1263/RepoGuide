import * as fs from 'fs/promises';
import * as path from 'path';
import { EvidenceEvalReport } from './evidenceGoldenTypes';

export class EvidenceReportWriter {
    constructor(private outputDir: string) {}

    async writeReport(report: EvidenceEvalReport): Promise<void> {
        await fs.mkdir(this.outputDir, { recursive: true });
        
        const timestamp = report.timestamp.replace(/[:.]/g, '-');
        const jsonPath = path.join(this.outputDir, `evidence_eval_${timestamp}.json`);
        const mdPath = path.join(this.outputDir, `evidence_eval_${timestamp}.md`);

        await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

        let md = `# Evidence Evaluation Report\n\n`;
        md += `**Timestamp:** ${report.timestamp}\n\n`;
        
        md += `## Summary Metrics\n`;
        md += `- **Gate 1 (Span Retrieval):** ${(report.gate1Score * 100).toFixed(1)}%\n`;
        md += `- **Gate 2 (Exact Facts):** ${(report.gate2Score * 100).toFixed(1)}%\n`;
        md += `- **Answer Gate Pass Rate:** ${(report.answerGatePassRate * 100).toFixed(1)}%\n`;
        md += `- **Test Leak Rate:** ${(report.testLeakRate * 100).toFixed(1)}%\n`;
        md += `- **Avg Precision@K:** ${(report.avgPrecisionAtK * 100).toFixed(1)}%\n`;
        md += `- **Avg Recall@K:** ${(report.avgRecallAtK * 100).toFixed(1)}%\n`;
        md += `- **Avg Required Coverage:** ${(report.avgRequiredCoverage * 100).toFixed(1)}%\n`;
        md += `- **Constant Expansion Rate:** ${(report.constantExpansionRate * 100).toFixed(1)}%\n`;
        md += `- **Avg Unsupported Claim Rate:** ${(report.avgUnsupportedClaimRate * 100).toFixed(1)}%\n`;
        md += `- **Avg Numeric Accuracy:** ${(report.avgNumericAccuracy * 100).toFixed(1)}%\n`;
        md += `- **Total Cases:** ${report.totalCases}\n\n`;

        md += `## Details (Failed Cases)\n\n`;
        const failedCases = report.results.filter(r => r.failureMode !== 'none');
        if (failedCases.length === 0) {
            md += `*All cases passed successfully!*\n\n`;
        } else {
            for (const res of failedCases) {
                md += `### Case: ${res.caseId}\n`;
                md += `- **Failure Mode:** ${res.failureMode}\n`;
                md += `- **Gate 1 Passed:** ${res.gate1SpanPassed ? '✅' : '❌'}\n`;
                md += `- **Gate 2 Passed:** ${res.gate2FactPassed ? '✅' : '❌'}\n`;
                md += `- **Answer Gate Passed:** ${res.answerGatePass ? '✅' : '❌'}\n`;
                md += `- **Test Leak:** ${res.testLeak ? '❌ (LEAKED)' : '✅ (None)'}\n`;
                md += `- **Precision@K:** ${(res.evidencePrecisionAtK * 100).toFixed(1)}% | **Recall@K:** ${(res.evidenceRecallAtK * 100).toFixed(1)}% | **Coverage:** ${(res.requiredEvidenceCoverage * 100).toFixed(1)}%\n`;
                
                if (res.diagnostics.length > 0) {
                    md += `- **Diagnostics:**\n`;
                    for (const d of res.diagnostics) {
                        md += `  - ${d}\n`;
                    }
                }
                
                md += `- **Retrieved Facts:** ${res.packet.facts.length}\n`;
                for (const fact of res.packet.facts) {
                    md += `  - [${fact.id}] \`${fact.file}\` (${fact.type}: ${fact.symbol})\n`;
                }
                md += `- **Retrieved Items:** ${res.packet.items.length}\n`;
                for (const item of res.packet.items) {
                    md += `  - [${item.id}] \`${item.file}\`\n`;
                }
                md += '\n';
            }
        }

        await fs.writeFile(mdPath, md, 'utf8');
        console.log(`\nEvidence Evaluation Report saved to:\n- JSON: ${jsonPath}\n- Markdown: ${mdPath}\n`);

        await this.writeMentorReport(report, timestamp);
    }

    private async writeMentorReport(report: EvidenceEvalReport, timestamp: string): Promise<void> {
        const mentorMdPath = path.join(this.outputDir, `mentor_evaluation_v2_report_${timestamp}.md`);
        const matrixMdPath = path.join(this.outputDir, `mentor_routing_failure_matrix_${timestamp}.md`);

        let mentorMd = `# Mentor Evaluation V2 Report\n\n`;
        mentorMd += `## Summary Metrics\n`;
        mentorMd += `- **Total Mentor Tests:** ${report.totalMentorTests}\n`;
        mentorMd += `- **Total Routing Tests:** ${report.totalRoutingTests}\n`;
        mentorMd += `- **Routing Pass Rate:** ${(report.mentorRoutingPassRate * 100).toFixed(1)}%\n`;
        mentorMd += `- **Recommendation Pass Rate:** ${(report.mentorRecommendationPassRate * 100).toFixed(1)}%\n`;
        mentorMd += `- **Total No-Mentor Tests:** ${report.totalNoMentorTests}\n`;
        mentorMd += `- **No-Mentor Pass Rate:** ${(report.noMentorPassRate * 100).toFixed(1)}%\n\n`;

        // Coverage Metrics
        mentorMd += `## Mentor Coverage Metrics\n\n`;
        const capabilityCounts: Record<string, { total: number, pass: number }> = {};
        for (const res of report.results) {
            if (res.mentorEvaluated && res.expectedCapability) {
                if (!capabilityCounts[res.expectedCapability]) {
                    capabilityCounts[res.expectedCapability] = { total: 0, pass: 0 };
                }
                capabilityCounts[res.expectedCapability].total++;
                if (res.mentorPass) {
                    capabilityCounts[res.expectedCapability].pass++;
                }
            }
        }

        for (const [cap, counts] of Object.entries(capabilityCounts)) {
            const label = cap === 'None' ? 'No-Mentor' : cap.replace('_mentor', '').replace(/^\w/, c => c.toUpperCase()) + ' Mentor';
            mentorMd += `${label} Tests: ${counts.total}\nPass: ${counts.pass}\n\n`;
        }

        const routingFailures = report.results.filter(r => r.mentorEvaluated && r.mentorFailureType === 'routing');
        const recFailures = report.results.filter(r => r.mentorEvaluated && r.mentorFailureType === 'recommendation');

        mentorMd += `## Routing Failures\n\n`;
        if (routingFailures.length === 0) {
            mentorMd += `*None*\n\n`;
        } else {
            for (const r of routingFailures) {
                mentorMd += `- **Query:** ${r.packet.query}\n`;
                mentorMd += `  - **Expected Capability:** ${r.expectedCapability}\n`;
                mentorMd += `  - **Actual Capability:** ${r.actualCapability}\n\n`;
            }
        }

        mentorMd += `## Known Routing Regressions\n\n`;
        const knownDefectQueries = [
            'Which modules are risky?',
            'What architectural hotspots exist?',
            'Blast radius'
        ];
        for (const query of knownDefectQueries) {
            const res = report.results.find(r => r.packet.query === query);
            if (res) {
                const status = (res.actualCapability === res.expectedCapability) ? '[PASS]' : '[FAIL]';
                mentorMd += `${status}\n`;
                mentorMd += `**Query:** ${res.packet.query}\n`;
                if (status === '[FAIL]') {
                    mentorMd += `**Expected:** ${res.expectedCapability}\n`;
                    mentorMd += `**Actual:** ${res.actualCapability}\n`;
                }
                mentorMd += `\n`;
            }
        }

        mentorMd += `## Recommendation Failures\n\n`;
        if (recFailures.length === 0) {
            mentorMd += `*None*\n\n`;
        } else {
            for (const r of recFailures) {
                mentorMd += `- **Capability:** ${r.actualCapability}\n`;
                mentorMd += `  - **Expected Recommendation Type:** ${r.expectedRecommendationType}\n`;
                mentorMd += `  - **Actual Recommendation Type:** ${r.actualRecommendationType}\n`;
                mentorMd += `  - **Reason:** ${r.mentorFailureReason}\n\n`;
            }
        }

        await fs.writeFile(mentorMdPath, mentorMd, 'utf8');

        // Matrix
        let matrixMd = `# Mentor Routing Failure Matrix\n\n`;
        matrixMd += `| Query | Expected | Actual | Failure Type |\n`;
        matrixMd += `| ----- | -------- | ------ | ------------ |\n`;
        for (const r of routingFailures) {
            const failType = r.expectedCapability === 'None' ? 'Unexpected Mentor' : (r.actualCapability === 'None' ? 'Missing Mentor' : 'Wrong Mentor');
            matrixMd += `| ${r.packet.query} | ${r.expectedCapability} | ${r.actualCapability} | ${failType} |\n`;
        }
        await fs.writeFile(matrixMdPath, matrixMd, 'utf8');

        console.log(`Mentor Reports saved to:\n- ${mentorMdPath}\n- ${matrixMdPath}\n`);
        
        // Save un-timestamped copies to root for easy CI pickup
        await fs.writeFile(path.join(process.cwd(), 'mentor_evaluation_v2_report.md'), mentorMd, 'utf8');
        await fs.writeFile(path.join(process.cwd(), 'mentor_routing_failure_matrix.md'), matrixMd, 'utf8');
    }
}
