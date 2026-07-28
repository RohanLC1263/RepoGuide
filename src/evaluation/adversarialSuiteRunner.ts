/**
 * Adversarial stress suite runner.
 *
 * Runs `src/test/evaluation/adversarial_questions_craftconnect.json` against the REAL
 * query pipeline (QueryPipelineHarness -> QueryDispatcher -> AnswerGate), the same
 * path the extension and MCP server use.
 *
 * WHY THIS EXISTS, AND WHY IT IS MARKER-BASED. Every prior investigation in this
 * project was a one-off: findings were re-derived from scratch each round and
 * regressions were only caught by someone happening to re-ask the same question.
 * This file is the permanent, extendable home for that work. Scoring deliberately
 * avoids prose similarity (which needs a judge model and is itself unreliable) in
 * favour of objective string markers declared per question:
 *
 *   mustNotContain -> fabrication markers; presence is a FAIL
 *   required       -> facts that must appear; requiredMode 'all' | 'any'
 *   repeat         -> run N times to measure run-to-run variance
 *
 * Adding a case is a JSON edit, not a code change. When a new failure is found in
 * future rounds, add it here so it can never silently regress.
 *
 * Usage: npm run eval:adversarial   (requires CRAFTCONNECT_PATH and a built index)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
    (moduleObj.Module.prototype as unknown as { require: unknown }).require = function patchedRequire(this: unknown, id: string) {
        if (id === 'vscode') { return shim; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as never);
    };
}
installVscodeShim();

import { QueryPipelineHarness } from './queryPipelineHarness';
import { GoldenQuestion } from './types';
import { getCraftConnectPath } from './craftconnectPath';

interface AdversarialQuestion {
    id: string;
    category: string;
    question: string;
    mustNotContain?: string[];
    required?: string[];
    requiredMode?: 'all' | 'any';
    repeat?: number;
    expectedBehaviour?: string;
    verifiedAgainst?: string;
}

interface RunOutcome {
    id: string;
    category: string;
    iteration: number;
    gate: string;
    violations: string[];
    missing: string[];
    verdict: 'PASS' | 'FAIL';
    answerLength: number;
    elapsedMs: number;
}

function scoreAnswer(answer: string, q: AdversarialQuestion): { violations: string[]; missing: string[] } {
    const haystack = answer.toLowerCase();
    const violations = (q.mustNotContain ?? []).filter(m => haystack.includes(m.toLowerCase()));

    let missing: string[] = [];
    if (q.required && q.required.length > 0) {
        const absent = q.required.filter(m => !haystack.includes(m.toLowerCase()));
        // 'any' passes when at least one required marker is present.
        missing = (q.requiredMode ?? 'all') === 'any'
            ? (absent.length === q.required.length ? absent : [])
            : absent;
    }
    return { violations, missing };
}

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(getCraftConnectPath());
    const suitePath = path.resolve(__dirname, '../../src/test/evaluation/adversarial_questions_craftconnect.json');
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')) as { name: string; questions: AdversarialQuestion[] };

    const onlyCategory = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
    const questions = onlyCategory
        ? suite.questions.filter(q => q.category === onlyCategory)
        : suite.questions;

    const harness = new QueryPipelineHarness({
        workspaceRoot,
        repoguideDir: path.join(workspaceRoot, '.repoguide'),
        outputChannel: { appendLine: () => undefined } as never
    });
    await harness.init();

    console.log(`\n=== ${suite.name} ===`);
    console.log(`${questions.length} question(s)${onlyCategory ? ` in category '${onlyCategory}'` : ''}\n`);

    const outcomes: RunOutcome[] = [];
    for (const q of questions) {
        const iterations = q.repeat ?? 1;
        for (let i = 1; i <= iterations; i++) {
            const golden: GoldenQuestion = {
                id: `${q.id}#${i}`, type: 'explanation', question: q.question,
                expectedAnswer: '', requiresLocations: false
            };
            const startedAt = Date.now();
            let answer = '';
            let gate = 'error';
            try {
                const { output } = await harness.runQuestion(golden);
                answer = output.answer ?? '';
                gate = output.telemetry?.answerGate?.outcome ?? 'n/a';
            } catch (error) {
                answer = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
            }
            const { violations, missing } = scoreAnswer(answer, q);
            const verdict: 'PASS' | 'FAIL' = violations.length === 0 && missing.length === 0 ? 'PASS' : 'FAIL';
            outcomes.push({
                id: q.id, category: q.category, iteration: i, gate, violations, missing, verdict,
                answerLength: answer.length, elapsedMs: Date.now() - startedAt
            });
            const suffix = iterations > 1 ? ` (${i}/${iterations})` : '';
            console.log(`[${q.id}${suffix}] ${verdict.padEnd(4)} gate=${gate.padEnd(6)} ${Date.now() - startedAt}ms` +
                (violations.length ? ` | fabricated: ${violations.join(', ')}` : '') +
                (missing.length ? ` | missing: ${missing.join(', ')}` : ''));
        }
    }

    // Per-category summary
    console.log('\n=== SUMMARY BY CATEGORY ===');
    const byCategory = new Map<string, RunOutcome[]>();
    for (const o of outcomes) {
        if (!byCategory.has(o.category)) { byCategory.set(o.category, []); }
        byCategory.get(o.category)!.push(o);
    }
    for (const [category, rows] of byCategory) {
        const pass = rows.filter(r => r.verdict === 'PASS').length;
        console.log(`  ${category.padEnd(20)} ${pass}/${rows.length} passed`);
    }

    // Determinism: variance across repeats of the same question.
    const repeated = [...new Set(outcomes.filter(o => outcomes.filter(x => x.id === o.id).length > 1).map(o => o.id))];
    if (repeated.length > 0) {
        console.log('\n=== DETERMINISM (repeat runs) ===');
        for (const id of repeated) {
            const rows = outcomes.filter(o => o.id === id);
            const pass = rows.filter(r => r.verdict === 'PASS').length;
            const gates = [...new Set(rows.map(r => r.gate))];
            const varianceRate = Math.round((1 - pass / rows.length) * 100);
            console.log(`  ${id}: ${pass}/${rows.length} passed (${varianceRate}% variance), gate outcomes seen: ${gates.join(', ')}`);
        }
    }

    const totalPass = outcomes.filter(o => o.verdict === 'PASS').length;
    console.log(`\nTOTAL: ${totalPass}/${outcomes.length} runs passed`);

    const outPath = path.join(process.cwd(), 'adversarial-suite-results.json');
    fs.writeFileSync(outPath, JSON.stringify({ suite: suite.name, generatedAt: new Date().toISOString(), outcomes }, null, 2), 'utf8');
    console.log(`Raw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
