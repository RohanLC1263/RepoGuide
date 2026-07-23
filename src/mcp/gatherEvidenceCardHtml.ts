/**
 * Self-contained MCP App UI resource (SEP-1865 / MCP Apps, spec 2026-01-26) for the
 * `gather_evidence` tool. Served over a `ui://` URI with MIME `text/html;profile=mcp-app`
 * and linked to the tool via `_meta.ui.resourceUri` (see mcpServer.ts). Rendered inline in
 * a sandboxed iframe by MCP-Apps-capable hosts (Claude Desktop) in place of the generic
 * "Used repoguide integration" panel.
 *
 * Deliberately minimal: a branded, trust/visibility confirmation card, NOT a dashboard. It
 * shows RepoGuide branding, the repo being worked against, and a compact post-completion
 * summary (counts + categories). The full evidence still lives in the tool's markdown
 * content blocks -- this is only a visible "this really happened" layer.
 *
 * No build step / bundler: everything (CSS + JS) is inline in one HTML string, so tsc emits
 * it to out/ as-is. The host<->iframe bridge is the spec's documented manual postMessage
 * JSON-RPC pattern (no external SDK dependency): the iframe performs the `ui/initialize`
 * handshake, then listens for `ui/notifications/tool-input` (the question) and
 * `ui/notifications/tool-result` (structuredContent with the counts).
 */

/** Stable ui:// URI for the gather_evidence card, referenced by both the resource
 * registration and the tool's _meta.ui.resourceUri linkage. */
export const GATHER_EVIDENCE_UI_URI = 'ui://repoguide/gather-evidence-card';

