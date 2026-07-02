import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    UNDERSTANDING_STAGES,
    UnderstandingManifest,
    UnderstandingStageName,
    UnderstandingStageManifest,
    loadUnderstandingManifest
} from '../comprehension/understandingManifest';
import {
    UnderstandingQualityMetrics,
    UnderstandingQualityMetricsReport
} from '../comprehension/understandingQualityMetrics';
import { ConfidenceReport, LowConfidenceItem } from '../comprehension/artifactConfidenceReport';
import { RepairQueueState, RepairItem } from '../feedback/repairQueueManager';
import { unwrapArtifact } from '../comprehension/schema-versions';
import { AnnotationHealthReport, UnderstandingHealthService, UnderstandingHealthReport } from '../comprehension/understandingHealthService';
import { wrapHtml, escapeHtml } from './htmlUtils';

// ── Data collector ─────────────────────────────────────────────────────────

interface HealthPanelData {
    manifest: UnderstandingManifest | null;
    metrics: UnderstandingQualityMetricsReport | null;
    confidence: ConfidenceReport | null;
    repairQueue: RepairQueueState | null;
    health: UnderstandingHealthReport | null;
    annotationHealth: AnnotationHealthReport | null;
    communityStatus: { count: number; lastComputed: string | null };
    bm25Status: { exists: boolean; sizeBytes: number };
    pageRankStatus: { exists: boolean; sizeBytes: number };
    isJobRunning: boolean;
}

function readJsonSafe<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) { return null; }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return unwrapArtifact<T>(parsed);
    } catch { return null; }
}

async function collectData(
    repoguideDir: string,
    workspaceRoot: string,
    getIsJobRunning: () => boolean,
    getIndexedFileCount: () => Promise<number>
): Promise<HealthPanelData> {
    const uDir = path.join(repoguideDir, 'understanding');
    const fbDir = path.join(repoguideDir, 'feedback');

    let manifest: UnderstandingManifest | null = null;
    try { manifest = await loadUnderstandingManifest(uDir, workspaceRoot); } catch { /* */ }

    let metrics: UnderstandingQualityMetricsReport | null = null;
    metrics = readJsonSafe<UnderstandingQualityMetricsReport>(path.join(uDir, 'quality_metrics.json'));
    if (!metrics) {
        try {
            const m = new UnderstandingQualityMetrics(uDir);
            metrics = m.compute();
        } catch { /* */ }
    }

    const confidence = readJsonSafe<ConfidenceReport>(path.join(uDir, 'confidence_report.json'));
    const repairQueue = readJsonSafe<RepairQueueState>(path.join(fbDir, 'repair_queue.json'));

    const healthService = new UnderstandingHealthService(uDir, workspaceRoot);
    const health = await healthService.evaluateHealth();
    const totalIndexedFiles = await getIndexedFileCount().catch(() => 0);
    const annotationHealth = await healthService.evaluateAnnotationHealth(totalIndexedFiles).catch(() => null);
    const communityPath = path.join(repoguideDir, 'community_summaries.json');
    const communityRaw = readJsonSafe<any>(communityPath);
    const communityStat = fs.existsSync(communityPath) ? fs.statSync(communityPath) : null;
    const communities = communityRaw?.communities ?? [];
    const bm25Path = path.join(repoguideDir, 'bm25_index.json');
    const pageRankPath = path.join(repoguideDir, 'pagerank_graph.json');
    const bm25Stat = fs.existsSync(bm25Path) ? fs.statSync(bm25Path) : null;
    const pageRankStat = fs.existsSync(pageRankPath) ? fs.statSync(pageRankPath) : null;

    return {
        manifest,
        metrics,
        confidence,
        repairQueue,
        health,
        annotationHealth,
        communityStatus: {
            count: Array.isArray(communities) ? communities.length : 0,
            lastComputed: communityStat ? communityStat.mtime.toISOString() : null
        },
        bm25Status: { exists: !!bm25Stat, sizeBytes: bm25Stat?.size ?? 0 },
        pageRankStatus: { exists: !!pageRankStat, sizeBytes: pageRankStat?.size ?? 0 },
        isJobRunning: getIsJobRunning()
    };
}

// ── HTML builder ───────────────────────────────────────────────────────────



function pct(n: number): string { return `${Math.round(n * 100)}%`; }

function relTime(iso: string | null | undefined): string {
    if (!iso) { return '—'; }
    const d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }
    return d.toLocaleString();
}

