# RepoGuide

**Privacy-first, local, evidence-verified code understanding for VS Code.**

RepoGuide indexes your codebase locally using [Ollama](https://ollama.com) and answers questions about it with citations back to real files and lines -- and it checks its own answers against your actual source before showing them to you, refusing or flagging anything it can't verify. No code leaves your machine.

This is a demo-stage project: not published to the VS Code Marketplace, still under active development. See **[What This Doesn't Do Yet](#what-this-doesnt-do-yet)** before you judge it against a production tool.

## Engineering Notes

RepoGuide's answer-synthesis pipeline runs on a local 7B model. During development, controlled testing across multiple real codebases surfaced a precise, reproducible failure mode: the model correctly quotes a conditional or branch statement, then inverts it when applying that condition to a specific case -- for example, citing `if confidence < threshold: retry` accurately, then narrating the outcome backwards. This wasn't a one-off; it was confirmed across independent files in separate projects.

Two independent mitigation attempts were designed, built, and validated against real production data -- a self-verification checker, and later a cross-model verification pipeline using a different-lineage model. Both looked promising in early testing: the second passed 4/4 on the adversarial cases that motivated it. Both were tested again against a broader, representative sample of real queries, and both times the broader validation reversed the result -- the checking mechanisms introduced more false alarms than they resolved real errors, or shared blind spots with the model they were meant to check. Neither was shipped. The finding, the validation data, and the decision not to ship are documented in the repo rather than hidden.

The same discipline shaped the MCP integration with Claude Desktop: every reported fix was checked by making live tool calls against a real, running MCP server, not just by passing unit tests. That process caught a stale config file pointing at the wrong repository for over a month, a stale server process silently serving pre-fix output, and -- most instructively -- a fix that passed its own live verification harness but regressed when tested against the actual production pipeline, because the verification harness itself diverged from real system behavior in a way that mattered. That gap was caught before anything shipped, not after.

The result is a system that states what it can and can't be trusted for, instead of presenting everything with equal confidence. The dependency graph and fact-extraction tools are deterministic and exhaustive within their scope. The synthesized-answer tool carries a disclosed, tested limitation -- visible in its own tool description -- rather than a silent one.

---

## What RepoGuide Actually Does

### Grounded Q&A, not just retrieval
Ask a question in the sidebar chat and RepoGuide retrieves relevant code (via a hybrid of keyword search, vector search, a program dependency graph, and structurally-extracted facts), then generates an answer -- but the answer doesn't go straight to you. It passes through **AnswerGate**, a verification step that:
- Re-reads the actual file content of every citation and fenced code block, fresh from disk, and blocks the answer if a quoted excerpt doesn't really appear there (catches invented code dressed up as a real quote, and code from one file misattributed to another).
- Cross-checks numeric claims about a named constant/attribute (`"the timeout is 30 seconds"`) against the value the code actually assigns, and blocks the answer if they disagree (catches stale docstrings/comments being treated as the live value).
- When it can't verify a claim, it says so explicitly ("evidence does not determine...") instead of guessing.

This is the actual mechanism, not marketing language -- it was built, broken, and re-tightened repeatedly against real false-positive and false-negative cases found by running it against a real production codebase (see `CHANGELOG.md`/`ROADMAP.md` for the specific bugs found and fixed, with real before/after numbers).

### 7 languages with real structural understanding
TypeScript, JavaScript, Python, Java, Go, Rust, C++, and C# get real tree-sitter AST parsing and structural fact extraction (assignments, calls, imports, fallback/try-except chains, environment variable reads) -- this is what AnswerGate's numeric/quote checks verify against. Kotlin also parses via the Java grammar. Ruby, PHP, and Swift are indexed as plain text (no AST, no structural facts) since no tree-sitter grammar is wired in for them yet.

### Explain, document, and stay in sync
- **Explain this code** (right-click a selection): a structured explanation, also evidence-checked.
- **Generate Documentation Report**: a project overview (tech stack, architecture, modules, entry points) streamed into a panel.
- **Automatic re-indexing** on save, file create/delete/rename, and git branch switches, plus a manual "Re-sync Index" command.
- 20 total commands are registered (investigation tooling, memory/notes panels, impact analysis, etc.) -- the sidebar chat, Explain, and Documentation Report are the three you'll actually want for a demo; the rest are reachable via the command palette but are not yet consolidated into one obvious entry point (a known, tracked gap -- see `ROADMAP.md`).

---

## What This Doesn't Do Yet

**Not published.** No VS Code Marketplace listing. `package.json`'s `repository.url` and `publisher` fields are still placeholders. Install from a locally-built `.vsix` or via F5 debug launch only.

**Retrieval and reasoning precision is still improving on hard, multi-file questions.** The most recent real-world evaluation (15 detailed, code-exact questions against a real ~400-file production codebase, each requiring tracing specific control flow or citing an exact value/string) scored **10/15 (66.7%)**, up from 4/14 the same day after fixing two real over-blocking bugs in AnswerGate. The gate is honest about what it can't verify (abstains rather than guesses) more often than it should have to -- the two fixed bugs, and two more found and deliberately left open for now, are documented with exact before/after numbers in `CHANGELOG.md`. Known remaining weak spots:
- Boolean-logic/causal explanations ("why does X happen") are less reliable than "what happens" narration -- the model has correctly quoted the exact real code that answers a question and then verbally drawn the wrong conclusion from it, in a way AnswerGate's citation-verification can't catch (the quote is real; the reasoning about it is wrong).
- Two real, differently-named constants declared close together in the same file, sharing a common word (e.g. `TIMEOUT_CLASSIFICATION` / `TIMEOUT_RAG`), can still cause a false "contradicts the live value" block on an otherwise-correct answer. Disclosed and tracked, not yet fixed.

**RepositoryBrain is wired but empty.** RepoGuide has a long-term memory subsystem (`RepositoryBrain`) intended to accumulate knowledge across sessions -- git history, decisions, incidents -- and it's a real, registered provider in the live retrieval path today. But the ingestion pipelines that would populate it haven't been connected yet, so on a real test workspace it currently holds zero rows. Retrieval quietly gets nothing from it; nothing is broken, there's just no compounding memory yet.

**Not exhaustively tested outside two real dogfood codebases.** The evaluation numbers above come from one real production repository plus a handful of held-out open-source corpora per language (see `*_SEMANTIC_PROVIDER_REPORT.md` files). It has not been run against a wide variety of codebases or languages in combination.

---

## Prerequisites

| Requirement | Version |
|---|---|
| VS Code | 1.115 or later |
| Ollama | Latest (https://ollama.com/download) |
| Node.js | 18+ (for development only) |

### Required Ollama Models

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

### From a locally-built VSIX

There is no published release yet, so build it yourself:

```bash
git clone <this repo's real URL -- package.json's is still a placeholder>
cd repoguide
npm install
npm run compile
npx @vscode/vsce package
```

Then in VS Code: `Ctrl+Shift+P` -> "Extensions: Install from VSIX..." -> select the generated `.vsix`.

### From Source (development / F5 launch)

```bash
git clone <this repo's real URL -- package.json's is still a placeholder>
cd repoguide
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

**Known friction on a fresh install:** `npm install` runs a `postinstall` step that tries to rebuild native modules (`better-sqlite3`, the tree-sitter grammars) for VS Code's Electron runtime, and this can fail outright on some toolchains with a C++ standard-version error (`better-sqlite3` in particular is a leftover, unused dependency -- the code has since moved to Node's built-in `node:sqlite` -- so this specific failure is currently harmless to ignore). If `npm install` exits with an error:
1. Confirm `node_modules` was still populated (`ls node_modules | wc -l` should show 500+) -- it almost certainly was; only the native-rebuild step failed.
2. Run `npm run compile` directly -- it doesn't depend on the native rebuild and should succeed regardless.
3. If a CLI script fails with `Cannot find module 'better-sqlite3'`, run `npm install better-sqlite3 --no-save` to fix it standalone (this module isn't imported anywhere in `src/` today, so this is very unlikely to matter for actual extension use).

This has not yet been cleaned up at the repo level (the dead `better-sqlite3` dependency and its rebuild scripts should probably just be removed) -- tracked in `ROADMAP.md`.

---

## Usage

### First Launch
1. Open a workspace in VS Code.
2. RepoGuide checks that Ollama is running and the required models are available.
3. On first launch, it indexes your codebase (status bar shows "Indexing...").
4. Once indexing completes, the status bar shows "Ready (N chunks)".

### Chat
1. Click the RepoGuide icon in the activity bar to open the sidebar.
2. Ask a question like "How does the authentication middleware work?"
3. RepoGuide retrieves relevant, real evidence and streams a citation-checked answer -- or an explicit "evidence does not determine" if it can't verify one.

### Explain Code
1. Select a block of code, right-click, choose "Explain this code."
2. A panel opens with a streaming, evidence-checked explanation.

### Documentation Report
`Ctrl+Shift+P` -> "RepoGuide: Generate Documentation Report" -> a styled panel streams a project overview with a copy-to-clipboard button.

### Re-sync Index
Sidebar "Re-sync Index" button, or `Ctrl+Shift+P` -> "RepoGuide: Re-sync Index".

---

## MCP Server (for coding agents)

RepoGuide can also run as a standalone [MCP](https://modelcontextprotocol.io) server, so an
agent like Claude Code can consult your codebase's index directly while it works -- separate
from the VS Code extension, and useful even without VS Code open. It's a **stdio-transport**
server: it doesn't listen on a port or run as a standalone daemon, it's spawned *by* the MCP
client (Claude Code, Claude Desktop) as a child process each time that client needs it. The
extension does not start, stop, or track this process -- there is no "server running" state
for it to show you.

### Connecting a client

The workspace must already have a RepoGuide index (run indexing once from the VS Code
extension first) -- the server refuses to start against an unindexed workspace.

The easiest way to connect a client: in VS Code, run `Ctrl+Shift+P` -> "RepoGuide: Copy MCP
Config for Claude Code / Claude Desktop", pick a format (Claude Code project `.mcp.json`,
`claude mcp add` CLI command, or Claude Desktop's `claude_desktop_config.json` shape), and
paste the copied, already-filled-in config into place. It requires `node` on your `PATH`.

To construct it by hand instead, point the client's `command`/`args` at:

```
node out/mcp/mcpServer.js --workspaceRoot /path/to/your/project --repoguideDir /path/to/your/project/.repoguide
```

Both `--workspaceRoot` and `--repoguideDir` are required.

`npm run mcp -- --workspaceRoot ... --repoguideDir ...` runs the same script directly in a
terminal -- **useful only as a smoke test** (confirming the workspace's index loads and the
server starts without error). Run this way, its stdio is connected to your terminal, not to
any MCP client, so no client can actually reach it; it is not itself a way to "start the MCP
server" for a client to use.

**Important:** the MCP server loads every index store into memory once at startup and has no
live reindex path -- it does not watch the filesystem, and it does not know about edits made
during the session, even edits the connected agent itself makes. After any reindex (including
one triggered from the VS Code extension while the MCP server happens to be running), **the
MCP server must be restarted** to see the new index; there is no way to refresh it in place.

### Tools

| Tool | What it returns | Best for |
|---|---|---|
| `ask_repoguide` | A synthesized natural-language answer with citations and a `gateStatus` verification outcome (`pass`/`revise`/`block`) | Orientation questions ("where does X live," "what module owns Y"). Answers are generated by a local 7B model and are **not reliable for conditional/branch-logic behavior** ("under what condition does X happen") -- see `LIMITATIONS.md` §1.1/§1.3. `gateStatus` catches unsupported quotes/numbers/paths, not reasoning errors. |
| `retrieve_raw_evidence` | Raw, line-addressed code chunks/facts/community summaries -- no synthesis | Locating relevant code before making a change. Always `Read` the actual file afterward -- evidence content is index-time text and can lag the real file. |
| `get_dependents` | Every caller/reader/importer/instantiator/fallback-consumer of a symbol or file, each with its own file/symbol/line | Impact analysis before modifying any exported/shared symbol -- "what could break if I change this." |
| `get_facts` | AST-derived structured facts (numeric thresholds, call sites, guard clauses) | Looking up a specific configured value or constant with its real source location. |
| `get_last_chat_evidence` | The last up-to-10 chat/`ask_repoguide` answers, newest first, each with its question, answer, and the file/line references that supported it (references only, not content) | Reusing context the user just discussed in RepoGuide chat instead of rediscovering it independently -- pull this first if the conversation suggests they were just asking RepoGuide about the area you're about to touch. |

Every tool response includes an `index_age` field (`{ lastIndexedAt, ageSeconds }`, or `null`
if the workspace has never been indexed) -- a plain mtime check on the index manifest, so a
caller can judge for itself whether results might predate recent edits.

### Workflow guidance

If you're using RepoGuide's MCP server from an agent, this block is meant to be copied into
that project's `CLAUDE.md` (or equivalent) so the tools get used correctly rather than just
being technically connectable:

```markdown
## RepoGuide MCP tools
- If the user was just discussing this with RepoGuide chat, start with
  `get_last_chat_evidence` instead of rediscovering the same context yourself.
- Before modifying any exported/shared symbol, call `get_dependents` on it and check what
  would break.
- For an aggregate "blast radius" across a change, compose the graph tools in a loop rather
  than expecting one call to return it: call `get_dependents` on your target, then
  `get_dependents` again on each returned symbol to reach second-order (transitive) impact;
  pair with `get_dependencies` (the reverse direction -- what your target itself calls/reads/
  imports) to see what you might break in the other direction. There is no single
  whole-change blast-radius tool; you assemble it from these.
- Use `retrieve_raw_evidence` to locate relevant code, then always `Read` the actual file
  before writing changes -- never generate code from evidence `content` alone.
- Use `ask_repoguide` only for orientation questions ("where does X live"). Check its
  `gateStatus.outcome`, and never trust its claims about conditional/branch behavior without
  reading the condition yourself.
- Treat all MCP results about recently-edited files as potentially stale until the workspace
  is reindexed and the MCP server is restarted -- check the response's `index_age`.
- The MCP server loads every index store once at startup and has no live-reindex path (it
  does not watch the filesystem). If the target repo changes significantly during a session,
  results stay stale until the workspace is reindexed AND the MCP client (Claude Desktop,
  etc.) is fully quit and reopened -- closing a window is not enough, since the client keeps
  the server child process alive across windows.
```

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
  health/                Startup checks (Ollama, models, VRAM)
  indexing/              File walking, AST chunking, fact extraction, index management
  mcp/                   Standalone MCP server (see "MCP Server" above)
  ollama/                Embedding and inference API clients
  prompts/               Prompt builders (chat, explain, doc report)
  query/                 Retrieval orchestration, AnswerGate, decomposition, token budgeting
  store/                 LanceDB (vectors), BM25, SQLite-backed fact/logical-unit/program-graph stores
  ui/                    Webview panels, status bar, decorations
  watchers/               Save, filesystem, and git watchers
```

**Data flow:**
1. **Indexing:** Files -> Tree-sitter AST -> Chunks + structural facts -> `nomic-embed-text` -> LanceDB / BM25 / fact store
2. **Query:** Question -> intent classification & strategy routing -> hybrid retrieval (BM25 + vector + program graph + facts) -> evidence packet -> `qwen2.5-coder:7b` generation -> **AnswerGate verification** -> streamed answer, or an explicit refusal if verification fails

---

## Privacy

RepoGuide is 100% local:
- All embedding and inference runs on your machine via Ollama
- No code is sent to any external server
- The index is stored in `.repoguide/` inside your workspace
- Add `.repoguide/` to your `.gitignore`

---

## Known Limitations

- **First index** can take several minutes on large codebases (depends on Ollama speed).
- Make sure dependency/model folders such as `.venv`, `node_modules`, `local_models`, and `artifacts` are excluded before first indexing.
- **GPU memory**: 7B model requires approximately 5GB VRAM for comfortable use.
- **Indexed file types**: TypeScript, JavaScript, Python, Java, Go, Rust, C/C++, Kotlin, C#, Ruby, PHP, Swift, Markdown, YAML, plus `Dockerfile`/`Makefile`/`.env*` by filename convention. This is a hard allowlist -- other extensions are not indexed at all. Within it, TypeScript/JavaScript/Python/Java/Go/Rust/C++/C#/Kotlin get real tree-sitter AST parsing and structural fact extraction; Ruby/PHP/Swift/YAML/Dockerfile/Makefile/`.env` fall back to fixed-window plain-text chunking (indexed and searchable, but no structural facts for AnswerGate to check numeric/assignment claims against).
- **Single workspace**: indexes the first workspace folder only.
- Tree-sitter parsing may skip some edge-case syntax; malformed/partial files may index with reduced structural detail.
- See **[What This Doesn't Do Yet](#what-this-doesnt-do-yet)** above for the larger, non-cosmetic gaps.

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

Most of the real regression coverage lives in `src/test/**/*.test.ts` files that use Node's built-in test runner directly (`node --test out/test/<file>.test.js` after compiling), not the `test:unit`/`test` scripts above, which currently only exercise a minimal Extension Host smoke test. See `CLAUDE.md` for this repo's testing conventions.

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

### Packaging

```bash
npx @vscode/vsce package
```

Note: this extension ships without a bundler (no esbuild/webpack step), so its
real npm dependencies -- including native modules like the `tree-sitter-*`
grammars -- must be present in the packaged `.vsix`.
**Do not add `--no-dependencies`**: that flag skips packaging `node_modules`
entirely and produces a `.vsix` that fails to activate on install.

---

## License

MIT