export const GATHER_EVIDENCE_CARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RepoGuide</title>
<style>
  :root {
    --rg-bg: #ffffff; --rg-fg: #1a1a2e; --rg-muted: #5c5c74;
    --rg-border: #e4e4ef; --rg-accent: #5b4bdb; --rg-accent-soft: #efecff;
    --rg-good: #1f9d55; --rg-warn: #c2751a; --rg-chip-bg: #f5f5fb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --rg-bg: #17171f; --rg-fg: #ececf5; --rg-muted: #a0a0b8;
      --rg-border: #2c2c3a; --rg-accent: #9d90ff; --rg-accent-soft: #23213a;
      --rg-good: #4ade80; --rg-warn: #eab873; --rg-chip-bg: #20202c;
    }
  }
  :root[data-theme="dark"] {
    --rg-bg: #17171f; --rg-fg: #ececf5; --rg-muted: #a0a0b8;
    --rg-border: #2c2c3a; --rg-accent: #9d90ff; --rg-accent-soft: #23213a;
    --rg-good: #4ade80; --rg-warn: #eab873; --rg-chip-bg: #20202c;
  }
  :root[data-theme="light"] {
    --rg-bg: #ffffff; --rg-fg: #1a1a2e; --rg-muted: #5c5c74;
    --rg-border: #e4e4ef; --rg-accent: #5b4bdb; --rg-accent-soft: #efecff;
    --rg-good: #1f9d55; --rg-warn: #c2751a; --rg-chip-bg: #f5f5fb;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--rg-fg); background: var(--rg-bg);
    font-size: 13px; line-height: 1.45;
  }
  .card {
    border: 1px solid var(--rg-border); border-radius: 12px;
    padding: 14px 16px; max-width: 520px; background: var(--rg-bg);
  }
  .head { display: flex; align-items: center; gap: 10px; }
  .logo {
    width: 26px; height: 26px; border-radius: 7px; flex: 0 0 auto;
    background: linear-gradient(135deg, var(--rg-accent), #8b7dff);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 14px;
  }
  .brand { font-weight: 650; font-size: 14px; letter-spacing: .1px; }
  .tagline { color: var(--rg-muted); font-size: 11px; margin-top: 1px; }
  .repo {
    margin-top: 12px; display: inline-flex; align-items: center; gap: 6px;
    color: var(--rg-fg); background: var(--rg-accent-soft);
    border: 1px solid var(--rg-border); border-radius: 999px;
    padding: 3px 10px; font-size: 12px; font-weight: 550; max-width: 100%;
  }
  .repo .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .q { margin-top: 10px; color: var(--rg-muted); font-style: italic; font-size: 12px;
       overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
       -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .status { margin-top: 12px; display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .spinner {
    width: 13px; height: 13px; border: 2px solid var(--rg-border);
    border-top-color: var(--rg-accent); border-radius: 50%;
    animation: spin .8s linear infinite; flex: 0 0 auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .check { color: var(--rg-good); font-weight: 700; }
  .chips { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    background: var(--rg-chip-bg); border: 1px solid var(--rg-border);
    border-radius: 7px; padding: 4px 9px; font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .chip b { color: var(--rg-accent); font-weight: 700; }
  .thin { color: var(--rg-warn); font-size: 11.5px; margin-top: 8px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div class="logo">R</div>
      <div>
        <div class="brand">RepoGuide</div>
        <div class="tagline">grounded codebase evidence · no cloud, local-first</div>
      </div>
    </div>

    <div class="repo" id="repo"><span>\u{1F4C1}</span><span class="path" id="repoPath">this workspace</span></div>
    <div class="q hidden" id="q"></div>

    <div class="status" id="statusRow">
      <div class="spinner" id="spinner"></div>
      <span id="statusText">Gathering evidence…</span>
    </div>

    <div class="chips hidden" id="chips"></div>
    <div class="thin hidden" id="thin">⚠ Grounding is thin — few sources matched; treat any answer as low-confidence.</div>
  </div>

<script>
(function () {
  "use strict";
  var nextId = 1;
  var pending = {};

  function post(msg) { window.parent.postMessage(msg, "*"); }
  function sendRequest(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  function setRepo(repo) {
    if (!repo) return;
    document.getElementById("repoPath").textContent = repo;
  }

  function setQuestion(q) {
    if (!q) return;
    var el = document.getElementById("q");
    el.textContent = "“" + q + "”";
    el.classList.remove("hidden");
  }

  function renderResult(sc) {
    // Hide the spinner, flip to the completed confirmation state.
    document.getElementById("spinner").classList.add("hidden");
    var st = document.getElementById("statusText");
    st.innerHTML = '<span class="check">✓</span> Evidence gathered';

    if (!sc) return;
    if (sc.repo) setRepo(sc.repo);
    if (sc.question) setQuestion(sc.question);

    var chips = document.getElementById("chips");
    chips.innerHTML = "";
    function chip(label, value) {
      var d = document.createElement("div");
      d.className = "chip";
      d.innerHTML = "<b>" + value + "</b> " + label;
      chips.appendChild(d);
    }
    if (typeof sc.codeContextReturned === "number") chip("code context", sc.codeContextReturned);
    if (typeof sc.factsReturned === "number") chip("facts", sc.factsReturned);
    if (typeof sc.coveragePct === "number") chip("coverage", sc.coveragePct + "%");
    chips.classList.remove("hidden");

    if (sc.sparse) document.getElementById("thin").classList.remove("hidden");
  }

  // Route both responses (have id) and notifications (have method) from the host.
  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.id != null && pending[data.id]) {
      var p = pending[data.id]; delete pending[data.id];
      if (data.error) { p.reject(new Error(data.error.message || String(data.error))); }
      else { p.resolve(data.result); }
      return;
    }
    if (data.method === "ui/notifications/tool-input") {
      var a = (data.params && data.params.arguments) || {};
      if (a.question) setQuestion(a.question);
    } else if (data.method === "ui/notifications/tool-result") {
      renderResult(data.params && data.params.structuredContent);
    }
  });

  // Handshake. hostContext carries theme/styles/display mode.
  sendRequest("ui/initialize", {
    capabilities: {},
    clientInfo: { name: "RepoGuide Evidence Card", version: "1.0.0" },
    protocolVersion: "2026-01-26"
  }).then(function (res) {
    var hc = (res && res.hostContext) || {};
    applyTheme(hc.theme);
  }).catch(function () { /* non-fatal: card still renders with default theme */ });
})();
</script>
</body>
</html>`;
