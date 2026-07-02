import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NotesManager } from '../notes/notesManager';
import { StalenessRegistry } from '../comprehension/stalenessRegistry';
import { LanceStore } from '../store/lanceStore';

const execFileAsync = promisify(execFile);

export interface ChangedFile {
    file: string;
    change_type?: string;
    last_modified?: string;
    commits?: string[];
}

export interface AffectedModule {
    name: string;
    files: string[];
    summary?: string;
}

export interface StaleAnnotationBrief {
    file: string;
    reason?: string;
}

export interface RelatedNoteBrief {
    note_id: string;
    file: string;
    title: string;
    content: string;
}

export interface SuggestedStartingPoint {
    file: string;
    reason: string;
}

export interface DailyBrief {
    since: string;
    generated_at: string;
    changed_files: ChangedFile[];
    affected_modules: AffectedModule[];
    stale_annotations: StaleAnnotationBrief[];
    related_notes: RelatedNoteBrief[];
    suggested_starting_point?: SuggestedStartingPoint;
    data_sources: string[];
    warnings: string[];
}

interface SessionState {
    last_session_time: string;
}

export class DailyBriefService {
    private sessionFilePath: string;

    constructor(
        private workspaceRoot: string,
        private repoguideDir: string,
        private notesManager: NotesManager,
        private stalenessRegistry: StalenessRegistry,
        private store: LanceStore
    ) {
        const sessionDir = path.join(this.repoguideDir, 'session');
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        this.sessionFilePath = path.join(sessionDir, 'last_session.json');
    }

    private getLastSessionTime(): string | null {
        if (!fs.existsSync(this.sessionFilePath)) {
            return null;
        }
        try {
            const data = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf8')) as SessionState;
            return data.last_session_time;
        } catch {
            return null;
        }
    }

    private setLastSessionTime(time: string): void {
        const data: SessionState = { last_session_time: time };
        fs.writeFileSync(this.sessionFilePath, JSON.stringify(data, null, 2), 'utf8');
    }

