import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { InvestigationEngine, InvestigationReport } from '../query/investigationEngine';
import { PlanAnalyzer } from '../query/planAnalyzer';
import { wrapHtml, escapeHtml, escapeJs, escapeAttr, unescapeAttr } from './htmlUtils';
import { resolveWorkspaceFilePath } from './workspacePathResolver';

type WebviewMessage =
    | { type: 'openFile'; filePath: string; startLine?: number }
    | { type: 'runInvestigation'; problem: string; terminalOutput?: string; cwd?: string }
    | { type: 'choosePlan' }
    | { type: 'runPlanAnalysis' };

export interface PanelDeps {
    context: vscode.ExtensionContext;
    repoguideDir: string;
    workspaceRoot: string;
    investigationEngine: InvestigationEngine;
    planAnalyzer: PlanAnalyzer;
}

let investigationPanel: vscode.WebviewPanel | undefined;
let planTrackerPanel: vscode.WebviewPanel | undefined;

export function registerPhase10Panels(deps: PanelDeps): void {
    deps.context.subscriptions.push(
        vscode.commands.registerCommand('repoguide.investigationPanel', async () => {
            await showInvestigationPanel(deps);
        }),
        vscode.commands.registerCommand('repoguide.planTrackerPanel', async () => {
            await showPlanTrackerPanel(deps);
        })
    );
}

async function showInvestigationPanel(deps: PanelDeps): Promise<void> {
    if (investigationPanel) {
        investigationPanel.reveal(vscode.ViewColumn.One);
        return;
    }
    investigationPanel = vscode.window.createWebviewPanel(
        'repoguide.investigation',
        'RepoGuide: Investigation',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    investigationPanel.onDidDispose(() => { investigationPanel = undefined; }, null, deps.context.subscriptions);
    investigationPanel.webview.onDidReceiveMessage(message => handleMessage(deps, investigationPanel!, message), null, deps.context.subscriptions);
    investigationPanel.webview.html = hasRepoGuideArtifacts(deps.repoguideDir)
        ? buildInvestigationHtml('idle')
        : wrapHtml('Investigation', `<p class="empty">RepoGuide has not indexed this workspace yet. Run indexing first.</p>`);
}

async function showPlanTrackerPanel(deps: PanelDeps): Promise<void> {
    if (planTrackerPanel) {
        planTrackerPanel.reveal(vscode.ViewColumn.One);
        return;
    }
    planTrackerPanel = vscode.window.createWebviewPanel(
        'repoguide.planTracker',
        'RepoGuide: Plan Tracker',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    planTrackerPanel.onDidDispose(() => { planTrackerPanel = undefined; }, null, deps.context.subscriptions);
    planTrackerPanel.webview.onDidReceiveMessage(message => handleMessage(deps, planTrackerPanel!, message), null, deps.context.subscriptions);
    planTrackerPanel.webview.html = hasRepoGuideArtifacts(deps.repoguideDir)
        ? buildPlanTrackerHtml(null, null)
        : wrapHtml('Plan Tracker', `<p class="empty">RepoGuide has not indexed this workspace yet. Run indexing first.</p>`);
}

async function handleMessage(deps: PanelDeps, panel: vscode.WebviewPanel, message: WebviewMessage): Promise<void> {
    if (message.type === 'openFile') {
        await openFile(deps.workspaceRoot, message.filePath, message.startLine);
        return;
    }
    if (message.type === 'runInvestigation') {
        if (!hasRepoGuideArtifacts(deps.repoguideDir)) {
            panel.webview.html = wrapHtml('Investigation', `<p class="empty">RepoGuide has not indexed this workspace yet. Run indexing first.</p>`);
            return;
        }
        const problem = (message.problem ?? '').trim();
        const terminalOutput = (message.terminalOutput ?? '').trim();
        if (!problem && !terminalOutput) return;
        panel.webview.html = buildInvestigationHtml('running');
        try {
            const report = terminalOutput
                ? await deps.investigationEngine.investigateTerminal({
                    problem_description: problem,
                    terminal_output: terminalOutput,
                    cwd: message.cwd || deps.workspaceRoot
                })
                : await deps.investigationEngine.investigate(problem);
            panel.webview.html = buildInvestigationHtml('done', report.answer, undefined, report);
        } catch (e) {
            panel.webview.html = buildInvestigationHtml('error', undefined, e instanceof Error ? e.message : String(e));
        }
        return;
    }
    if (message.type === 'choosePlan') {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Plan documents': ['md', 'txt', 'json', 'yaml', 'yml'] },
            openLabel: 'Use Plan Document'
        });
        const selected = picked?.[0]?.fsPath ?? null;
        panel.webview.html = buildPlanTrackerHtml(selected, null);
        return;
    }
    if (message.type === 'runPlanAnalysis') {
        if (!hasRepoGuideArtifacts(deps.repoguideDir)) {
            panel.webview.html = wrapHtml('Plan Tracker', `<p class="empty">RepoGuide has not indexed this workspace yet. Run indexing first.</p>`);
            return;
        }
        const state = panel.webview.html.match(/data-plan-path="([^"]*)"/)?.[1];
        const planPath = state ? unescapeAttr(state) : '';
        if (!planPath) {
            void vscode.window.showWarningMessage('RepoGuide: Choose a plan document first.');
            return;
        }
        panel.webview.html = buildPlanTrackerHtml(planPath, null, true);
        try {
            const report = await deps.planAnalyzer.analyze(planPath, deps.workspaceRoot);
            panel.webview.html = buildPlanTrackerHtml(planPath, report);
        } catch (e) {
            panel.webview.html = buildPlanTrackerHtml(planPath, null, false, e instanceof Error ? e.message : String(e));
        }
    }
}

