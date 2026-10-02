# switchboard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps your other sessions in view. It draws a band above the prompt with one card per recent session:

```
╭ ● Paras offline sync      × ╮ ╭ ● Newsletter form fork    × ╮
│ all 180 tests green         │ │ waiting for you             │
╰─────────────────────────────╯ ╰─────────────────────────────╯
```

- **Lamp**: yellow while Claude works, green when the turn is done, red when a session is waiting for you (a permission dialog or a question), grey when it has ended.
- **Label**: what the session is about, in at most 18 characters.
- **Gist**: the state of the latest reply in at most 22 characters: done, needs input, error, in progress.
- **Click the label** to jump to that session. **×** hides the card until the session is active again.
- `/board` collapses or expands the band.

The label and gist are written by Haiku from the session title and the latest reply, in the language that reply is written in, and cached so each pair is summarized once.

## Where the data comes from

| Source | What it gives |
| :- | :- |
| The Claude desktop app's session list (`ccd_session_mgmt` MCP server) | title, working directory, running flag, last activity, the `claude://` link that opens the session |
| The session transcript on disk (`~/.claude/projects/<cwd>/<id>.jsonl`) | the latest reply, and whether a tool call is left unanswered, which from the outside is what a permission dialog looks like |
| The mod itself, in sessions where it is loaded | exact state: `classic.PermissionRequest` marks the wait, `turn.complete` the end |

Sessions without the mod are read heuristically: a tool call left unanswered for more than 20 seconds is shown as waiting. Sessions with the mod write their exact state to `~/.claude/switchboard/sessions/`.

## Requirements

- Claude Code 2.1.287 or later, in the terminal or in the Code tab of the Claude desktop app
- The session list and jump need the desktop app. In a plain terminal the band shows only sessions that run the mod, and the `claude://` link opens the app if it is installed.
- macOS for the jump (`open claude://…`). On other platforms the link is copied to the clipboard instead.

## Try it

```bash
claude --plugin-dir /path/to/switchboard
```

Edits to `hooks/register.tsx` reload in place. `claude plugin validate .` lists what the mod hooks and calls.

## Development

The engine writes its type declarations into `.claude-plugin/types/` the first time it loads the mod from this folder, and `tsconfig.json` extends them, so an editor or `npx tsc -p .` type-checks `hooks/register.tsx` against the exact build you run.

## Privacy

Everything stays on your machine except the label and gist, which are produced by one small model call per changed card on your own Claude plan. The call sees the session title and the first 80 characters of the latest reply. Treat that like any other text you send to Claude.

## License

MIT
