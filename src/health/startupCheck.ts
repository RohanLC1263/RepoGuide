import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getProfile } from '../config/performanceConfig';
import { Logger } from '../context/repositoryContext';
import { resolveOllamaUrlDetailed, vscodeConfigReader } from './ollamaUrlSafety';

/**
 * Performs startup health checks:
 * 1. Ollama connectivity
 * 2. Required models (embedding + inference)
 * 3. GPU VRAM availability (optional, silent on CPU-only)
 * 4. Non-local repoguide.ollamaUrl warning (once per activation -- this
 *    function itself only runs once per extension activation/VS Code
 *    session, so no separate "already shown" state is needed).
 */
export async function startupCheck(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
    const config = vscode.workspace.getConfiguration('repoguide');
    // Resolved, not raw: the warning must describe the endpoint that will ACTUALLY be
    // contacted. Warning about a raw value the resolver then refuses to use would train
    // users to ignore it, and staying silent when a remote URL is blocked would hide a
    // setting quietly not taking effect.
    const resolution = resolveOllamaUrlDetailed(vscodeConfigReader(config));
    const ollamaUrl = resolution.url;

    const profile = getProfile();
    const embeddingModel = profile.embeddingModel;
    const inferenceModel = profile.inferenceModel;

    // -- 0. Non-local ollamaUrl warning (checked independent of live
    // connectivity below -- the risk is about where data WILL go once
    // indexing/queries run, not whether the endpoint happens to be up now) --
    if (resolution.outcome === 'remote-allowed') {
        vscode.window.showWarningMessage(
            `RepoGuide: repoguide.ollamaUrl is set to a non-local endpoint (${ollamaUrl}) and repoguide.allowRemoteOllama is on. Indexed repository content -- including file text, code chunks, and structural data such as .env key names -- will be sent to this endpoint for embedding and inference. Only point this at an endpoint you trust.`
        );
    } else if (resolution.outcome === 'remote-blocked') {
        // Not a silent fallback: the user asked for something that did not happen.
        vscode.window.showWarningMessage(
            `RepoGuide: repoguide.ollamaUrl points at a non-local endpoint (${resolution.requested}), which was IGNORED -- RepoGuide is using ${ollamaUrl} instead and nothing was sent off this machine. Set repoguide.allowRemoteOllama to true in User settings if you genuinely intend to use a remote Ollama.`
        );
    }

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