function stageIcon(status: string): string {
    switch (status) {
        case 'complete': return '✓';
        case 'running': return '⚡';
        case 'failed': return '✗';
        default: return '–';
    }
}

function stageIconClass(status: string): string {
    switch (status) {
        case 'complete': return 'icon-ok';
        case 'running': return 'icon-run';
        case 'failed': return 'icon-fail';
        default: return 'icon-pending';
    }
}

function stageDuration(stage: UnderstandingStageManifest): string {
    if (stage.status !== 'complete' || !stage.startedAt || !stage.completedAt) { return '—'; }
    const ms = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
    if (ms < 1000) { return `${ms}ms`; }
    return `${(ms / 1000).toFixed(1)}s`;
}

function stageArtifactCount(stage: UnderstandingStageManifest): number {
    return stage.artifactPaths?.length ?? 0;
}

function buildHealthBadge(health: string): string {
    const cls = health === 'healthy' ? 'badge-green' : health === 'degraded' ? 'badge-yellow' : 'badge-red';
    return `<span class="health-badge ${cls}">${health.toUpperCase()}</span>`;
}

function buildProgressBar(value: number): string {
    const w = Math.max(0, Math.min(100, Math.round(value * 100)));
    const cls = w >= 85 ? 'bar-green' : w >= 60 ? 'bar-yellow' : 'bar-red';
    return `<div class="progress-track"><div class="progress-fill ${cls}" style="width:${w}%"></div></div>`;
}

function buildSection1(data: HealthPanelData): string {
    const health = data.metrics?.overall_health ?? 'incomplete';
    const summary = data.metrics
        ? new UnderstandingQualityMetrics('').getSummaryLine(data.metrics)
        : 'No metrics available — run comprehension first.';
    const lastUpdated = relTime(data.manifest?.updatedAt);
    return `
    <section class="panel-section">
        <div class="banner">
            ${buildHealthBadge(health)}
            <p class="summary-line">${escapeHtml(summary)}</p>
            <p class="meta-line">Last comprehension: ${escapeHtml(lastUpdated)}</p>
        </div>
    </section>`;
}

function buildHealthSection(data: HealthPanelData): string {
    const h = data.health;
    if (!h) return '';
    
    const summaryList = [];
    if (h.missingArtifacts > 0) summaryList.push(`${h.missingArtifacts} missing`);
    if (h.staleArtifacts > 0) summaryList.push(`${h.staleArtifacts} stale`);
    if (h.lowConfidenceArtifacts > 0) summaryList.push(`${h.lowConfidenceArtifacts} low confidence`);
    const summaryText = summaryList.length > 0 ? summaryList.join(', ') : 'All artifacts present and fresh';

    const r = h.reliability;
    const relHtml = `
        <div class="metric-row">
            <span class="metric-label">Location questions</span>
            <span class="badge-row">${r.location ? '<span class="count-badge badge-green">Reliable</span>' : '<span class="count-badge badge-red">Unreliable</span>'}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Flow / Execution questions</span>
            <span class="badge-row">${r.flow ? '<span class="count-badge badge-green">Reliable</span>' : '<span class="count-badge badge-red">Unreliable</span>'}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Architecture questions</span>
            <span class="badge-row">${r.architecture ? '<span class="count-badge badge-green">Reliable</span>' : '<span class="count-badge badge-red">Unreliable</span>'}</span>
        </div>
    `;

    const regenItems = h.prioritizedRegeneration.slice(0, 5).map(a => `<li>${a}</li>`).join('');
    const regenHtml = regenItems ? `
        <div style="margin-top: 10px;">
            <p><strong>Prioritized for regeneration:</strong></p>
            <ul style="margin-left: 20px; font-size: 11px; margin-top: 4px;">${regenItems}</ul>
        </div>
    ` : '';

    return `
    <section class="panel-section">
        <h2>Artifact DAG Health</h2>
        <p class="summary-line" style="margin-bottom: 12px; font-weight: 600;">${summaryText}</p>
        ${relHtml}
        ${regenHtml}
    </section>
    `;
}

