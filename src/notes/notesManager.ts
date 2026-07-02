import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileAnnotation } from '../comprehension/fileAnnotationEngine';
import { CommunitySummary } from '../comprehension/communityClustering';
import { CodeChunk } from '../store/storeTypes';

export interface DeveloperNote {
    id: string;
    target_file: string;
    target_symbol?: string;
    line_start?: number;
    line_end?: number;
    title: string;
    content: string;
    tags: string[];
    source: 'manual' | 'chat';
    confidence: 'user_confirmed' | 'suggested';
    created_at: string;
    updated_at: string;
    code_hash_at_creation?: string;
}

export interface NotesStore {
    notes: DeveloperNote[];
}

export class NotesManager {
    private notesPath: string;

    constructor(private repoguideDir: string, private workspaceRoot: string) {
        this.notesPath = path.join(this.repoguideDir, 'notes.json');
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/').toLowerCase();
    }

    private getFullFilePath(relPath: string): string {
        return path.isAbsolute(relPath) ? relPath : path.join(this.workspaceRoot, relPath);
    }

    public async loadNotes(): Promise<DeveloperNote[]> {
        if (!fs.existsSync(this.notesPath)) {
            return [];
        }
        try {
            const raw = await fs.promises.readFile(this.notesPath, 'utf8');
            const data = JSON.parse(raw) as NotesStore;
            return data.notes || [];
        } catch (e) {
            console.error(`Failed to load notes: ${e}`);
            return [];
        }
    }

    private async saveNotesInternal(notes: DeveloperNote[]): Promise<void> {
        const data: NotesStore = { notes };
        const dir = path.dirname(this.notesPath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        await fs.promises.writeFile(this.notesPath, JSON.stringify(data, null, 2), 'utf8');
    }

    public async saveNote(note: DeveloperNote): Promise<void> {
        const notes = await this.loadNotes();
        const existingIdx = notes.findIndex(n => n.id === note.id);
        if (existingIdx !== -1) {
            notes[existingIdx] = note;
        } else {
            notes.push(note);
        }
        await this.saveNotesInternal(notes);
    }

    public async deleteNote(id: string): Promise<void> {
        const notes = await this.loadNotes();
        const filtered = notes.filter(n => n.id !== id);
        if (filtered.length !== notes.length) {
            await this.saveNotesInternal(filtered);
        }
    }

    public async updateNote(id: string, updates: Partial<DeveloperNote>): Promise<void> {
        const notes = await this.loadNotes();
        const existingIdx = notes.findIndex(n => n.id === id);
        if (existingIdx !== -1) {
            notes[existingIdx] = { ...notes[existingIdx], ...updates, updated_at: new Date().toISOString() };
            await this.saveNotesInternal(notes);
        }
    }

    public async findNotesForFile(filePath: string): Promise<DeveloperNote[]> {
        const notes = await this.loadNotes();
        const normalizedRequest = this.normalizePath(path.relative(this.workspaceRoot, this.getFullFilePath(filePath)));
        
        return notes.filter(n => {
            const normalizedTarget = this.normalizePath(n.target_file);
            return normalizedTarget === normalizedRequest || 
                   normalizedTarget.endsWith('/' + normalizedRequest) ||
                   normalizedRequest.endsWith('/' + normalizedTarget);
        });
    }

    public async findNotesForRetrievedContext(
        chunks: CodeChunk[],
        annotations: FileAnnotation[],
        communities: CommunitySummary[]
    ): Promise<DeveloperNote[]> {
        const notes = await this.loadNotes();
        if (notes.length === 0) return [];

        const uniqueFiles = new Set<string>();
        for (const c of chunks) {
            uniqueFiles.add(this.normalizePath(path.relative(this.workspaceRoot, this.getFullFilePath(c.filePath))));
        }
        for (const a of annotations) {
            uniqueFiles.add(this.normalizePath(path.relative(this.workspaceRoot, this.getFullFilePath(a.file))));
        }
        for (const comm of communities) {
            for (const f of comm.files) {
                uniqueFiles.add(this.normalizePath(path.relative(this.workspaceRoot, this.getFullFilePath(f))));
            }
        }

        const matchedNotes = notes.filter(n => {
            const target = this.normalizePath(n.target_file);
            for (const f of uniqueFiles) {
                if (target === f || target.endsWith('/' + f) || f.endsWith('/' + target)) {
                    return true;
                }
            }
            return false;
        });

        return matchedNotes;
    }

    public async isNoteStale(note: DeveloperNote): Promise<boolean> {
        if (!note.code_hash_at_creation) {
            return false; // Unknown if stale, assume not stale for now
        }
        try {
            const fullPath = this.getFullFilePath(note.target_file);
            if (!fs.existsSync(fullPath)) {
                return true; // File deleted
            }
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const currentHash = crypto.createHash('sha256').update(content).digest('hex');
            return currentHash !== note.code_hash_at_creation;
        } catch (e) {
            return true; // Assume stale if we can't read the file
        }
    }

    public async hashFile(filePath: string): Promise<string> {
        const fullPath = this.getFullFilePath(filePath);
        if (!fs.existsSync(fullPath)) {
            return '';
        }
        try {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch {
            return '';
        }
    }
}