    private async getGitChangesSince(since: string): Promise<{ changedFiles: ChangedFile[], warnings: string[] }> {
        const changedFiles = new Map<string, ChangedFile>();
        const warnings: string[] = [];
        try {
            // Get files changed and change types
            const { stdout: nameStatusOut } = await execFileAsync('git', ['log', `--since="${since}"`, '--name-status', '--oneline'], { cwd: this.workspaceRoot });
            
            const lines = nameStatusOut.split('\n').filter(l => l.trim().length > 0);
            let currentCommitMsg = '';
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length === 1) {
                    // This is a commit header line
                    currentCommitMsg = line.trim();
                } else if (parts.length >= 2) {
                    // This is a file change line (e.g., "M\tpath/to/file")
                    const status = parts[0].trim();
                    const file = parts[parts.length - 1].trim(); // Handle renames where there are 3 parts (status, old, new)
                    
                    if (!changedFiles.has(file)) {
                        changedFiles.set(file, { file, change_type: status, commits: [] });
                    }
                    if (currentCommitMsg) {
                        const existing = changedFiles.get(file)!;
                        if (!existing.commits!.includes(currentCommitMsg)) {
                            existing.commits!.push(currentCommitMsg);
                        }
                    }
                }
            }
        } catch (e: any) {
            warnings.push(`Git changed file detection failed: ${e.message}`);
        }
        return { changedFiles: Array.from(changedFiles.values()), warnings };
    }

    private async getFallbackChangesSince(since: string): Promise<ChangedFile[]> {
        const sinceMs = new Date(since).getTime();
        const changedFiles: ChangedFile[] = [];
        try {
            const indexedFiles = await this.store.getAllFilePaths();
            for (const file of indexedFiles) {
                const fullPath = path.isAbsolute(file) ? file : path.join(this.workspaceRoot, file);
                try {
                    const stats = await fs.promises.stat(fullPath);
                    if (stats.mtimeMs > sinceMs) {
                        changedFiles.push({
                            file,
                            change_type: 'modified',
                            last_modified: new Date(stats.mtimeMs).toISOString()
                        });
                    }
                } catch {
                    // File might be deleted
                }
            }
        } catch {
            // Ignore LanceStore read errors for fallback
        }
        return changedFiles;
    }

    private getCommunitySummaries(): any[] {
        const p = path.join(this.repoguideDir, 'community_summaries.json');
        if (fs.existsSync(p)) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).communities || [];
            } catch { }
        }
        return [];
    }
    
    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    }

    public async generateBrief(): Promise<DailyBrief> {
        const now = new Date().toISOString();
        const lastSession = this.getLastSessionTime();
        
        if (!lastSession) {
            this.setLastSessionTime(now);
            return {
                since: now,
                generated_at: now,
                changed_files: [],
                affected_modules: [],
                stale_annotations: [],
                related_notes: [],
                data_sources: ['first_session'],
                warnings: ['First session recorded. No brief available yet.']
            };
        }

        const dataSources: string[] = [];
        let { changedFiles, warnings } = await this.getGitChangesSince(lastSession);
        
        if (changedFiles.length > 0) {
            dataSources.push('git');
        } else if (warnings.length > 0) {
            // Git failed, try fallback
            dataSources.push('mtime_fallback');
            changedFiles = await this.getFallbackChangesSince(lastSession);
            if (changedFiles.length > 0) {
                warnings = ['Used mtime fallback for file changes due to git error.'];
            }
        } else {
            // Git succeeded but no files
            dataSources.push('git');
        }

        // Map Context
        const affectedModules = new Map<string, AffectedModule>();
        const staleAnnotations: StaleAnnotationBrief[] = [];
        const relatedNotes: RelatedNoteBrief[] = [];
        
        const communities = this.getCommunitySummaries();

        for (const change of changedFiles) {
            const normalizedChange = this.normalizePath(change.file);
            
            // Modules
            for (const comm of communities) {
                const commFiles = comm.files as string[];
                const match = commFiles.some(f => this.normalizePath(f).endsWith(normalizedChange) || normalizedChange.endsWith(this.normalizePath(f)));
                if (match) {
                    if (!affectedModules.has(comm.name)) {
                        affectedModules.set(comm.name, {
                            name: comm.name,
                            files: [],
                            summary: comm.summary
                        });
                    }
                    const mod = affectedModules.get(comm.name)!;
                    if (!mod.files.includes(change.file)) {
                        mod.files.push(change.file);
                    }
                }
            }

            // Stale Annotations
            const allDirty = this.stalenessRegistry.getAllDirtyArtifacts();
            for (const artifactId of allDirty) {
                const dirtyState = this.stalenessRegistry.getDirtyState(artifactId);
                if (dirtyState && dirtyState.triggerFiles.some(f => this.normalizePath(f).endsWith(normalizedChange) || normalizedChange.endsWith(this.normalizePath(f)))) {
                    staleAnnotations.push({
                        file: change.file,
                        reason: dirtyState.reason
                    });
                }
            }

            // Related Notes
            const notes = await this.notesManager.findNotesForFile(change.file);
            for (const note of notes) {
                // Avoid duplicates if multiple changes map to same note somehow
                if (!relatedNotes.some(n => n.note_id === note.id)) {
                    relatedNotes.push({
                        note_id: note.id,
                        file: note.target_file,
                        title: note.title,
                        content: note.content
                    });
                }
            }
        }

        let suggestedStartingPoint: SuggestedStartingPoint | undefined;
        if (changedFiles.length > 0) {
            // Simple heuristic: Most recent change or first one
            const mostRecent = changedFiles.find(c => c.commits && c.commits.length > 0) || changedFiles[0];
            suggestedStartingPoint = {
                file: mostRecent.file,
                reason: mostRecent.commits && mostRecent.commits.length > 0 ? 
                    `Based on recent commit: ${mostRecent.commits[0]}` : 
                    `This file was modified recently.`
            };
        } else if (relatedNotes.length > 0) {
             suggestedStartingPoint = {
                 file: relatedNotes[0].file,
                 reason: `You left a developer note: ${relatedNotes[0].title}`
             };
        }

        this.setLastSessionTime(now);

        return {
            since: lastSession,
            generated_at: now,
            changed_files: changedFiles,
            affected_modules: Array.from(affectedModules.values()),
            stale_annotations: staleAnnotations,
            related_notes: relatedNotes,
            suggested_starting_point: suggestedStartingPoint,
            data_sources: dataSources,
            warnings
        };
    }
}