function buildArtifactTableSection(data: HealthPanelData): string {
    const h = data.health;
    if (!h) return '';

    const rows = Object.entries(h.artifacts).map(([name, stat]) => {
        const freshCls = stat.exists ? (stat.fresh ? 'icon-ok' : 'icon-fail') : 'icon-pending';
        const freshIcon = stat.exists ? (stat.fresh ? '✓' : '✗') : '–';
        const confText = stat.exists ? (stat.confidence < 0.7 ? `<span class="text-yellow">${pct(stat.confidence)}</span>` : pct(stat.confidence)) : '—';
        const gapsText = stat.coverageGaps.length > 0 ? `<span class="text-yellow">${stat.coverageGaps.length} missing files</span>` : 'None';
        
        return `<tr>
            <td class="mono">${escapeHtml(name)}</td>
            <td><span class="${stat.exists ? 'icon-ok' : 'icon-fail'}">${stat.exists ? '✓' : '✗'}</span></td>
            <td><span class="${freshCls}" title="${stat.staleReason || ''}">${freshIcon}</span></td>
            <td>${confText}</td>
            <td>${gapsText}</td>
        </tr>`;
    }).join('');

    return `
    <section class="panel-section">
        <h2>Artifact Details</h2>
        <table class="data-table">
            <thead>
                <tr><th>Artifact</th><th>Exists</th><th>Fresh</th><th>Confidence</th><th>Coverage Gaps</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </section>`;
}

function buildPhase10HealthSection(data: HealthPanelData): string {
    const a = data.annotationHealth;
    const bm25 = data.bm25Status.exists ? `Ready (${formatBytes(data.bm25Status.sizeBytes)})` : 'Missing';
    const pr = data.pageRankStatus.exists ? `Ready (${formatBytes(data.pageRankStatus.sizeBytes)})` : 'Missing';
    return `
    <section class="panel-section">
        <h2>Layer 2-6 Index Health</h2>
        <div class="metric-row">
            <span class="metric-label">Annotation coverage</span>
            ${buildProgressBar((a?.coveragePercent ?? 0) / 100)}
            <span class="metric-value">${a ? `${a.totalAnnotatedFiles}/${a.totalIndexedFiles}` : '—'}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Annotation freshness</span>
            ${buildProgressBar((a?.freshnessPercent ?? 0) / 100)}
            <span class="metric-value">${a ? `${a.staleAnnotations} stale` : '—'}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Communities</span>
            <span class="badge-row"><span class="count-badge badge-blue">${data.communityStatus.count} communities</span><span class="count-badge">${escapeHtml(relTime(data.communityStatus.lastComputed))}</span></span>
        </div>
        <div class="metric-row">
            <span class="metric-label">BM25 index</span>
            <span class="badge-row"><span class="count-badge ${data.bm25Status.exists ? 'badge-green' : 'badge-red'}">${escapeHtml(bm25)}</span></span>
        </div>
        <div class="metric-row">
            <span class="metric-label">PageRank graph</span>
            <span class="badge-row"><span class="count-badge ${data.pageRankStatus.exists ? 'badge-green' : 'badge-red'}">${escapeHtml(pr)}</span></span>
        </div>
    </section>`;
}

function buildSection2(data: HealthPanelData): string {
    if (!data.manifest) {
        return `<section class="panel-section"><h2>Stage Status</h2><p class="empty">No manifest found.</p></section>`;
    }
    const rows = UNDERSTANDING_STAGES.map(name => {
        const stage = data.manifest!.stages[name] ?? { status: 'pending', startedAt: null, completedAt: null, error: null, artifactPaths: [], inputHash: null, stats: {} };
        return `<tr>
            <td><span class="${stageIconClass(stage.status)}">${stageIcon(stage.status)}</span></td>
            <td>${escapeHtml(name)}</td>
            <td>${stageDuration(stage)}</td>
            <td>${stageArtifactCount(stage)}</td>
        </tr>`;
    }).join('');
    return `
    <section class="panel-section">
        <h2>Stage Status</h2>
        <table class="data-table"><thead><tr><th></th><th>Stage</th><th>Duration</th><th>Artifacts</th></tr></thead>
        <tbody>${rows}</tbody></table>
    </section>`;
}

