# switchboard

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that keeps the sessions you are working in right now above the prompt, as small cards:

```
● Paras offline sync      ×   ● Newsletter form       ×   ● Switchboard mod       ×
  180 tests green               Yes, merge  Wait          relay hooked up
```

- **A card exists because you wrote in that session.** It appears at your first prompt there (opening an old session to look something up does not count), stays while the session lives and you have written in it within the last 8 hours, and goes when you press ×, close or archive the session, or quit the app. A red card stays until you have dealt with it.
- **Lamp**: yellow while Claude works, green when the turn is done, red when the session needs you (a permission dialog or a question), grey when it has ended.
- **Label**: what the session is about, in at most 18 characters. **Gist**: the state of the latest reply in at most 22 characters. Both are written by a small model in the language of the reply, and cached so each pair is summarized once.
- **Click the label** to jump to that session. **×** hides the card until you write in that session again.
- **↩ answers from here.** When the session has asked a question, the card opens: it takes two places, shows the whole question, and one row per option; one press answers it there. When there is no question but a suggested prompt sits in that session's box, the row is **send** plus the suggestion. The suggestion is the engine's own after each turn; when none comes and the reply ended on a question, the session writes the one-line reply that would accept it. The text is relayed to that session, which ends its wait and submits it as your own prompt. Under the pointer a red card with a question opens a popover, twice as wide as the card, with the full question and one row per option; in the desktop app it floats over the transcript above the band, so no card moves and no space is kept. In a terminal, which clips at the band, the question shows in the card instead. Other cards stay put until you press ↩, which opens the same popover with the latest reply in full.
- **A place belongs to a project.** The first card from a folder takes the next free place, and a later session in the same folder sits with it. Nothing moves when activity changes.
- **⇢ hands a session off** (press it twice: the first press arms it, the second within four seconds runs it). The session writes a brief of its work, a fresh session starts in the same folder with that brief as its first prompt, and the new card takes the old one's place. For when a context has grown long.
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
| Hours on the board | 8 | A card stays this many hours after you last wrote in its session. A red card stays until handled. |
| Maximum cards | 6 | How many cards the band shows at most, three per row. |
| Short labels | on | Let a small model write the label and gist. Off, the card shows the title and the latest reply cut short. |
| Label model | `haiku` | Model alias or id for the labels. |

## How it works

The mod runs in every session. Each session writes one JSON file about itself to `~/.claude/switchboard/sessions/`: its title and link from the desktop app, its exact state from the mod's hooks (`classic.PermissionRequest` marks a dialog, `AskUserQuestion` an open question with its options, `turn.complete` the end), the prompt suggestion, and the engine session id that `$.session.send` addresses. Every session's band reads that folder every few seconds. A file whose heartbeat is older than 45 seconds counts as ended, so a crashed session disappears on its own.

### Hand-off

Pressing ⇢ on a card relays `[switchboard] handoff` to that session (or starts it directly on your own card). The session's mod ends any running turn and submits a request for a brief as your prompt. When that turn completes, the mod takes the reply as the brief and calls the desktop app's `start_session` with it as the first prompt, in the same folder, inheriting model, effort and permission mode. The new session is detached to the top level of the sidebar, the old card is retired, and the new session opens. The old session stays as it was; only its card goes.

### Answering from another session

A button press appends the text to that session's inbox, `~/.claude/switchboard/inbox/<id>.json`. The receiving mod reads its inbox every second, ends the turn that is waiting on the dialog, and submits the text as your own prompt. The inbox is a file rather than `$.session.send` because a send from a mod has no model request behind it for auto mode's permission classifier to judge, and it is refused. A message prefixed `[switchboard] ` sent with SendMessage is taken the same way by the receiving mod's `session.receive` hook.

## Requirements

- Claude Code 2.1.287 or later, in the terminal or in the Code tab of the Claude desktop app
- Titles, links and the jump come from the desktop app. In a plain terminal a card shows the session as "Untitled session" and the jump copies a link.
- macOS for the jump (`open claude://…`). Elsewhere the link is copied to the clipboard instead.

## Development

The plugin loads in place from a clone registered as a local marketplace (`claude plugin marketplace add /path/to/switchboard`), so an edit to `hooks/register.tsx` takes effect at `/reload-plugins` or the next session. `claude plugin validate .` reads the marketplace file; to see what the hooks module hooks and calls, validate a copy without `.claude-plugin/marketplace.json`.

The engine writes its type declarations into `.claude-plugin/types/` the first time it loads the mod from this folder, and `tsconfig.json` extends them, so an editor or `npx tsc -p .` type-checks the module against the exact build you run.

## Privacy

Everything stays on your machine except the label and gist, which are produced by one small model call per changed card on your own Claude plan. The call sees the session title and the first 80 characters of the latest reply. Treat that like any other text you send to Claude.

## License

MIT
