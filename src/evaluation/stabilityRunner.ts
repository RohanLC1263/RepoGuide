import { runEval } from './evidenceEvalRunner';
import { EvidenceStabilityReport, EvidenceEvalReport } from './evidenceGoldenTypes';
import * as path from 'path';
import * as fs from 'fs/promises';

async function runStabilityCheck() {
    const iterations = 3;
    const reports: EvidenceEvalReport[] = [];
    
    console.log(`\n=== Starting Stability Check (${iterations} iterations) ===\n`);
    
    // Pass args to eval runner if needed (e.g. --reuse-index to save time after 1st run)
    // Actually we will control index building manually or just rely on the first run building it.
    
    for (let i = 0; i < iterations; i++) {
        console.log(`\n--- Iteration ${i + 1}/${iterations} ---`);
        
        // Push --reuse-index for subsequent runs so we don't rebuild the vector store every time
        if (i > 0 && !process.argv.includes('--reuse-index')) {
            process.argv.push('--reuse-index');
        }
        
        const report = await runEval();
        reports.push(report);
    }
    
    console.log(`\n=== Stability Results ===`);
    
    const gate1Scores = reports.map(r => r.gate1Score);
    const gate2Scores = reports.map(r => r.gate2Score);
    const gatePassRates = reports.map(r => r.answerGatePassRate);
    
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = (arr: number[], m: number) => arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / arr.length;
    
    const g1Mean = mean(gate1Scores);
    const g1Var = variance(gate1Scores, g1Mean);
    const g2Mean = mean(gate2Scores);
    const g2Var = variance(gate2Scores, g2Mean);
    const passRateMean = mean(gatePassRates);
    const passRateVar = variance(gatePassRates, passRateMean);
    
    console.log(`Gate 1 - Mean: ${(g1Mean*100).toFixed(1)}%, Variance: ${g1Var.toFixed(4)}`);
    console.log(`Gate 2 - Mean: ${(g2Mean*100).toFixed(1)}%, Variance: ${g2Var.toFixed(4)}`);
    console.log(`Answer Gate - Mean: ${(passRateMean*100).toFixed(1)}%, Variance: ${passRateVar.toFixed(4)}`);
    
    const maxAllowedVariance = 0.05;
    
    const passed = g1Var < maxAllowedVariance && g2Var < maxAllowedVariance && passRateVar < maxAllowedVariance;
    
    const stabilityReport: EvidenceStabilityReport = {
        timestamp: new Date().toISOString(),
        iterations,
        metrics: {
            gate1ScoreMean: g1Mean,
            gate1ScoreVariance: g1Var,
            gate2ScoreMean: g2Mean,
            gate2ScoreVariance: g2Var,
            answerGatePassRateMean: passRateMean,
            answerGatePassRateVariance: passRateVar
        },
        passed
    };
    
    const reportPath = path.join(process.cwd(), 'reports', 'evidence_eval', `stability_report_${stabilityReport.timestamp.replace(/[:.]/g, '-')}.json`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(stabilityReport, null, 2), 'utf8');
    
    console.log(`\nStability Report saved to: ${reportPath}`);
    
    if (passed) {
        console.log('✅ Stability check passed (Variance < 0.05)');
        process.exit(0);
    } else {
        console.error('❌ Stability check failed (Variance exceeded 0.05 limit)');
        process.exit(1);
    }
}

if (require.main === module) {
    runStabilityCheck().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