function buildSection3(data: HealthPanelData): string {
    const m = data.metrics?.metrics;
    if (!m) {
        return `<section class="panel-section"><h2>Quality Metrics</h2><p class="empty">No quality metrics computed yet.</p></section>`;
    }
    const errors = m.validation_issue_counts.errors;
    const warnings = m.validation_issue_counts.warnings;
    const errBadge = errors > 0 ? `<span class="count-badge badge-red">${errors} errors</span>` : `<span class="count-badge badge-green">0 errors</span>`;
    const warnBadge = warnings > 0 ? `<span class="count-badge badge-yellow">${warnings} warnings</span>` : `<span class="count-badge badge-green">0 warnings</span>`;
    return `
    <section class="panel-section">
        <h2>Quality Metrics</h2>
        <div class="metric-row">
            <span class="metric-label">File understanding coverage</span>
            ${buildProgressBar(m.file_understanding_coverage)}
            <span class="metric-value">${pct(m.file_understanding_coverage)}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Call graph resolution rate</span>
            ${buildProgressBar(m.call_graph_resolution_rate)}
            <span class="metric-value">${pct(m.call_graph_resolution_rate)}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Concept map precision</span>
            ${buildProgressBar(m.concept_map_precision)}
            <span class="metric-value">${pct(m.concept_map_precision)}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Behavioral path coverage</span>
            ${buildProgressBar(m.behavioral_path_coverage)}
            <span class="metric-value">${pct(m.behavioral_path_coverage)}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Validation issues</span>
            <span class="badge-row">${errBadge} ${warnBadge}</span>
        </div>
        <div class="metric-row">
            <span class="metric-label">Low-confidence artifacts</span>
            <span class="metric-value">${m.low_confidence_artifact_count}</span>
        </div>
    </section>`;
}

function buildSection4(data: HealthPanelData): string {
    const items: Array<{ artifact: string; id: string; field: string; confidence: number }> = [];
    if (data.confidence) {
        for (const [artifactType, artifact] of Object.entries(data.confidence.artifacts)) {
            for (const lci of artifact.lowConfidenceItems) {
                items.push({ artifact: artifactType, id: lci.id, field: lci.field, confidence: lci.confidence });
            }
        }
    }
    items.sort((a, b) => a.confidence - b.confidence);
    const display = items.slice(0, 20);
    if (display.length === 0) {
        return `<section class="panel-section"><h2>Low-Confidence Artifacts</h2><p class="empty">No low-confidence artifacts found.</p></section>`;
    }
    const rows = display.map(i => `<tr>
        <td>${escapeHtml(i.artifact)}</td>
        <td class="mono">${escapeHtml(i.id)}</td>
        <td>${escapeHtml(i.field)}</td>
        <td class="${i.confidence < 0.3 ? 'text-red' : 'text-yellow'}">${i.confidence.toFixed(2)}</td>
    </tr>`).join('');
    const showAll = items.length > 20 ? `<button class="action-btn secondary" onclick="showAllConfidence()">Show all (${items.length})</button>` : '';
    return `
    <section class="panel-section">
        <h2>Low-Confidence Artifacts</h2>
        <table class="data-table"><thead><tr><th>Type</th><th>File / ID</th><th>Field</th><th>Score</th></tr></thead>
        <tbody>${rows}</tbody></table>
        ${showAll}
    </section>`;
}

function buildSection5(data: HealthPanelData): string {
    const q = data.repairQueue;
    if (!q || q.items.length === 0) {
        return `<section class="panel-section"><h2>Repair Queue</h2><p class="empty">Repair queue is empty.</p>
        <button class="action-btn" onclick="cmd('processRepairQueue')">Process repair queue now</button></section>`;
    }
    let pending = 0, running = 0, complete = 0, failed = 0;
    for (const i of q.items) {
        if (i.status === 'pending') pending++;
        else if (i.status === 'running') running++;
        else if (i.status === 'complete') complete++;
        else if (i.status === 'failed') failed++;
    }
    const pendingItems = q.items.filter((i: any) => i.status === 'pending').slice(0, 15);
    const rows = pendingItems.map((i: any) => `<tr>
        <td>${escapeHtml(i.repairType)}</td>
        <td class="mono">${escapeHtml(i.relativePath ?? i.targetId)}</td>
        <td><span class="priority-${i.priority}">${i.priority}</span></td>
        <td>${relTime(i.createdAt)}</td>
    </tr>`).join('');
    return `
    <section class="panel-section">
        <h2>Repair Queue</h2>
        <div class="repair-summary">
            <span class="count-badge badge-yellow">${pending} pending</span>
            <span class="count-badge badge-blue">${running} running</span>
            <span class="count-badge badge-green">${complete} complete</span>
            ${failed > 0 ? `<span class="count-badge badge-red">${failed} failed</span>` : ''}
        </div>
        ${pendingItems.length > 0 ? `<table class="data-table"><thead><tr><th>Type</th><th>Target</th><th>Priority</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody></table>` : ''}
        <button class="action-btn" onclick="cmd('processRepairQueue')">Process repair queue now</button>
    </section>`;
}

