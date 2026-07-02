import * as fs from 'fs';
import * as path from 'path';
import { EvalRunResult } from './types';
import { summarizeResults, writeEvalReport } from './reportWriter';

function main() {
    const args = process.argv.slice(2);
    const outputDir = args[0];
    if (!outputDir) {
        console.error('Usage: ts-node commitManual.ts <output-dir>');
        process.exit(1);
    }

    const manualReviewPath = path.join(outputDir, 'manual_review_pending.md');
    if (!fs.existsSync(manualReviewPath)) {
        console.error(`No pending manual review found at ${manualReviewPath}`);
        process.exit(0);
    }

    const latestJsonPath = path.join(outputDir, 'latest.json');
    if (!fs.existsSync(latestJsonPath)) {
        console.error(`latest.json not found at ${latestJsonPath}`);
        process.exit(1);
    }

    const run: EvalRunResult = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
    const content = fs.readFileSync(manualReviewPath, 'utf8');

    const lines = content.split('\n');
    let currentQuestionId: string | null = null;
    let updatedCount = 0;

    for (const line of lines) {
        const idMatch = line.match(/^## Question ID: (.*)$/);
        if (idMatch) {
            currentQuestionId = idMatch[1].trim();
            continue;
        }

        if (currentQuestionId) {
            const groundingMatch = line.match(/^- \[x\] Grounding Score.*:\s*([012])/i);
            const provenanceMatch = line.match(/^- \[x\] Provenance Accuracy Score.*:\s*([012])/i);

            const qResult = run.results.find(r => r.id === currentQuestionId);
            if (qResult) {
                if (groundingMatch) {
                    qResult.scores.grounding = parseInt(groundingMatch[1], 10) as 0 | 1 | 2;
                    updatedCount++;
                }
                if (provenanceMatch) {
                    qResult.scores.provenanceAccuracy = parseInt(provenanceMatch[1], 10) as 0 | 1 | 2;
                    updatedCount++;
                }
            }
        }
    }

    if (updatedCount > 0) {
        run.summary = summarizeResults(run.results, run.summary.threshold, run.previousRun ? run : null); // We pass null or something? Wait, previousRun is in run.previousRun but summarizeResults takes EvalRunResult | null. Let's load the actual previous run if needed, but it's fine.
        
        // Wait, the previousRun passed to summarizeResults is the actual full previous EvalRunResult. 
        // We might not have the full previous run here, but we can just use the delta that was previously computed, or we skip regression recalculation?
        // Actually, let's just recalculate the summary. The `previousRun` in `run` is just the summary:
        // previousRun: { runId, overallScore, delta }
        // Let's just leave regressions empty or re-load the previous run from `runs/${run.previousRun.runId}.json`
        let prevRunFull: EvalRunResult | null = null;
        if (run.previousRun) {
            const prevPath = path.join(outputDir, 'runs', `${run.previousRun.runId.replace(/[:.]/g, '-')}.json`);
            if (fs.existsSync(prevPath)) {
                prevRunFull = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
            }
        }
        
        run.summary = summarizeResults(run.results, run.summary.threshold, prevRunFull);
        
        writeEvalReport(run, outputDir);
        fs.unlinkSync(manualReviewPath);
        console.log(`Successfully committed ${updatedCount} manual scores and updated eval report.`);
    } else {
        console.log('No scored items found (make sure to check the boxes with [x] and provide a score).');
    }
}

main();
