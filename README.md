# switchboard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps your other sessions in view. It draws a band above the prompt with one card per recent session, and a detail strip that fills in when you hover a card:

```
╭ ● Paras offline sync    × ╮ ╭ ● Newsletter form     × ╮ ╭ ● Switchboard mod     × ╮
│ 180 tests green           │ │ asks you                │ │ relay hooked up         │
╰───────────────────────────╯ ╰─────────────────────────╯ ╰─────────────────────────╯
╭ ● Consat AI-nyhetsbrev (form fork)  needs you ──────────────────────────────────╮
│ Merge the form branch now?   [ Yes, merge ]  [ Wait for review ]  [ Drop it ]  │
╰─────────────────────────────────────────────────────────────────────────────────╯
```

- **Lamp**: yellow while Claude works, green when the turn is done, red when the session needs you (a permission dialog or a question), grey when it has ended.
- **Label**: what the session is about, in at most 18 characters. **Gist**: the state of the latest reply in at most 22 characters. Both are written by a small model in the language of the reply, and cached so each pair is summarized once.
- **Click the label** to jump to that session. **×** hides the card until the session is active again.
- **Hover a card** to see the full title, the latest reply, and, when the session has asked a question, the question with its options as buttons. One press answers it there. When a session is done and has a suggested prompt in its box, **Send suggestion** sends it.
- **Cards keep their place.** The order they first appeared in is stored; a new session goes last. Nothing moves when activity changes.
- `/board` collapses or expands the band.

## Install

From a session:

```
/plugin marketplace add KytioisaCat/switchboard
/plugin install switchboard@switchboard
/reload-plugins
```

The install dialog asks for the four settings below; the defaults are fine. To try it without installing, clone the repository and start a session with `claude --plugin-dir /path/to/switchboard`.

| Setting | Default | What it does |
| :- | :- | :- |
| Hours of history | 12 | Show sessions active within this many hours. Running sessions always show. |
| Maximum cards | 8 | How many cards the band shows at most. |
| Short labels | on | Let a small model write the label and gist. Off, the card shows the title and the latest reply cut short. |
| Label model | `haiku` | Model alias or id for the labels. |

## Where the data comes from

| Source | What it gives |
| :- | :- |
| The Claude desktop app's session list (`ccd_session_mgmt` MCP server) | title, working directory, running flag, last activity, the `claude://` link that opens the session |
| The session transcript on disk (`~/.claude/projects/<cwd>/<id>.jsonl`) | the latest reply, an open question with its options, and a tool call left unanswered, which from the outside is what a permission dialog looks like |
| The mod itself, in sessions where it is loaded | exact state: `classic.PermissionRequest` marks a dialog, `AskUserQuestion` an open question, `turn.complete` the end; the prompt suggestion; the address another switchboard can send to |

Sessions without the mod are read heuristically: a tool call left unanswered for more than 20 seconds is shown as waiting. Their question shows on hover, but the buttons do not, because a message sent to a session that is holding a dialog would only queue behind it.

### Answering from another session

When both sessions run the mod, a button press sends `[switchboard] <text>` to the other session with `$.session.send`. The receiving mod's `session.receive` hook takes the message before Claude sees it, ends the turn that is waiting on the dialog, and submits the text as your own prompt. Only your own sessions can send to each other, and the prefix is the whole protocol; a session without the mod would read such a message as a message.

## Requirements

- Claude Code 2.1.287 or later, in the terminal or in the Code tab of the Claude desktop app
- The session list and the jump need the desktop app. In a plain terminal the band shows only sessions that run the mod.
- macOS for the jump (`open claude://…`). Elsewhere the link is copied to the clipboard instead.
- Hovering works with the pointer, so in the Code tab or a terminal that reports the mouse. The buttons in the detail strip are reachable by pointer from the first row of cards; from a second row the strip shows but the pointer crosses other cards on the way down.

## Development

Edits to `hooks/register.tsx` reload in place in a session started with `--plugin-dir`. `claude plugin validate .` reads the marketplace file; to see what the hooks module hooks and calls, validate a copy without `.claude-plugin/marketplace.json`, or read the module.

The engine writes its type declarations into `.claude-plugin/types/` the first time it loads the mod from this folder, and `tsconfig.json` extends them, so an editor or `npx tsc -p .` type-checks the module against the exact build you run.

## Privacy

Everything stays on your machine except the label and gist, which are produced by one small model call per changed card on your own Claude plan. The call sees the session title and the first 80 characters of the latest reply. Treat that like any other text you send to Claude.

## License

MIT
