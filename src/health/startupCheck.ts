import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getProfile } from '../config/performanceConfig';
import { Logger } from '../context/repositoryContext';

/**
 * Performs startup health checks:
 * 1. Ollama connectivity
 * 2. Required models (embedding + inference)
 * 3. GPU VRAM availability (optional, silent on CPU-only)
 */
export async function startupCheck(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
    const config = vscode.workspace.getConfiguration('repoguide');
    const ollamaUrl = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    
    const profile = getProfile();
    const embeddingModel = profile.embeddingModel;
    const inferenceModel = profile.inferenceModel;

    // -- 1. Ollama connectivity --
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(ollamaUrl, {
            signal: controller.signal as RequestInit["signal"]
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            vscode.window.showInformationMessage('RepoGuide: Ollama is running.');

            // -- 2. Model availability --
            try {
                const tagsRes = await fetch(`${ollamaUrl}/api/tags`);
                const tagsData = (await tagsRes.json()) as { models: Array<{name: string}> };
                const modelNames = tagsData.models.map(m => m.name);

                let okEmbed = false;
                let okInfer = false;
                for (const name of modelNames) {
                    if (name.includes(embeddingModel)) {
                        okEmbed = true;
                    }
                    if (name.includes(inferenceModel)) {
                        okInfer = true;
                    }
                }

                if (!okEmbed) {
                    vscode.window.showWarningMessage(
                        `RepoGuide: Embedding model "${embeddingModel}" not found. Run: ollama pull ${embeddingModel}`,
                        'Copy Command'
                    ).then(action => {
                        if (action === 'Copy Command') {
                            vscode.env.clipboard.writeText(`ollama pull ${embeddingModel}`);
                        }
                    });
                }
                if (!okInfer) {
                    vscode.window.showWarningMessage(
                        `RepoGuide: Inference model "${inferenceModel}" not found. Run: ollama pull ${inferenceModel}`,
                        'Copy Command'
                    ).then(action => {
                        if (action === 'Copy Command') {
                            vscode.env.clipboard.writeText(`ollama pull ${inferenceModel}`);
                        }
                    });
                }
            } catch (e) {
                logger.warn(`Failed to query Ollama model tags: ${e}`);
            }

        } else {
            vscode.window.showWarningMessage(
                'RepoGuide: Ollama responded but may not be healthy. Start it with: ollama serve'
            );
        }
    } catch (error) {
        vscode.window.showWarningMessage(
            'RepoGuide: Cannot connect to Ollama. Make sure it is running: ollama serve',
            'Copy Command'
        ).then(action => {
            if (action === 'Copy Command') {
                vscode.env.clipboard.writeText('ollama serve');
            }
        });
    }

    // -- 3. VRAM check (best-effort, silent on CPU-only / macOS) --
    cp.exec('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits', (err, stdout) => {
        if (!err && stdout) {
            try {
                const freeMB = parseInt(stdout.trim().split('\n')[0], 10);
                if (!isNaN(freeMB) && freeMB < 5000) {
                    vscode.window.showWarningMessage(
                        `RepoGuide: Low GPU memory detected (${freeMB} MB free). Close other GPU-heavy apps for best performance.`
                    );
                }
            } catch (e) {
                // Silently ignore parse errors
            }
        }
        // If nvidia-smi is not available, we silently skip
    });
}