function hasRepoGuideArtifacts(repoguideDir: string): boolean {
    return fs.existsSync(repoguideDir) && (
        fs.existsSync(path.join(repoguideDir, 'bm25_index.json')) ||
        fs.existsSync(path.join(repoguideDir, 'pagerank_graph.json')) ||
        fs.existsSync(path.join(repoguideDir, 'chunks.lance')) ||
        fs.existsSync(path.join(repoguideDir, 'understanding'))
    );
}

function buildInvestigationHtml(state: 'idle' | 'running' | 'done' | 'error', answer?: string, error?: string, report?: InvestigationReport): string {
    const customJs = `
        function runInvestigation() {
            const el = document.getElementById('problem');
            const term = document.getElementById('terminalOutput');
            vscode.postMessage({ type: 'runInvestigation', problem: el ? el.value : '', terminalOutput: term ? term.value : '' });
        }
    `;

    const inputSection = `
        <section class="card">
            <h2>Start Investigation</h2>
            <p class="empty" style="margin-bottom: 8px;">Describe a problem or paste terminal output. RepoGuide will investigate using the project context.</p>
            <textarea id="problem" placeholder="Example: The install command completes but packages are not linked correctly."></textarea>
            <textarea id="terminalOutput" placeholder="Optional: paste terminal output, stack trace, TypeScript error, or module resolution error."></textarea>
            <button onclick="runInvestigation()">Investigate</button>
        </section>
    `;

    let resultSection = '';
    if (state === 'running') {
        resultSection = `<section class="card"><p class="empty">Investigating across code, annotations, and retrieval paths...</p></section>`;
    } else if (state === 'error') {
        resultSection = `<section class="card"><p class="error">${escapeHtml(error ?? 'Investigation failed.')}</p></section>`;
    } else if (state === 'done') {
        resultSection = renderInvestigationReport(answer ?? '', report);
    }

    return wrapHtml('Investigation', inputSection + resultSection, '') + `\n<script>\n${customJs}\n</script>`;
}

function renderInvestigationReport(answer: string, report?: InvestigationReport): string {
    if (!report) {
        return `<section class="card"><h2>Analysis</h2><p>${escapeHtml(answer).replace(/\n/g, '<br>')}</p></section>`;
    }

    let html = '';
    
    // Primary Hypothesis
    if (report.primary_hypothesis) {
        const confText = Math.round(report.primary_hypothesis.confidence * 100) + '% confidence';
        const badgeClass = report.primary_hypothesis.confidence > 0.7 ? 'badge-success' : 'badge-warning';
        html += `
        <section class="card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <h2 style="margin: 0; border: none; padding: 0;">Primary Hypothesis</h2>
                <span class="badge ${badgeClass}">${confText}</span>
            </div>
            <p>${escapeHtml(report.primary_hypothesis.text)}</p>
        </section>`;
    }

    // Evidence Trail
    if (report.evidence_trail && report.evidence_trail.length > 0) {
        const evidenceItems = report.evidence_trail.map(ev => {
            const linkBtn = ev.file ? `<button class="link inline" onclick="openFile('${escapeJs(ev.file)}', ${ev.line_start ?? 'undefined'})">${escapeHtml(path.basename(ev.file))}${ev.line_start ? `:${ev.line_start}` : ''}</button>` : '';
            return `<div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--rg-border);">
                <div style="margin-bottom: 4px;">${linkBtn} <span class="mono">${escapeHtml(ev.source)}</span></div>
                <div style="font-size: 12px; margin-bottom: 4px;">${escapeHtml(ev.why_it_matters)}</div>
                ${ev.excerpt ? `<pre style="font-size: 11px; padding: 6px; background: var(--vscode-editor-background); border: 1px solid var(--rg-border); border-radius: 4px; overflow-x: auto;">${escapeHtml(ev.excerpt)}</pre>` : ''}
            </div>`;
        }).join('');
        
        html += `
        <section class="card">
            <h2>Evidence Trail</h2>
            <div>${evidenceItems}</div>
        </section>`;
    }

    // Alternative Hypotheses
    if (report.alternative_hypotheses && report.alternative_hypotheses.length > 0) {
        const altItems = report.alternative_hypotheses.map(alt => `
            <div style="margin-bottom: 8px;">
                <strong>${escapeHtml(alt.likelihood.toString())}</strong>: ${escapeHtml(alt.text)}
                <div class="empty" style="font-size: 11px; margin-top: 2px;">${escapeHtml(alt.reasoning)}</div>
            </div>
        `).join('');
        html += `
        <section class="card">
            <h2>Alternative Hypotheses</h2>
            <div>${altItems}</div>
        </section>`;
    }

    // Next Checks & Cannot Determine
    let nextSteps = '';
    if (report.next_checks && report.next_checks.length > 0) {
        nextSteps += `<div style="flex: 1; min-width: 200px;"><h3>Next Checks</h3><ul style="padding-left: 16px; margin: 4px 0;">` + report.next_checks.map(c => `<li>${escapeHtml(c)}</li>`).join('') + `</ul></div>`;
    }
    if (report.cannot_determine && report.cannot_determine.length > 0) {
        nextSteps += `<div style="flex: 1; min-width: 200px;"><h3>Cannot Determine</h3><ul style="padding-left: 16px; margin: 4px 0;" class="warning">` + report.cannot_determine.map(c => `<li>${escapeHtml(c)}</li>`).join('') + `</ul></div>`;
    }
    
    if (nextSteps) {
        html += `
        <section class="card" style="display: flex; gap: 16px; flex-wrap: wrap;">
            ${nextSteps}
        </section>`;
    }

    return html;
}

