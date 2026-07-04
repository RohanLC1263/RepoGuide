# RepoGuide

**Privacy-first local code understanding for VS Code.**

RepoGuide indexes your codebase locally using [Ollama](https://ollama.com) and gives you AI-powered code explanations, repo-aware chat, and auto-generated documentation -- all without sending a single line of code to the cloud.

---

## Features

### Right-click Explain
Select any code block, right-click, and choose **"Explain this code"**. RepoGuide streams a structured explanation with:
- **EXPLANATION** -- what the code does
- **SUGGESTIONS** -- how it could be improved
- **RED FLAGS** -- potential issues

### Repo-aware Sidebar Chat
Ask natural language questions about your codebase in the sidebar panel. RepoGuide:
- Embeds your question using `nomic-embed-text`
- Retrieves the most relevant code chunks from LanceDB
- Uses `qwen2.5-coder:7b` to answer with full context
- Highlights referenced file locations in the editor
- Supports follow-up questions with rolling conversation history (last 6 exchanges)

### Documentation Report
Generate a structured project overview from the command palette:
- **PROJECT OVERVIEW** -- what the project does
- **TECH STACK** -- languages, frameworks, libraries
- **ARCHITECTURE** -- high-level design
- **MODULES** -- one paragraph per folder
- **ENTRY POINTS** -- main files and startup paths
- **KEY FILES** -- important files to understand

The report streams live into a styled panel with a copy-to-clipboard button.

### Incremental Sync
RepoGuide keeps the index up-to-date automatically:
- **Save watcher** -- re-indexes changed chunks on save (500ms debounce)
- **File system watcher** -- handles creates, deletes, and renames
- **Git watcher** -- detects branch switches and reconciles the index using file-level hashes
- **Manual re-sync** -- use "Re-sync Index" from the sidebar or command palette

### Configurable
All model names, token budgets, and exclude patterns are configurable via VS Code settings.

---

## Prerequisites

| Requirement | Version |
|---|---|
| VS Code | 1.85 or later |
| Ollama | Latest (https://ollama.com/download) |
| Node.js | 18+ (for development only) |

### Required Ollama Models

After installing Ollama, pull these two models:

```bash
# Embedding model (fast, ~275MB)
ollama pull nomic-embed-text

# Inference model (7B Q4_K_M, ~4.4GB)
ollama pull qwen2.5-coder:7b
```

Make sure Ollama is running before launching VS Code:

```bash
ollama serve
```

**GPU recommended:** RepoGuide works best with 5GB or more free VRAM. It will show a warning if GPU memory is low. CPU-only inference works but will be slower.

---

## Installation

### From VSIX

1. Download the `.vsix` file from the releases page.
2. In VS Code: `Ctrl+Shift+P` then "Extensions: Install from VSIX..."
3. Select the downloaded file.
4. Reload VS Code.

### From Source

> **Note:** this project has not yet been published to a public repository or
> the VS Code Marketplace -- `package.json`'s `repository.url` and `publisher`
> fields are still placeholders. Replace the URL below with the real one once
> it's published.

```bash
git clone https://github.com/your-org/repoguide.git
cd repoguide
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

---

## Usage

### First Launch
1. Open a workspace in VS Code.
2. RepoGuide automatically checks that Ollama is running and the required models are available.
3. On first launch, it indexes your codebase (status bar shows "Indexing...").
4. Once indexing completes, the status bar shows "Ready (N chunks)".

### Explain Code
1. Select a block of code in the editor.
2. Right-click then choose "Explain this code".
3. A panel opens with a streaming explanation.

### Chat
1. Click the RepoGuide icon in the activity bar to open the sidebar.
2. Type a question like "How does the authentication middleware work?"
3. RepoGuide retrieves relevant code context and streams an answer.

### Documentation Report
1. `Ctrl+Shift+P` then "RepoGuide: Generate Documentation Report"
2. A styled panel opens with a live-streaming project overview.
3. Click "Copy to Clipboard" to copy the report.

### Re-sync Index
- Click "Re-sync Index" in the sidebar, or
- `Ctrl+Shift+P` then "RepoGuide: Re-sync Index"

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `repoguide.inferenceModel` | `qwen2.5-coder:7b` | Ollama model for inference |
| `repoguide.embeddingModel` | `nomic-embed-text` | Ollama model for embeddings |
| `repoguide.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `repoguide.tokenBudget` | `6000` | Max tokens of code context per query |
| `repoguide.excludePatterns` | common generated/dependency folders | Folders excluded from indexing, including `node_modules`, `.venv`, `venv`, `dist`, `build`, `.git`, `.repoguide`, `local_models`, `artifacts`, and `logs` |
| `repoguide.idleUnloadTimeout` | `300` | Seconds before suggesting model unload (0 = never) |

Access via: `Ctrl+,` then search "RepoGuide"

---

## Architecture

```
src/
  extension.ts          Entry point, wires everything together
  health/               Startup checks (Ollama, models, VRAM)
  indexing/             File walking, AST chunking, index management
  ollama/               Embedding and inference API clients
  prompts/              Prompt builders (explain, chat, doc report)
  query/                Query pipeline, token budget, conversation history
  store/                LanceDB storage layer
  ui/                   Webview panels, status bar, decorations
  watchers/             Save, filesystem, and git watchers
```

**Data flow:**
1. **Indexing:** Files -> Tree-sitter AST -> Chunks -> nomic-embed-text -> LanceDB
2. **Query:** Question -> nomic-embed-text -> LanceDB search -> Top chunks -> qwen2.5-coder:7b -> Streamed answer

---

## Privacy

RepoGuide is 100% local:
- All embedding and inference runs on your machine via Ollama
- No code is sent to any external server
- The vector index is stored in `.repoguide/` inside your workspace
- Add `.repoguide/` to your `.gitignore`

---

## Known Limitations

- **First index** can take several minutes on large codebases (depends on Ollama speed)
- Make sure dependency/model folders such as `.venv`, `node_modules`, `local_models`, and `artifacts` are excluded before first indexing.
- **GPU memory**: 7B model requires approximately 5GB VRAM for comfortable use
- **Supported languages for indexing**: TypeScript, JavaScript, Python, Java, Go, Rust, C/C++, Kotlin, C#, Ruby, PHP, Swift, and Markdown. This is a hard extension allowlist -- files with any other extension are **not indexed at all** (there is no fallback text chunker for unlisted extensions; this also means common secret-bearing files like `.env` or `.pem` are never picked up, since they don't match the allowlist). Within that allowlist, TypeScript/JavaScript/Python/Java/Go/Rust/C++/C#/Kotlin get real tree-sitter AST-based chunking; Ruby, PHP, and Swift currently have no tree-sitter grammar wired in and fall back to fixed-window plain-text chunking for those files specifically.
- **Semantic/fact-extraction depth varies by language, and is not yet used in answers.** Beyond basic chunking, RepoGuide has a deeper fact-extraction layer for TypeScript, Python, Java, C#, Go, Rust, and C++ that understands classes, methods, calls, and imports structurally. It currently runs in "shadow mode" -- computed for every indexed file, but not yet used to shape chat/explain answers -- and each language has different, disclosed accuracy tiers (e.g. some languages resolve cross-file relationships, others are same-file-only; interface/trait implementation detection is not attempted for every language). See `REPOGUIDE_AUDIT.md` and the per-language `*_SEMANTIC_PROVIDER_REPORT.md` files in this repo for the honest tier-by-tier breakdown.
- **Single workspace**: Currently indexes the first workspace folder only
- Tree-sitter parsing may skip some edge-case syntax for allowlisted languages; malformed/partial files may index with reduced structural detail.

---

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build TypeScript
npm run watch        # Watch mode
npm run lint         # Run ESLint
npm run test:unit    # Run pure unit tests (no Extension Host needed)
npm test             # Run full VS Code extension tests
```

### Mini Evaluation Harness

RepoGuide includes a small baseline evaluator for project-understanding quality.
It runs golden questions through the same query pipeline used by the chat UI and
writes scored reports under `<repo>/.repoguide/eval/`.

```bash
npm run eval:mini -- --repo test/fixtures/mixed-fullstack --questions test/evaluation/mixed-fullstack.golden.json
```

Useful options:

```bash
--prepare       Rebuild the RepoGuide index and comprehension artifacts first
--threshold 0.8 Set the pass threshold, from 0 to 1
--output <dir>  Override the report output directory
```

The starter golden set covers orientation, location, flow, explanation, and
uncertainty questions. Reports include per-question answers, location accuracy,
grounding, uncertainty honesty, flow scores, aggregate scores by question type,
and comparison against the previous run.

### Investigation Engine Smoke Test

Phase 8 includes a backend Investigation Engine for multi-path code investigations. It retrieves direct evidence, entrypoints, execution flow, and failure-mode context, then asks the local model for a detective-style hypothesis report.

```bash
npm run phase8:smoke
```

Use `--repo <path>` and `--question "..."` to run it against another repository that already has `.repoguide` artifacts.

To package:
```bash
npx @vscode/vsce package
```

Note: this extension ships without a bundler (no esbuild/webpack step), so its
real npm dependencies -- including native modules like `better-sqlite3` and
the `tree-sitter-*` grammars -- must be present in the packaged `.vsix`.
**Do not add `--no-dependencies`**: that flag skips packaging `node_modules`
entirely and produces a `.vsix` that fails to activate on install.

---

## License

MIT
