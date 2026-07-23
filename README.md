# tempmd-mcp

MCP server for [temp.md](https://temp.md) — give agent-made artifacts one stable public link that updates in place.

Publish an HTML, Markdown, CSV, or Mermaid artifact and get a canonical URL like `amber-hill-9eb6.temp.md`. Push new versions behind the same URL — no re-sharing, ever. Temps expire intentionally when the work goes cold (7-day active window, resets on every update) and can be restored within 7 days of expiry.

## Install

**Claude Code**

```bash
claude mcp add tempmd -- npx -y tempmd-mcp
```

**Cursor / Windsurf / any MCP client** — add to your MCP config:

```json
{
  "mcpServers": {
    "tempmd": {
      "command": "npx",
      "args": ["-y", "tempmd-mcp"]
    }
  }
}
```

No account or API key required — temp.md is anonymous-create-first. Claim a Temp later to keep it.

## Tools

| Tool | What it does |
|------|--------------|
| `publish_temp` | Publish a new artifact, get a stable public URL + update token |
| `update_temp` | Push a new version behind the same URL (resets the 7-day window) |
| `get_temp_status` | Check lifecycle: active / cooling / expired / restorable |
| `restore_temp` | Bring a recently expired Temp back at the same URL |
| `snapshot_temp` | Freeze the current version as a fixed reference with its own URL |
| `set_comments` | Toggle pinned visitor comments (Pindrop) on the page |
| `list_temps` | List Temps recorded in this project |

`publish_temp` and `update_temp` accept `spa_mode: true` for client-routed
single-page apps. Leave it off for static sites so missing assets return 404.
Uploads are capped at 10 MB per file, 50 MB per bundle, and 100 files; publish
and update limits are 60/hour/IP and 120/hour/Temp/IP respectively.

## How credentials work

`publish_temp` saves a record (Temp ID, URL, update token, expiry) to a `.tempmd` file in the project root. Every other tool reads that file automatically, so an agent can update the same Temp across sessions without you managing tokens. Tokens can also be passed explicitly via `update_token`.

Add `.tempmd` to `.gitignore` if the update token shouldn't be shared with everyone who can read the repo.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `TEMPMD_API_URL` | `https://api.temp.md` | Point at a different API (e.g. local dev `http://localhost:8787`) |

## Development

This repo mirrors the `packages/mcp` package from the temp.md monorepo, where development happens. Issues and feature requests are welcome here.

## Semantics agents should preserve

- The canonical URL is the only link to share — never surface version-specific links.
- A failed update never breaks the live link; the last successful version keeps serving.
- Prefer `update_temp` over `publish_temp` when the project already has a Temp for the artifact.