function buildPlanTrackerHtml(planPath: string | null, report: any, running = false, error?: string): string {
    const customJs = `
        function choosePlan() { vscode.postMessage({ type: 'choosePlan' }); }
        function runPlanAnalysis() { vscode.postMessage({ type: 'runPlanAnalysis' }); }
    `;

    const selected = planPath ? escapeHtml(planPath) : 'No plan document selected';
    const body = error
        ? `<p class="error">${escapeHtml(error)}</p>`
        : running
            ? '<p class="empty">Running plan analysis...</p>'
            : report
                ? renderPlanReport(report)
                : '<p class="empty">Choose a plan document, then run analysis.</p>';
    
    const ui = `
        <section class="card" data-plan-path="${escapeAttr(planPath ?? '')}">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
                <div class="mono" style="font-size: 12px; color: var(--rg-link); word-break: break-all;">${selected}</div>
                <div style="display: flex; gap: 8px;">
                    <button class="secondary" onclick="choosePlan()" style="background: transparent; color: var(--rg-muted); border: 1px solid var(--rg-border);">Choose Plan</button>
                    <button onclick="runPlanAnalysis()">Run Analysis</button>
                </div>
            </div>
        </section>
        <section>${body}</section>
    `;

    return wrapHtml('Plan Tracker', ui) + `\n<script>\n${customJs}\n</script>`;
}

function renderPlanReport(report: any): string {
    const getStatusBadge = (status: string) => {
        let cls = 'badge-warning';
        if (status === 'implemented') cls = 'badge-success';
        if (status === 'missing' || status === 'different') cls = 'badge-error';
        return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
    };

    const rows = Array.isArray(report.items) ? report.items.map((item: any) => {
        const files = Array.isArray(item.matched_files) && item.matched_files.length > 0
            ? item.matched_files.map((f: string) => `<button class="link inline" onclick="openFile('${escapeJs(f)}')">${escapeHtml(path.basename(f))}</button>`).join('')
            : '<span class="empty">none</span>';
        
        const deviation = item.deviation_note && item.status !== 'implemented' ? `<div style="font-size: 11px; margin-top: 4px; color: var(--rg-muted);">${escapeHtml(item.deviation_note)}</div>` : '';
        
        return `<tr>
            <td>
                <div style="font-weight: 500;">${escapeHtml(String(item.name ?? ''))}</div>
                <div style="font-size: 11px; color: var(--rg-muted); margin-top: 2px;">${escapeHtml(String(item.description ?? ''))}</div>
                ${deviation}
            </td>
            <td>${getStatusBadge(String(item.status ?? 'missing'))}</td>
            <td>${Math.round(Number(item.match_confidence ?? 0) * 100)}%</td>
            <td>${files}</td>
        </tr>`;
    }).join('') : '';

    const completion = Number(report.summary?.completion_percentage ?? 0);
    return `
        <div class="card" style="display: flex; align-items: center; gap: 12px;">
            <strong style="font-size: 16px;">${completion}% complete</strong>
            <div class="bar" style="flex-grow: 1; max-width: 400px;"><span style="width:${Math.max(0, Math.min(100, completion))}%"></span></div>
        </div>
        <div class="card" style="padding: 0; overflow: hidden;">
            <table>
                <thead style="background: var(--vscode-editor-background);">
                    <tr><th>Plan item</th><th>Status</th><th>Confidence</th><th>Matched files</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function openFile(workspaceRoot: string, filePath: string, startLine?: number): Promise<void> {
    const target = resolveWorkspaceFilePath(filePath, workspaceRoot);
    if (!target) {
        void vscode.window.showWarningMessage(`RepoGuide: refused to open a path outside the workspace: ${filePath}`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (typeof startLine === 'number') {
        const line = Math.max(0, Math.min(startLine, doc.lineCount - 1));
        const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0));
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
}

