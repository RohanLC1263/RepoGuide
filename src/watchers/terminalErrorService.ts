import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { stripAnsi } from '../query/errorPreprocessor';

export type TerminalErrorSource = 'shell_integration' | 'manual_paste';

export interface TerminalErrorRecord {
    id: string;
    command: string;
    exit_code: number | null;
    output: string;
    timestamp: string;
    cwd: string;
    source: TerminalErrorSource;
}

interface CaptureState {
    command: string;
    cwd: string;
    output: string[];
}

const MAX_ERRORS = 10;
const MAX_OUTPUT_CHARS = 20_000;
const NOTIFICATION_INTERVAL_MS = 90_000;

export class TerminalErrorService {
    private readonly terminalDir: string;
    private readonly recentErrorsPath: string;
    private readonly captureStates = new WeakMap<vscode.TerminalShellExecution, CaptureState>();
    private lastNotificationAt = 0;

    constructor(
        private readonly repoguideDir: string,
        private readonly workspaceRoot: string,
        private readonly outputChannel?: { appendLine(message: string): void }
    ) {
        this.terminalDir = path.join(repoguideDir, 'terminal');
        this.recentErrorsPath = path.join(this.terminalDir, 'recent_errors.jsonl');
    }

    async recordError(input: {
        command: string;
        exit_code?: number | null;
        output: string;
        cwd?: string;
        source: TerminalErrorSource;
    }): Promise<TerminalErrorRecord> {
        const record: TerminalErrorRecord = {
            id: crypto.randomUUID(),
            command: input.command || '(unknown command)',
            exit_code: input.exit_code ?? null,
            output: truncate(stripAnsi(input.output), MAX_OUTPUT_CHARS),
            timestamp: new Date().toISOString(),
            cwd: input.cwd || this.workspaceRoot,
            source: input.source
        };

        const existing = await this.getRecentErrors();
        const next = [...existing, record].slice(-MAX_ERRORS);
        await fs.promises.mkdir(this.terminalDir, { recursive: true });
        await fs.promises.writeFile(
            this.recentErrorsPath,
            next.map(item => JSON.stringify(item)).join('\n') + (next.length > 0 ? '\n' : ''),
            'utf8'
        );
        this.outputChannel?.appendLine(`[TerminalError] Stored ${record.source} error ${record.id} (${record.command})`);
        return record;
    }

    async getRecentErrors(): Promise<TerminalErrorRecord[]> {
        if (!fs.existsSync(this.recentErrorsPath)) {
            return [];
        }
        const raw = await fs.promises.readFile(this.recentErrorsPath, 'utf8').catch(() => '');
        return raw
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try {
                    return JSON.parse(line) as TerminalErrorRecord;
                } catch {
                    return null;
                }
            })
            .filter((item): item is TerminalErrorRecord => !!item)
            .slice(-MAX_ERRORS);
    }

    async getLastError(): Promise<TerminalErrorRecord | null> {
        const recent = await this.getRecentErrors();
        return recent[recent.length - 1] ?? null;
    }

    registerShellIntegrationCapture(context: vscode.ExtensionContext): void {
        const windowWithTerminalEvents = vscode.window as typeof vscode.window & {
            onDidStartTerminalShellExecution?: typeof vscode.window.onDidStartTerminalShellExecution;
            onDidEndTerminalShellExecution?: typeof vscode.window.onDidEndTerminalShellExecution;
        };
        if (!windowWithTerminalEvents.onDidStartTerminalShellExecution || !windowWithTerminalEvents.onDidEndTerminalShellExecution) {
            this.outputChannel?.appendLine('[TerminalError] VS Code shell integration events are unavailable; automatic terminal capture disabled.');
            return;
        }

        context.subscriptions.push(
            windowWithTerminalEvents.onDidStartTerminalShellExecution(event => {
                const state: CaptureState = {
                    command: event.execution.commandLine.value,
                    cwd: event.execution.cwd?.fsPath ?? this.workspaceRoot,
                    output: []
                };
                this.captureStates.set(event.execution, state);
                void this.readExecutionOutput(event.execution, state);
            }),
            windowWithTerminalEvents.onDidEndTerminalShellExecution(event => {
                if (event.exitCode === undefined || event.exitCode === 0) {
                    return;
                }
                const state = this.captureStates.get(event.execution);
                const output = state?.output.join('') ?? '';
                void this.recordError({
                    command: state?.command ?? event.execution.commandLine.value,
                    exit_code: event.exitCode,
                    output,
                    cwd: state?.cwd ?? event.execution.cwd?.fsPath ?? this.workspaceRoot,
                    source: 'shell_integration'
                }).then(record => this.maybeNotify(record));
            })
        );
        this.outputChannel?.appendLine('[TerminalError] Automatic shell integration capture enabled.');
    }

    private async readExecutionOutput(execution: vscode.TerminalShellExecution, state: CaptureState): Promise<void> {
        try {
            for await (const chunk of execution.read()) {
                state.output.push(chunk);
                const total = state.output.reduce((sum, item) => sum + item.length, 0);
                if (total > MAX_OUTPUT_CHARS) {
                    state.output = [state.output.join('').slice(-MAX_OUTPUT_CHARS)];
                }
            }
        } catch (error) {
            this.outputChannel?.appendLine(`[TerminalError] Failed to read terminal output: ${String(error)}`);
        }
    }

    private maybeNotify(record: TerminalErrorRecord): void {
        const now = Date.now();
        if (now - this.lastNotificationAt < NOTIFICATION_INTERVAL_MS) {
            return;
        }
        this.lastNotificationAt = now;
        void vscode.window.showInformationMessage(
            `RepoGuide captured a failed terminal command: ${record.command}`,
            'Investigate Last Error'
        ).then(action => {
            if (action === 'Investigate Last Error') {
                void vscode.commands.executeCommand('repoguide.investigateLastError');
            }
        });
    }
}

function truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