function buildSection6(): string {
    return `
    <section class="panel-section">
        <h2>Actions</h2>
        <div class="action-grid">
            <button class="action-btn" onclick="cmd('rebuildFullIndex')">Rebuild full index</button>
            <button class="action-btn" onclick="cmd('rebuildBehavioralPaths')">Rebuild behavioral paths</button>
            <button class="action-btn" onclick="cmd('rebuildConceptMap')">Rebuild concept map</button>
            <button class="action-btn" onclick="cmd('importExecutionTrace')">Import execution trace</button>
            <button class="action-btn" onclick="cmd('exportQualityReport')">Export quality report</button>
        </div>
    </section>`;
}

function buildFullHtml(data: HealthPanelData, allConfidenceJson: string): string {
    const body = `
    <div style="max-width: 960px;">
        ${buildSection1(data)}
        ${buildPhase10HealthSection(data)}
        ${buildHealthSection(data)}
        ${buildArtifactTableSection(data)}
        ${buildSection2(data)}
        ${buildSection3(data)}
        ${buildSection4(data)}
        ${buildSection5(data)}
        ${buildSection6()}
        ${data.isJobRunning ? '<p class="empty" style="text-align:center; font-style:italic;">Auto-refreshing every 30s (comprehension job running)</p>' : ''}
        <div id="jsonOverlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:var(--rg-bg); z-index:100; padding:16px; overflow:auto;">
            <button class="secondary" style="position:fixed; top:8px; right:16px;" onclick="document.getElementById('jsonOverlay').style.display='none'">Close</button>
            <pre id="jsonContent" class="mono" style="white-space:pre-wrap; font-size:11px;"></pre>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const allConfidence = ${allConfidenceJson};

        function cmd(action) { vscode.postMessage({ type: 'action', action }); }

        function showAllConfidence() {
            document.getElementById('jsonContent').textContent = JSON.stringify(allConfidence, null, 2);
            document.getElementById('jsonOverlay').style.display = 'block';
        }

        window.addEventListener('message', event => {
            if (event.data.type === 'refresh') { vscode.postMessage({ type: 'requestRefresh' }); }
        });
    </script>
    `;

    return wrapHtml('Index Health', body, `
        .panel-section { margin-bottom: 24px; }
        .data-table th, .data-table td { padding: 6px 12px; }
        .data-table { margin-bottom: 12px; }
        .banner { text-align: center; padding: 12px 0 16px; }
        .health-badge {
            display: inline-block; font-size: 15px; font-weight: 700;
            padding: 6px 22px; border-radius: 6px; letter-spacing: 1px;
        }
        .summary-line { margin-top: 8px; font-size: 13px; color: var(--rg-muted); }
        .meta-line { font-size: 11px; color: var(--rg-muted); margin-top: 2px; }
        .badge-green { background: color-mix(in srgb, var(--rg-success) 15%, transparent); color: var(--rg-success); border: 1px solid color-mix(in srgb, var(--rg-success) 30%, transparent); }
        .badge-yellow { background: color-mix(in srgb, var(--rg-warning) 15%, transparent); color: var(--rg-warning); border: 1px solid color-mix(in srgb, var(--rg-warning) 30%, transparent); }
        .badge-red { background: color-mix(in srgb, var(--rg-error) 15%, transparent); color: var(--rg-error); border: 1px solid color-mix(in srgb, var(--rg-error) 30%, transparent); }
        .badge-blue { background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); color: var(--vscode-textLink-foreground); border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent); }
        .icon-ok { color: var(--rg-success); }
        .icon-run { color: var(--vscode-textLink-foreground); }
        .icon-fail { color: var(--rg-error); }
        .icon-pending { color: var(--rg-muted); }
        .text-red { color: var(--rg-error); font-weight: 600; }
        .text-yellow { color: var(--rg-warning); font-weight: 600; }
        .progress-track {
            flex: 1; height: 8px; border-radius: 4px;
            background: var(--rg-border);
            overflow: hidden;
        }
        .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
        .bar-green { background: var(--rg-success); }
        .bar-yellow { background: var(--rg-warning); }
        .bar-red { background: var(--rg-error); }
        .badge-row { display: flex; gap: 6px; flex: 1; }
        .count-badge {
            display: inline-block; font-size: 11px; font-weight: 600;
            padding: 2px 8px; border-radius: 10px;
        }
        .repair-summary { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        .priority-high { color: var(--rg-error); font-weight: 600; }
        .priority-medium { color: var(--rg-warning); }
        .priority-low { color: var(--rg-muted); }
    `);
}

// ── Panel controller ───────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

