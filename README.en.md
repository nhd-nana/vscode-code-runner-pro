# Code Runner Pro

Run code snippets or whole files for 50+ languages — and **non-text files such as docx / exe / pdf**.

> A fork of [formulahendry/vscode-code-runner](https://github.com/formulahendry/vscode-code-runner) (by Jun Han, MIT).
> Configuration keys stay `code-runner.*` (no migration needed) while command IDs are `crun.*` (safe to keep both extensions installed).
> 中文说明见 [README.md](README.md)

## What is different from upstream

| Feature | Detail |
|---|---|
| **Non-text files** | docx / exe / pdf / xlsx can be run. Upstream calls `openTextDocument` first and binary files abort the command; this fork only needs the path. Works inside custom editors (e.g. Office Viewer) too |
| **Multiple commands** | Configure several commands per target; picking happens in a QuickPick (last used on top). Values may be `"cmd"`, `["cmd1","cmd2"]` or `[{label, description, command}]` |
| **Multi-segment extensions** | `executorMapByFileExtension` understands `.x64.s` (longest suffix wins, case-insensitive, order-independent) |
| **Alt multi-selection** | Upstream only uses the main selection; this fork concatenates all non-empty selections in document order |
| **Configurable match order** | `matchOrder` decides the precedence of the matching steps |
| **Diagnostics** | `Explain How This File Is Matched` (the output can be pasted into an issue), `Show Extension → Language Map` |
| **Observability** | `showTempCode`, `deleteTempFileAfterRun` |
| **Localized** | Settings and command palette follow the VS Code display language |
| **No telemetry** | Upstream reports run events to the author's Application Insights account; removed in this fork |

## Usage

| Task | How |
|---|---|
| Run the whole file | ▶ in the editor title, or `Ctrl+Alt+N` |
| Run only the selection | Select first, then the same. Alt multi-selection concatenates several ranges |
| Run a file from the explorer | Right-click → `Run Code` |
| Run with another language | Command palette → `Run By Language` |
| Stop | `Ctrl+Alt+M` |
| Understand why a command was chosen | Command palette → `Explain How This File Is Matched` |

### Temporary file of a selection run

- The extension **always reuses the original file extension** (a file without extension produces a temp file without extension), so the temp file behaves exactly like the original file. If the original cannot run, the temp file cannot either — that is a configuration problem, fix the configuration.
- `temporaryFileName` sets the base name (default `tempCodeRunnerFile`).
- `deleteTempFileAfterRun` (default on) removes it afterwards; in terminal mode a delete command is appended to the same shell.
- `showTempCode` prints the generated content to the `Code Runner Pro` output channel.

## Match order

The first step that hits stops the search. Default (most specific first):

```
shebang → glob → extension → language → default
```

| Step | Matches on | Config |
|---|---|---|
| `shebang` | first line `#!` | — |
| `glob` | whole file name (micromatch) | `executorMapByGlob` |
| `extension` | file extension (longest suffix wins) | `executorMapByFileExtension` |
| `language` | language id decided by VS Code | `executorMap` |
| `default` | fallback language | `executorMap[defaultLanguage]` |

`matchOrder` is a single string separated by commas or spaces; **leave it empty for the default order**:

```jsonc
// default (most specific first)
"code-runner.matchOrder": "shebang, glob, extension, language, default"

// upstream semantics (language before extension)
"code-runner.matchOrder": "shebang, glob, language, extension, default"
```

Unknown or duplicated entries are ignored; steps you leave out are appended in the default order.
Not sure which step a file takes? Run `Explain How This File Is Matched`.

## Multiple commands

```jsonc
"code-runner.executorMapByFileExtension": {
  ".docx": [
    { "label": "To Markdown", "command": "pandoc $fullFileName -o $fileNameWithoutExt.md" },
    { "label": "To PDF", "command": "soffice --convert-to pdf $fullFileName" }
  ]
}
```

`multiActionBehavior` controls what happens when several commands match: `pick` (default, last used on top), `last`, `first`.

## Variables

`$fileName` `$fileNameWithoutExt` `$fullFileName` `$dir` `$dirWithoutTrailingSlash` `$workspaceRoot` `$pythonPath` `$driveLetter`

(`$dir`, `$dirWithoutTrailingSlash` and `$fullFileName` are quoted automatically.)

## Compatibility with upstream

| Layer | Approach |
|---|---|
| Configuration | shared `code-runner.*` — both extensions read the same settings |
| Commands | own IDs `crun.*`; the legacy `code-runner.*` aliases are registered **only when upstream is absent or disabled**, so your keybindings, `tasks.json` and scripts keep working |
| Hint | one-time notice when upstream is still enabled, to avoid two identical run buttons |

## License

MIT. Upstream code © Jun Han; the original copyright notice is kept in `LICENSE`.
The icon is original artwork — upstream branding is not used.
