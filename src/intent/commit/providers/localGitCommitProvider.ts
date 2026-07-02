import { exec } from 'child_process';
import { promisify } from 'util';
import { CommitProvider } from './commitProvider';
import { CommitEntity, CommitFileChange, ChangeType } from '../commitTypes';

const execAsync = promisify(exec);

export class LocalGitCommitProvider implements CommitProvider {
    
    constructor(private cwd: string) {}

    public async verifyCheckpointExists(sha: string): Promise<boolean> {
        try {
            await execAsync(`git cat-file -e ${sha}`, { cwd: this.cwd });
            return true;
        } catch {
            return false;
        }
    }

    public async listCommits(sinceSha?: string): Promise<CommitEntity[]> {
        const range = sinceSha ? `${sinceSha}..HEAD` : 'HEAD';
        
        // We use a strict format separator [COMMIT] and [ENDCOMMIT] to safely parse multiline commit messages.
        // We also use --numstat and --name-status to get changes and renames.
        const formatString = `[COMMIT]%n%H%n%an%n%ae%n%ad%n%P%n%B%n[ENDCOMMIT]`;
        
        try {
            const { stdout } = await execAsync(`git log ${range} --pretty=format:"${formatString}" --name-status --numstat`, {
                cwd: this.cwd,
                maxBuffer: 1024 * 1024 * 50 // 50MB buffer to handle 100k commits in memory string
            });

            if (!stdout.trim()) {
                return [];
            }

            return this.parseGitLogOutput(stdout);
        } catch (err: any) {
            if (err.message.includes('bad revision')) {
                return [];
            }
            throw err;
        }
    }

    private parseGitLogOutput(output: string): CommitEntity[] {
        const commits: CommitEntity[] = [];
        
        const chunks = output.split('[COMMIT]\n');
        
        for (const chunk of chunks) {
            if (!chunk.trim()) continue;

            const endCommitIdx = chunk.indexOf('[ENDCOMMIT]');
            if (endCommitIdx === -1) continue;

            const headerAndBody = chunk.substring(0, endCommitIdx).trim();
            const statsBlock = chunk.substring(endCommitIdx + '[ENDCOMMIT]'.length).trim();

            const lines = headerAndBody.split('\n');
            if (lines.length < 5) continue;

            const sha = lines[0];
            const authorName = lines[1];
            const authorEmail = lines[2];
            const timestamp = new Date(lines[3]);
            const parentShas = lines[4] ? lines[4].split(' ') : [];
            const message = lines.slice(5).join('\n');

            const files = this.parseFileStats(statsBlock, sha);

            commits.push({
                sha,
                authorName,
                authorEmail,
                message,
                timestamp,
                parentShas,
                repositoryId: 'local',
                files
            });
        }

        // Git log outputs newest first. We reverse to process oldest to newest 
        // to safely advance the checkpoint SHA iteratively in the engine.
        return commits.reverse();
    }

    private parseFileStats(statsBlock: string, sha: string): CommitFileChange[] {
        if (!statsBlock) return [];

        const fileMap = new Map<string, CommitFileChange>();
        const lines = statsBlock.split('\n');

        // --name-status and --numstat lines appear sequentially or interleaved depending on git version.
        // We handle both:
        // Numstat: "10    5   src/file.ts"
        // NameStatus: "M   src/file.ts" or "R100  old.ts  new.ts"

        for (const line of lines) {
            const parts = line.split(/\s+/).filter(Boolean);
            if (parts.length === 0) continue;

            // Is it a numstat line? (digits, '-', and path)
            if (/^[\d-]+$/.test(parts[0]) && /^[\d-]+$/.test(parts[1]) && parts.length >= 3) {
                // If it's a rename in numstat, the path looks like "old.ts => new.ts" or "{src => dist}/file.ts"
                // This is notoriously hard to parse. We rely on name-status for the exact paths instead.
                // We just match the tail end of the path if possible, or skip addition matching if it's complex.
                // Actually, Git prints --name-status first, then --numstat later, or vice versa.
                
                // For simplicity in V1 parser, we just do a loose match or rely entirely on name-status for paths.
                const pathRaw = parts.slice(2).join(' '); 
                let cleanPath = pathRaw;
                // crude un-bracket for numstat renames e.g. a/{b => c}/d.ts -> a/c/d.ts
                if (cleanPath.includes('=>')) {
                    // Just take the right side of the rename for mapping
                    const match = cleanPath.match(/(.*)\{.*=>\s*(.*)\}(.*)/);
                    if (match) {
                        cleanPath = (match[1] + match[2] + match[3]).replace(/\/\//g, '/');
                    } else {
                        // "old.ts => new.ts"
                        const arrowSplit = cleanPath.split('=>');
                        cleanPath = arrowSplit[arrowSplit.length-1].trim();
                    }
                }

                const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
                const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);

                if (fileMap.has(cleanPath)) {
                    const fc = fileMap.get(cleanPath)!;
                    fc.additions = additions;
                    fc.deletions = deletions;
                    fc.changes = additions + deletions;
                } else {
                    // Might not have seen the name-status yet
                    fileMap.set(cleanPath, {
                        sha,
                        path: cleanPath,
                        additions,
                        deletions,
                        changes: additions + deletions,
                        changeType: "U"
                    });
                }
            } else {
                // It's a name-status line
                const statusFlag = parts[0][0]; // 'A', 'M', 'D', 'R', 'C'
                
                if (statusFlag === 'R' || statusFlag === 'C') {
                    // "R100 oldPath newPath"
                    const oldPath = parts[1];
                    const newPath = parts[2];
                    
                    if (fileMap.has(newPath)) {
                        const fc = fileMap.get(newPath)!;
                        fc.oldPath = oldPath;
                        fc.changeType = statusFlag as ChangeType;
                    } else {
                        fileMap.set(newPath, {
                            sha,
                            path: newPath,
                            oldPath: oldPath,
                            additions: 0,
                            deletions: 0,
                            changes: 0,
                            changeType: statusFlag as ChangeType
                        });
                    }
                } else {
                    const path = parts[1];
                    if (fileMap.has(path)) {
                        const fc = fileMap.get(path)!;
                        fc.changeType = statusFlag as ChangeType;
                    } else {
                        fileMap.set(path, {
                            sha,
                            path,
                            additions: 0,
                            deletions: 0,
                            changes: 0,
                            changeType: statusFlag as ChangeType
                        });
                    }
                }
            }
        }

        return Array.from(fileMap.values());
    }
}
