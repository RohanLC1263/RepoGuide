# RepoGuide MCP App card — visual preview

`preview.html` is a **standalone browser preview** of the MCP Apps (SEP-1865) UI card that
RepoGuide's `gather_evidence` tool renders inline in MCP-Apps-capable hosts (e.g. Claude
Desktop). Open it in any browser — no server, no build. The page mocks an MCP host: it embeds
the real card in a sandboxed `<iframe srcdoc>` and drives it over `postMessage` exactly as a
host would (answers the `ui/initialize` handshake with a theme, then sends
`ui/notifications/tool-input` and `ui/notifications/tool-result`). Buttons replay the sequence
and toggle light/dark and the "sparse grounding" state.

**Source of truth is `src/mcp/gatherEvidenceCardHtml.ts`** (`GATHER_EVIDENCE_CARD_HTML`). The
card embedded in `preview.html` is a **snapshot** for eyeballing only — it can drift from the
`.ts`. It is not loaded by the server or by any test; regenerate it from the compiled source
if the card changes:

```bash
npm run compile
node -e "const{GATHER_EVIDENCE_CARD_HTML:h}=require('./out/mcp/gatherEvidenceCardHtml.js');\
const c=require('fs').readFileSync('scripts/makeMcpAppPreview.js','utf8')" # or re-run the generator
```

(The generator used to produce this file lives in the session scratchpad; the card snapshot
can also just be copy-pasted from `GATHER_EVIDENCE_CARD_HTML` into the `<iframe srcdoc>`.)

## What this preview does and does NOT prove

- **Does show:** the card's real HTML/CSS render, theme switching, and the full
  gathering → "✓ Evidence gathered" transition with the count chips, driven by the real
  postMessage bridge in a real browser iframe.
- **Does NOT prove:** that Claude Desktop's specific current build renders `ui://` resources
  the way this mock host does. That requires a live check in Claude Desktop itself.

The protocol both sides speak is validated automatically (server surface + client bridge) —
see the "MCP Apps" section of the engineering notes / the verification harnesses.
