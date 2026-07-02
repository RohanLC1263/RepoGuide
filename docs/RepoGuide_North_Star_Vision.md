# RepoGuide North Star Vision

> Canonical vision note: `docs/RepoGuide_Vision_Constitution.md` is the governing product constitution.
> This file is retained as historical north-star context and should defer to the constitution when there is any conflict.

This document captures the ultimate product workflow for RepoGuide as defined by the founder.

## 1. Seamless Onboarding
*   **Marketplace Discovery:** User downloads the extension directly from the VS Code Marketplace.
*   **Guided Setup:** A welcome screen clearly explains the value proposition and instructs the user to install Ollama.
*   **Hardware-Aware Agent:** Instead of hardcoding a 7B model, an intelligent startup routine checks the user's CPU, GPU, and RAM. It automatically selects, downloads (`ollama pull`), and wires the best possible local model for their specific machine.

## 2. Autonomous Intelligence
*   **Auto-Indexing:** Upon opening a new repository, RepoGuide instantly and automatically begins building the AST + BM25 FactStore. The user receives a notification when the codebase is fully mapped.
*   **File Watchers:** The extension continuously monitors the file system. If the project expands or code changes, it incrementally re-indexes in the background without user intervention.

## 3. Dual-Mode Interface
*   **Local Chat (Internal):** For quick doubts and architectural questions, the user queries the VS Code sidebar. The local Ollama model answers perfectly based on the FactStore.
*   **The Cloud Bridge (External MCP):** If the user needs heavy code generation, they use a trigger to seamlessly open their preferred external client (Claude Desktop / ChatGPT). 

## 4. The MCP Handshake
*   When the user asks Claude to generate new features, Claude uses the RepoGuide MCP connection.
*   RepoGuide acts as the highly-optimized context engine, retrieving the exact files and AST relationships needed.
*   Claude receives this perfect context and outputs incredibly accurate, grounded code that perfectly matches the existing project architecture.
