/**
 * repoguideLogger.ts — Phase 11.2
 *
 * Structured output logger for RepoGuide. Replaces ad-hoc console.log /
 * outputChannel.appendLine calls with a singleton that writes to:
 *   1. VS Code OutputChannel "RepoGuide"
 *   2. Daily-rotating log file: .repoguide/logs/repoguide-YYYY-MM-DD.log
 *
 * Provides specialized methods for stage lifecycle, artifact writes,
 * query tracing, repair events, and error reporting — all with
 * timestamps and structured formatting.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Logger, StageProgressOptions, ArtifactWriteOptions, QueryLogOptions, RepairLogOptions, LogLevel } from '../context/repositoryContext';

// ── ETA tracker ────────────────────────────────────────────────────────────

class ETATracker {
    private windowSize = 10;
    private durations: number[] = [];
    private lastTickMs = 0;

    reset(): void {
        this.durations = [];
        this.lastTickMs = 0;
    }

    tick(): void {
        const now = Date.now();
        if (this.lastTickMs > 0) {
            const elapsed = now - this.lastTickMs;
            this.durations.push(elapsed);
            if (this.durations.length > this.windowSize) {
                this.durations.shift();
            }
        }
        this.lastTickMs = now;
    }

    getETA(remaining: number): string {
        if (this.durations.length === 0 || remaining <= 0) { return ''; }
        const avgMs = this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
        const etaMs = avgMs * remaining;
        const avgSec = (avgMs / 1000).toFixed(1);
        if (etaMs < 60_000) {
            return `ETA: ${Math.ceil(etaMs / 1000)}s (avg ${avgSec}s each)`;
        }
        return `ETA: ${Math.ceil(etaMs / 60_000)}min (avg ${avgSec}s each)`;
    }
}

// ── Logger ─────────────────────────────────────────────────────────────────

export class RepoGuideLogger implements Logger {
    appendLine(message: string): void { this.info(message); }
    private outputChannel: vscode.OutputChannel;
    private logDir: string | null = null;
    private currentLogDate: string | null = null;
    private logStream: fs.WriteStream | null = null;
    private debugEnabled = false;
    private etaTrackers = new Map<string, ETATracker>();

    constructor(outputChannel: vscode.OutputChannel, repoguideDir?: string) {
        this.outputChannel = outputChannel;
        if (repoguideDir) {
            this.setLogDir(repoguideDir);
        }
        this.debugEnabled = vscode.workspace
            .getConfiguration('repoguide')
            .get<boolean>('debugLogging', false);
    }

    /**
     * Returns the underlying OutputChannel so existing code that
     * passes `outputChannel` to sub-components can pass this instead.
     */
    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }

    // ── Configuration ──────────────────────────────────────────────────────

    private setLogDir(repoguideDir: string): void {
        this.logDir = path.join(repoguideDir, 'logs');
        try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* */ }
    }

    setDebug(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    // ── Core write ─────────────────────────────────────────────────────────

    private timestamp(): string {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    private write(level: LogLevel, message: string): void {
        const ts = this.timestamp();
        const prefix = level === 'INFO'
            ? `[RepoGuide] [${ts}]`
            : `[RepoGuide] [${ts}] [${level}]`;
        const line = `${prefix} ${message}`;

        this.outputChannel.appendLine(line);
        this.writeToFile(line);
    }

    private writeToFile(line: string): void {
        if (!this.logDir) { return; }

        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        if (today !== this.currentLogDate) {
            this.rotateLogFile(today);
        }

        try {
            this.logStream?.write(line + '\n');
        } catch { /* non-critical */ }
    }

    private rotateLogFile(date: string): void {
        try {
            this.logStream?.end();
        } catch { /* */ }

        this.currentLogDate = date;
        const logPath = path.join(this.logDir!, `repoguide-${date}.log`);
        try {
            this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
        } catch {
            this.logStream = null;
        }

        // Clean up logs older than 7 days
        this.cleanOldLogs();
    }

    private cleanOldLogs(): void {
        if (!this.logDir) { return; }
        try {
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            for (const file of fs.readdirSync(this.logDir)) {
                if (!file.startsWith('repoguide-') || !file.endsWith('.log')) { continue; }
                const dateStr = file.replace('repoguide-', '').replace('.log', '');
                const fileDate = new Date(dateStr).getTime();
                if (!isNaN(fileDate) && fileDate < cutoff) {
                    fs.unlinkSync(path.join(this.logDir, file));
                }
            }
        } catch { /* non-critical */ }
    }

    // ── Public API: general log levels ─────────────────────────────────────

    debug(message: string): void {
        if (this.debugEnabled) { this.write('DEBUG', message); }
    }

    info(message: string): void {
        this.write('INFO', message);
    }

    warn(message: string): void {
        this.write('WARN', message);
    }

    error(message: string): void {
        this.write('ERROR', message);
    }

    // ── Public API: stage lifecycle ────────────────────────────────────────

    stageStart(stageName: string, totalItems?: number): void {
        const count = totalItems !== undefined ? ` (${totalItems} files)` : '';
        this.write('INFO', `Stage started: ${stageName}${count}`);
        // Reset ETA tracker for this stage
        const tracker = new ETATracker();
        this.etaTrackers.set(stageName, tracker);
    }

    stageProgress(opts: StageProgressOptions): void {
        const tracker = this.etaTrackers.get(opts.stageName);
        tracker?.tick();

        const pctComplete = opts.total > 0
            ? ((opts.current / opts.total) * 100).toFixed(1)
            : '0.0';
        const failedStr = opts.failed ? `, ${opts.failed} failed` : '';
        const cachedStr = opts.cached ? `, ${opts.cached} cached` : '';
        const remaining = opts.total - opts.current;
        const eta = tracker?.getETA(remaining) ?? '';
        const etaStr = eta ? ` — ${eta}` : '';
        this.write(
            'INFO',
            `Stage progress: ${opts.stageName} ${opts.current}/${opts.total}` +
            ` (${pctComplete}% complete${failedStr}${cachedStr})${etaStr}`
        );
    }

    stageComplete(
        stageName: string,
        stats?: { total?: number; failed?: number; durationSec?: number }
    ): void {
        const parts: string[] = [];
        if (stats?.total !== undefined) { parts.push(`${stats.total} files`); }
        if (stats?.failed) { parts.push(`${stats.failed} failed`); }
        if (stats?.durationSec !== undefined) {
            const dur = stats.durationSec >= 60
                ? `${(stats.durationSec / 60).toFixed(1)}min`
                : `${stats.durationSec.toFixed(1)}s`;
            parts.push(dur);
        }
        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        this.write('INFO', `Stage complete: ${stageName}${detail}`);
        this.etaTrackers.delete(stageName);
    }

    stageFailed(stageName: string, error: string | Error, context?: string): void {
        const msg = error instanceof Error ? error.message : error;
        const ctx = context ? ` ${context}` : '';
        this.write('ERROR', `Stage failed: ${stageName}${ctx} — ${msg}`);
        this.etaTrackers.delete(stageName);
    }

    // ── Public API: artifact writes ────────────────────────────────────────

    artifactWritten(opts: ArtifactWriteOptions): void {
        const parts: string[] = [];
        if (opts.stats) {
            for (const [k, v] of Object.entries(opts.stats)) {
                parts.push(`${v} ${k}`);
            }
        }
        if (opts.sizeBytes !== undefined) {
            parts.push(formatBytes(opts.sizeBytes));
        }
        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        this.write('INFO', `Artifact written: ${opts.artifactName}${detail}`);
    }

    // ── Public API: query tracing ──────────────────────────────────────────

    queryLog(opts: QueryLogOptions): void {
        const intentStr = opts.intent ? ` (intent: ${opts.intent})` : '';
        this.write('INFO', `Query: "${opts.query}"${intentStr}`);

        if (opts.retrievalSources && opts.retrievalSources.length > 0) {
            this.write('INFO', `Retrieval: ${opts.retrievalSources.join(' + ')}`);
        }

        if (opts.answerTimeMs !== undefined) {
            const timeSec = (opts.answerTimeMs / 1000).toFixed(1);
            const tokens = opts.tokenCount ? `, ${opts.tokenCount} tokens` : '';
            this.write('INFO', `Answer generated (${timeSec}s${tokens})`);
        }
    }

    // ── Public API: repair events ──────────────────────────────────────────

    repairLog(opts: RepairLogOptions): void {
        switch (opts.action) {
            case 'queued': {
                const blame = opts.blameScore !== undefined
                    ? ` (blame ${opts.blameScore.toFixed(2)})`
                    : '';
                this.write('INFO', `Repair queued: ${opts.repairType} ${opts.target}${blame}`);
                break;
            }
            case 'started':
                this.write('INFO', `Repair started: ${opts.repairType} ${opts.target}`);
                break;
            case 'complete': {
                const dur = opts.durationSec !== undefined
                    ? ` (${opts.durationSec.toFixed(1)}s)`
                    : '';
                this.write('INFO', `Repair complete: ${opts.target}${dur}`);
                break;
            }
            case 'failed': {
                const err = opts.error ? ` — ${opts.error}` : '';
                this.write('ERROR', `Repair failed: ${opts.target}${err}`);
                break;
            }
        }
    }

    // ── Disposal ───────────────────────────────────────────────────────────

    dispose(): void {
        try { this.logStream?.end(); } catch { /* */ }
        this.logStream = null;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes}B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