export function registerIndexHealthPanelCommand(
    context: vscode.ExtensionContext,
    repoguideDir: string,
    workspaceRoot: string,
    getIsJobRunning: () => boolean,
    getIndexedFileCount: () => Promise<number>,
    onRebuildFullIndex: () => Promise<void>,
    onRebuildBehavioralPaths: () => Promise<void>,
    onRebuildConceptMap: () => Promise<void>,
    onProcessRepairQueue: () => Promise<void>,
    onImportExecutionTrace: () => Promise<void>
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('repoguide.indexHealth', async () => {
            if (currentPanel) {
                currentPanel.reveal(vscode.ViewColumn.One);
                await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
                return;
            }

            currentPanel = vscode.window.createWebviewPanel(
                'repoguide.indexHealth',
                'RepoGuide: Index Health',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
                if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = undefined; }
            }, null, context.subscriptions);

            // Handle messages from the webview
            currentPanel.webview.onDidReceiveMessage(async message => {
                if (message.type === 'action') {
                    switch (message.action) {
                        case 'rebuildFullIndex':
                            await onRebuildFullIndex();
                            break;
                        case 'rebuildBehavioralPaths':
                            await onRebuildBehavioralPaths();
                            break;
                        case 'rebuildConceptMap':
                            await onRebuildConceptMap();
                            break;
                        case 'processRepairQueue':
                            await onProcessRepairQueue();
                            break;
                        case 'importExecutionTrace':
                            await onImportExecutionTrace();
                            break;
                        case 'exportQualityReport':
                            await exportQualityReport(repoguideDir, workspaceRoot);
                            break;
                    }
                    // Refresh after action
                    if (currentPanel) {
                        await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
                    }
                } else if (message.type === 'requestRefresh') {
                    if (currentPanel) {
                        await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
                    }
                }
            }, null, context.subscriptions);

            await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
            startAutoRefresh(repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
        })
    );
}

let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

function startAutoRefresh(
    repoguideDir: string,
    workspaceRoot: string,
    getIsJobRunning: () => boolean,
    getIndexedFileCount: () => Promise<number>
): void {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); }
    
    // Poll job status
    autoRefreshTimer = setInterval(async () => {
        if (!currentPanel) { clearInterval(autoRefreshTimer); autoRefreshTimer = undefined; return; }
        if (getIsJobRunning()) {
            await currentPanel.webview.postMessage({ type: 'refresh' });
            await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
        }
    }, 30_000);

    // Watch for staleness registry changes for immediate updates
    const stalenessPath = path.join(repoguideDir, 'understanding', 'staleness_registry.json');
    if (fs.existsSync(path.dirname(stalenessPath))) {
        let debounceTimer: NodeJS.Timeout | undefined;
        try {
            const watcher = fs.watch(path.dirname(stalenessPath), (eventType, filename) => {
                if (filename === 'staleness_registry.json' && currentPanel) {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                        await currentPanel?.webview.postMessage({ type: 'refresh' });
                        if (currentPanel) {
                            await refreshPanel(currentPanel, repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
                        }
                    }, 200);
                }
            });
            currentPanel?.onDidDispose(() => {
                watcher.close();
                if (debounceTimer) clearTimeout(debounceTimer);
            });
        } catch { /* ignore */ }
    }
}

async function refreshPanel(
    panel: vscode.WebviewPanel,
    repoguideDir: string,
    workspaceRoot: string,
    getIsJobRunning: () => boolean,
    getIndexedFileCount: () => Promise<number>
): Promise<void> {
    const data = await collectData(repoguideDir, workspaceRoot, getIsJobRunning, getIndexedFileCount);
    const allConfidence = data.confidence ? JSON.stringify(data.confidence) : '{}';
    panel.webview.html = buildFullHtml(data, allConfidence);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function exportQualityReport(repoguideDir: string, workspaceRoot: string): Promise<void> {
    const uDir = path.join(repoguideDir, 'understanding');
    let metrics: UnderstandingQualityMetricsReport | null = null;
    try {
        const m = new UnderstandingQualityMetrics(uDir);
        metrics = m.compute();
    } catch { /* */ }
    if (!metrics) {
        vscode.window.showWarningMessage('RepoGuide: No quality metrics to export.');
        return;
    }
    const target = path.join(workspaceRoot, 'repoguide-quality-report.json');
    fs.writeFileSync(target, JSON.stringify(metrics, null, 2), 'utf8');
    vscode.window.showInformationMessage(`Quality report exported to ${target}`);
}
