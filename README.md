# claude-glossary

A [Claude Code](https://claude.com/claude-code) plugin that lazy-loads glossary definitions into the model's context when your prompt mentions matching terms.

A port of [pi-glossary](https://github.com/ruliana/pi-glossary) (for the pi coding agent) to Claude Code.

## Why

This lets you keep a shared project vocabulary in one place without bloating every turn's prompt. Definitions are only injected when the current prompt references a matching glossary handle.

More about it in [this blog post](https://ronie.medium.com/agent-glossary-teaching-agents-our-shared-language-93bae9674b02)

## How It Works

1. On session start, the plugin loads `~/.claude/glossary.json` or `~/.claude/glossary.jsonl`, and `.claude/glossary.json` or `.claude/glossary.jsonl` from the current project.
2. Either file may contain `{"include": "path_or_url"}` entries to inline entries from another local file or URL at that position (see [Include Directives](#include-directives)).
3. Project entries override global entries when they use the same `term`. Within a file, **earlier entries (top) take priority** over later ones.
4. When you submit a prompt (the `prompt.submit` function hook), the plugin scans it for all matching glossary terms, aliases, or explicit regex patterns.
5. If one or more terms match, only terms not already loaded in the current session are attached to the prompt as hidden context: the model sees the definitions, while the transcript shows your prompt as typed. The first injection in a session includes guidance for interpreting glossary definitions; later injections include only the `## Glossary` heading and new term definitions.
6. Loaded terms stay visible for the rest of the session in the status line as `Glossary: term, term`.
7. Matched terms are highlighted live in the prompt box as you type.
8. After a context compaction or a `/clear`, loaded terms are reset, so they are re-injected when mentioned again.

## What It Does

- Loads glossary entries from global and project-scoped `glossary.json` or `glossary.jsonl`
- Supports `{"include": "path_or_url"}` entries to pull in remote or local glossaries inline
- Matches canonical terms and optional aliases out of the box
- Supports custom regex triggers per entry
- Expands `{{shell command}}` placeholders in definitions at injection time
- Validates glossary entries and shows actionable errors
- Reloads glossary configuration without restarting Claude Code
- Highlights matched terms live in the prompt box
- Shows loaded terms in the status line for the whole session
- Provides an `mcp__glossary__lookup` tool for `[[term]]` cross-references
- Avoids re-appending glossary entries that were already loaded earlier in the session

## Installation

```bash
claude plugin marketplace add ruliana/claude-glossary
claude plugin install glossary@claude-glossary
```

On first run, the plugin writes a default global glossary to `~/.claude/glossary.json` if neither `~/.claude/glossary.json` nor `~/.claude/glossary.jsonl` exists. This happens only once: if you delete it, the plugin respects that.

To remove:

```bash
claude plugin uninstall glossary@claude-glossary
```

The plugin uses Claude Code's **function hooks**, an early-access API. It has been tested with Claude Code 2.1.289.

### Development

Run Claude Code with the plugin loaded straight from a checkout:

```bash
claude --plugin-dir /path/to/claude-glossary
```

### Migrating from pi-glossary

Copy `~/.pi/agent/glossary.json` to `~/.claude/glossary.json` and `.pi/glossary.json` to `.claude/glossary.json`. Alternatively, keep the old files and use an include directive pointing at them:

```json
[
  { "include": "/home/you/.pi/agent/glossary.json" }
]
```

## Project Configuration

Create `~/.claude/glossary.json` or `~/.claude/glossary.jsonl` for global terms and/or `.claude/glossary.json` or `.claude/glossary.jsonl` inside a project for project-specific terms.

JSON arrays continue to work:

```json
[
  {
    "term": "explore-plan-execute-review",
    "aliases": ["EPER"],
    "definition": "Spawn a team of subagents to explore, plan, execute, and review a task end to end."
  },
  {
    "term": "finance-safe",
    "pattern": "(?:^|[^\\w])finance-safe(?:$|[^\\w])",
    "definition": "Use the conservative workflow: explicit assumptions, no destructive actions, and a reviewer pass before execution."
  }
]
```

JSON Lines is also supported, with one entry per line:

```jsonl
{"term":"explore-plan-execute-review","aliases":["EPER"],"definition":"Spawn a team of subagents to explore, plan, execute, and review a task end to end."}
{"term":"finance-safe","pattern":"(?:^|[^\\w])finance-safe(?:$|[^\\w])","definition":"Use the conservative workflow: explicit assumptions, no destructive actions, and a reviewer pass before execution."}
```

When the same `term` exists in both scopes, the project entry wins.

If both `.json` and `.jsonl` exist in the same scope, the plugin raises an error and asks you to keep only one.

## Include Directives

Any position in a glossary file can be an include directive instead of a regular entry:

```json
{ "include": "path/to/other.json" }
{ "include": "https://raw.githubusercontent.com/org/repo/main/glossary.json" }
{ "include": "https://gist.githubusercontent.com/user/id/raw/glossary.jsonl" }
```

Includes work in both JSON arrays and JSONL files. The referenced source is expanded in-place: entries from the included file appear at the position of the `include` directive, as if you had copy-pasted them there.

**Priority follows list order — top wins.** Entries that appear earlier in the file have higher priority. This means you control what wins by where you put things:

```json
[
  { "term": "deploy", "definition": "project-specific, wins over anything below" },
  { "include": "https://example.com/team-glossary.json" }
]
```

In this example, the local `deploy` entry is listed first and wins over any `deploy` from the URL.

**Supported sources:**

| Source | Example |
|--------|---------|
| Local path (relative to the project directory) | `"include": "../shared/glossary.json"` |
| Local path (absolute) | `"include": "/home/user/.config/glossary.json"` |
| Local path (no extension) | `"include": "extras"` — resolves to `extras.json` or `extras.jsonl` |
| GitHub file (browser URL) | `"include": "https://github.com/org/repo/blob/main/glossary.json"` |
| GitHub file (raw URL) | `"include": "https://raw.githubusercontent.com/org/repo/main/glossary.json"` |
| GitHub Gist (browser Raw button) | `"include": "https://gist.github.com/user/id/raw/hash/glossary.jsonl"` |
| GitHub Gist (raw URL) | `"include": "https://gist.githubusercontent.com/user/id/raw/hash/glossary.jsonl"` |
| Plain URL | `"include": "https://example.com/glossary.json"` |

Browser-visible GitHub URLs (the `/blob/` variant and the gist Raw button URL) are automatically converted to their downloadable equivalents, so you can paste them directly without editing.

**Rules:**
- Circular includes (A includes B which includes A) are detected and skipped with a warning.
- A failed include (file not found, network error, parse error) is reported as a warning and skipped — other entries still load.
- Included files may themselves contain `include` directives (recursive).
- Relative local paths resolve against the project directory (where Claude Code was started), not against the file that contains the include. This applies to includes in the global glossary and in nested includes too, so prefer absolute paths there.
- GitHub URLs (raw files, gists) are fetched with authentication: `GITHUB_TOKEN` env var is tried first; if absent, the `gh` CLI's stored credentials are used (`gh auth token`). Private gists work as long as either is available. The token is sent only over `https` and only when the URL's host is exactly `github.com`, `api.github.com`, `raw.githubusercontent.com` or `gist.githubusercontent.com`; every other URL is fetched without it.
- Entries from a URL include cannot run [shell command templates](#shell-command-templates) unless the include opts in with `"allowShell": true` (see below).

## Glossary Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `term` | Yes | Canonical glossary handle |
| `definition` | Yes | Definition injected when the entry matches. Supports `{{shell command}}` template placeholders (see below). |
| `aliases` | No | Additional plain-text aliases used for matching; not included in injected context |
| `pattern` | No | Explicit regex trigger; overrides the default matcher |
| `flags` | No | Regex flags, defaults to `iu` |
| `enabled` | No | Set to `false` to disable an entry |
| `source` | No | A note shown in the glossary browser after the file or URL the entry was actually loaded from, as `<location> (<note>)`; not included in injected context |

## Shell Command Templates

Definition strings can embed shell commands using `{{command}}` placeholders. Each placeholder is replaced with the command's stdout (trimmed) right before the definition is injected into the context or returned by `mcp__glossary__lookup`.

```json
{
  "term": "current branch",
  "definition": "The current branch in {{pwd}} is {{git branch --show-current}}."
}
```

When this term is matched, the agent receives something like:

```
The current branch in /home/user/myproject is feat/new-login.
```

**Rules:**
- Commands run in the session's working directory.
- Each distinct command in a definition runs at most once per injection.
- If a command exits with an error or times out (5 s limit), the placeholder is replaced with `[error: <message>]` rather than stopping the injection.
- The `/glossary` browser shows the raw template text (unexpanded), since expansion happens at prompt-submit time.
- Templates run only for entries from your own glossary files and the local files they include. Entries that come from a URL include (directly or through anything it includes) are not expanded: each placeholder becomes `[shell template disabled: remote glossary source]`.
- To let a remote glossary you trust run its templates, add `"allowShell": true` to the include in your own file. Only an include written in a local glossary can grant this; a remote glossary cannot grant it to itself or to what it includes:

```json
{ "include": "https://raw.githubusercontent.com/org/repo/main/glossary.json", "allowShell": true }
```

Anyone who can change that URL's content can then run commands on your machine whenever a matching term is mentioned, so opt in only for sources you control.

## Validation

Each enabled entry must have:

- a non-empty `term`
- a non-empty `definition`
- a valid regex `pattern` if `pattern` is provided

If validation fails, `/glossary` and `/glossary reload` show an actionable error that identifies the bad entry.

## Matching Behavior

If `pattern` is omitted, the plugin builds a case-insensitive, boundary-aware matcher from `term` plus `aliases`.

That means these work well out of the box:

- single terms like `tophat`
- dashed handles like `explore-plan-execute-review`
- multi-word phrases like `railway topic`

Use `pattern` when you want total control over matching.

When multiple entries match the same prompt, all matching entries are considered. Entries already loaded earlier in the session are skipped so they are not injected again.

## Tool

| Tool | Description |
|------|-------------|
| `mcp__glossary__lookup` | Look up a glossary term, for `[[term]]` cross-references in definitions |

## Commands

| Command | Description |
|---------|-------------|
| `/glossary` | Open an interactive glossary browser pane (type to search, Tab to move between terms). Running it again while the pane is open closes it. Under `claude -p`, where no pane can be drawn, it prints the term list instead |
| `/glossary close` | Close the browser pane. Esc also closes it, but only while the pane has the keyboard or the prompt is idle and empty; otherwise use this, `/glossary` again, or the pane's **Close** button |
| `/glossary reload` | Reload `~/.claude/glossary.json` or `~/.claude/glossary.jsonl`, and `.claude/glossary.json` or `.claude/glossary.jsonl`, without restarting Claude Code. Also resets the session's loaded terms |

## Notes

- Glossary data can be global (`~/.claude/glossary.json` or `~/.claude/glossary.jsonl`) or project-scoped (`.claude/glossary.json` or `.claude/glossary.jsonl`).
- Nothing is injected when the prompt does not mention a glossary handle.
- Once a term is loaded in a session, mentioning it again does not inject it again (until a compaction, a `/clear`, or `/glossary reload`).
- If you edit any glossary file (`glossary.json` or `glossary.jsonl`), run `/glossary reload`.

## License

MIT
