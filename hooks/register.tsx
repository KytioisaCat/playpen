import type { Register, EngineInterface } from 'claude-code'

// switchboard: a band above the prompt with one card per recent session.
//
// Sources, merged per app session id:
//  1. The desktop app's session list ($.mcp.call on ccd_session_mgmt): title,
//     cwd, isRunning, lastActivityAt and the claude:// link that opens it.
//  2. The session's transcript on disk (~/.claude/projects/<cwd>/<id>.jsonl):
//     the last reply as a snippet, and whether a tool call is left unanswered,
//     which is what a permission dialog looks like from the outside.
//  3. For a session running this mod, its own exact state, written to
//     ~/.claude/switchboard/sessions/<id>.json by the hooks below.
//  4. A small model turns title + last reply into a ~20-character label and a
//     ~24-character gist, cached in $.store so each pair is summarized once.

type State = 'working' | 'done' | 'waiting' | 'ended'

type Card = {
  id: string // the app's session id (local_...)
  title: string
  label: string // the short title drawn on the card
  gist: string // the short last-message line drawn on the card
  cwd: string
  link: string
  state: State
  snippet: string
  lastActivityAt: number
  isExact: boolean // state comes from the mod running in that session
}

type AppSession = {
  sessionId: string
  title: string
  cwd: string
  isRunning: boolean
  isArchived: boolean
  lastActivityAt: string
  link?: string
}

type Own = {
  id: string
  state: State
  snippet: string
  updatedAt: number
}

type Tail = { path: string; mtimeMs: number; snippet: string; hasPendingTool: boolean }

type Mini = { key: string; label: string; gist: string }

const POLL_MS = 3_000
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000
const WINDOW_MS = 12 * 60 * 60 * 1000
const MAX_CARDS = 8
const CARD_WIDTH = 28
const LABEL_MAX = 18
const GIST_MAX = 22
// what the model is asked for: a little under the hard limits, so the
// ellipsis the trim adds stays rare
const LABEL_ASK = 16
const GIST_ASK = 20
const TAIL_BYTES = '80000'
// a tool call left unanswered this long, in a session without the mod, is
// read as a permission dialog; shorter and a slow Bash command looks the same
const WAITING_IDLE_MS = 20_000

let home = ''
let ownDir = ''
let me: Own | null = null
let meLink = ''
let deck: Card[] = []
let lastDeckJson = ''
let isCollapsed = false
let isPolling = false
let isSummarizing = false
let hidden: Record<string, number> = {}
let minis: Record<string, Mini> = {}
const tails = new Map<string, Tail>()

// Tool calls in flight and which of them have a dialog up. Several tools can
// run at once, so one call ending must not clear another call's wait.
const inFlight = new Map<string, { tool: string; input: string }>()
const waitingIds = new Set<string>()
let isPromptUp = false // a permission prompt that matched no call in flight

const trim = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

const lampColor = (state: State) =>
  state === 'working' ? 'yellow' : state === 'waiting' ? 'red' : state === 'done' ? 'green' : 'gray'

const lampWord = (state: State) =>
  state === 'working' ? 'jobbar' : state === 'waiting' ? 'väntar på dig' : state === 'done' ? 'klar' : 'stängd'

const mcpText = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')

async function init($: EngineInterface) {
  if (home) return
  home = (await $.env.get('HOME')) ?? '/tmp'
  ownDir = `${home}/.claude/switchboard/sessions`
  hidden = ((await $.store.get('hidden')) as Record<string, number> | undefined) ?? {}
  // the key carries the prompt version, so a new prompt relabels every card
  minis = ((await $.store.get('minis-v2')) as Record<string, Mini> | undefined) ?? {}
}

// --- this session's own exact state ---------------------------------------

async function writeMe($: EngineInterface, patch: Partial<Own> = {}) {
  if (!me) return
  me = { ...me, ...patch, updatedAt: await $.clock.now() }
  try {
    await $.fs.write(`${ownDir}/${me.id}.json`, JSON.stringify(me))
  } catch {
    // unwritable folder: the band still knows this session from memory
  }
}

async function readOwn($: EngineInterface): Promise<Map<string, Own>> {
  const own = new Map<string, Own>()
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(ownDir)
  } catch {
    return own
  }
  const now = await $.clock.now()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const o = JSON.parse(await $.fs.read(`${ownDir}/${entry.name}`)) as Own
      // a process that died mid-turn never wrote 'ended'; the heartbeat tells
      if (o.state !== 'ended' && now - o.updatedAt > STALE_MS) o.state = 'ended'
      own.set(o.id, o)
    } catch {
      // half-written file: skip it this round
    }
  }
  if (me) own.set(me.id, me)
  return own
}

const settle = ($: EngineInterface) =>
  writeMe($, { state: waitingIds.size > 0 || isPromptUp ? 'waiting' : 'working' })

async function mySnippet($: EngineInterface) {
  const last = [...(await $.session.messages())].reverse().find(m => m.role === 'assistant' && m.text.trim())
  return last ? trim(last.text, 80) : ''
}

// --- the app's session list -----------------------------------------------

async function listApp($: EngineInterface): Promise<AppSession[]> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 25 })
    if (r.isError) return []
    return JSON.parse(mcpText(r)) as AppSession[]
  } catch {
    return []
  }
}

async function selfApp($: EngineInterface): Promise<AppSession | null> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (r.isError) return null
    return JSON.parse(mcpText(r)) as AppSession
  } catch {
    return null
  }
}

// --- transcripts on disk ----------------------------------------------------

const projectDir = (cwd: string) => `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`

// The transcript of an app session: the .jsonl in its project folder whose
// mtime sits closest to the app's last activity (several sessions share a cwd).
async function pickTranscript($: EngineInterface, s: AppSession): Promise<{ path: string; mtimeMs: number } | null> {
  let entries: { name: string; kind: string; mtimeMs: number }[]
  try {
    entries = await $.fs.list(projectDir(s.cwd))
  } catch {
    return null
  }
  const at = Date.parse(s.lastActivityAt)
  let best: { path: string; mtimeMs: number } | null = null
  let bestGap = Infinity
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
    const gap = Math.abs(e.mtimeMs - at)
    if (gap < bestGap) {
      bestGap = gap
      best = { path: `${projectDir(s.cwd)}/${e.name}`, mtimeMs: e.mtimeMs }
    }
  }
  return best
}

async function readTail($: EngineInterface, s: AppSession): Promise<Tail | null> {
  const picked = await pickTranscript($, s)
  if (!picked) return null
  const cached = tails.get(s.sessionId)
  if (cached && cached.path === picked.path && cached.mtimeMs === picked.mtimeMs) return cached

  let stdout = ''
  try {
    // $.fs.read refuses files over 4 MiB, and long sessions pass that
    const r = await $.process.run(['tail', '-c', TAIL_BYTES, picked.path], { timeoutMs: 5_000 })
    stdout = r.stdout
  } catch {
    return cached ?? null
  }

  let snippet = ''
  const pending = new Set<string>()
  const lines = stdout.split('\n').slice(1) // the first line is cut mid-record
  for (const line of lines) {
    if (!line.trim()) continue
    let r: { type?: string; message?: { content?: unknown } }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as { type: string; text?: string; id?: string; tool_use_id?: string }[]) {
      if (r.type === 'assistant' && block.type === 'text' && block.text?.trim()) snippet = block.text
      if (r.type === 'assistant' && block.type === 'tool_use' && block.id) pending.add(block.id)
      if (r.type === 'user' && block.type === 'tool_result' && block.tool_use_id) pending.delete(block.tool_use_id)
    }
  }
  const tail: Tail = { path: picked.path, mtimeMs: picked.mtimeMs, snippet: trim(snippet, 80), hasPendingTool: pending.size > 0 }
  tails.set(s.sessionId, tail)
  return tail
}

// --- short labels from a small model ----------------------------------------

const miniKey = (title: string, snippet: string) => `${title}\u0000${snippet}`

// One card at a time, newest first, so a burst of activity costs one small
// call per poll and never blocks the band.
async function summarizeNext($: EngineInterface) {
  if (isSummarizing) return
  const card = deck.find(c => c.state !== 'working' && minis[c.id]?.key !== miniKey(c.title, c.snippet))
  if (!card) return
  isSummarizing = true
  try {
    const folder = card.cwd.split('/').pop() ?? ''
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 80,
      timeoutMs: 10_000,
      system:
        'You write labels for small cards that show what is going on in several coding sessions at once. ' +
        'Reply with exactly one JSON line: {"label": "...", "gist": "..."}. ' +
        `"label" (max ${LABEL_ASK} characters): the topic of the session, so the reader knows which chat it is. Prefer the concrete subject (feature, bug, component, document) over generic words. ` +
        `"gist" (max ${GIST_ASK} characters): the current status from the latest reply. Lead with what matters: done, needs a decision or input, error, blocked, in progress, or a question asked. Telegram style, no trailing period. ` +
        'Write in the language of the latest reply; if there is none, the language of the title. Keep proper nouns and technical terms as they are. No other text.',
      prompt: `Project folder: ${folder}\nSession title: ${card.title}\nLatest reply from Claude: ${card.snippet || '(nothing yet)'}`,
    })
    if (r.isAnswered) {
      const match = r.text.match(/\{[\s\S]*\}/)
      const parsed = match ? (JSON.parse(match[0]) as { label?: string; gist?: string }) : {}
      const mini: Mini = {
        key: miniKey(card.title, card.snippet),
        label: trim(parsed.label || card.title, LABEL_MAX),
        gist: trim(parsed.gist || card.snippet, GIST_MAX),
      }
      minis = { ...minis, [card.id]: mini }
      await $.store.set('minis-v2', minis)
      lastDeckJson = '' // force a redraw on the next poll
    }
  } catch {
    // a model that refuses or answers oddly: the card keeps its plain text
  } finally {
    isSummarizing = false
  }
}

// --- merging into cards -----------------------------------------------------

async function buildDeck($: EngineInterface): Promise<Card[]> {
  const now = await $.clock.now()
  const own = await readOwn($)
  const sessions = await listApp($)
  const self = await selfApp($)
  if (self) sessions.unshift({ ...self, isRunning: true, lastActivityAt: new Date(now).toISOString() })

  const cards: Card[] = []
  for (const s of sessions) {
    if (s.isArchived) continue
    const at = Date.parse(s.lastActivityAt)
    if (!s.isRunning && now - at > WINDOW_MS) continue
    const hiddenAt = hidden[s.sessionId]
    if (hiddenAt !== undefined && at <= hiddenAt) continue

    const link = s.link ?? `claude://claude.ai/epitaxy/${s.sessionId}`
    const exact = own.get(s.sessionId)
    let state: State
    let snippet = ''
    if (exact) {
      state = exact.state
      snippet = exact.snippet
    } else {
      const tail = await readTail($, s)
      snippet = tail?.snippet ?? ''
      const idleMs = tail ? now - tail.mtimeMs : Infinity
      if (tail?.hasPendingTool && idleMs > WAITING_IDLE_MS) state = 'waiting'
      else if (s.isRunning || idleMs < 15_000) state = 'working'
      else state = 'done'
    }
    const title = s.title || 'Namnlös session'
    const mini = minis[s.sessionId]
    cards.push({
      id: s.sessionId,
      title,
      label: mini?.label ?? trim(title, LABEL_MAX),
      gist: mini?.gist ?? trim(snippet, GIST_MAX),
      cwd: s.cwd,
      link,
      state,
      snippet,
      lastActivityAt: at,
      isExact: !!exact,
    })
    if (cards.length >= MAX_CARDS) break
  }
  return cards
}

async function refresh($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    deck = await buildDeck($)
    const json = JSON.stringify(deck)
    if (json !== lastDeckJson) {
      lastDeckJson = json
      $.ui.invalidate('ui.render')
    }
    void summarizeNext($)
  } finally {
    isPolling = false
  }
}

async function jump($: EngineInterface, card: Card) {
  try {
    const r = await $.process.run(['open', card.link])
    if (r.exitCode !== 0) throw new Error(r.stderr)
  } catch {
    await $.ui.copy({ text: card.link })
    $.ui.toast('Kunde inte öppna sessionen; länken ligger i urklipp')
  }
}

// × hides the card until that session shows new activity
async function hide($: EngineInterface, card: Card) {
  hidden = { ...hidden, [card.id]: card.lastActivityAt }
  await $.store.set('hidden', hidden)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await init($)
    const self = await selfApp($)
    const id = self?.sessionId ?? `local_${await $.session.id()}`
    meLink = self?.link ?? `claude://claude.ai/epitaxy/${id}`
    me = { id, state: 'done', snippet: await mySnippet($), updatedAt: await $.clock.now() }
    if ((await $.session.turns()) > 0) await writeMe($)

    await $.command.register({ name: 'board', description: 'Show or hide the switchboard band', immediate: true })

    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(HEARTBEAT_MS, () => void writeMe($))
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    isCollapsed = !isCollapsed
    $.ui.invalidate('ui.render')
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    await writeMe($, { state: 'working' })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await writeMe($, { state: 'working' })
    return next(e)
  })

  // Fires only when a permission dialog is actually put to the person; in
  // auto mode the classifier's own decisions never reach here.
  on('classic.PermissionRequest', async ($, e, next) => {
    const want = JSON.stringify(e.tool_input ?? {})
    const hit =
      [...inFlight].find(([, c]) => c.tool === e.tool_name && c.input === want) ??
      [...inFlight].find(([, c]) => c.tool === e.tool_name)
    if (hit) waitingIds.add(hit[0])
    else isPromptUp = true
    await settle($)
    return next(e)
  })

  // The app's own notice that a permission prompt is showing: a second signal
  // for prompts the engine routes to the desktop app's UI.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' && waitingIds.size === 0) {
      isPromptUp = true
      await settle($)
    }
    return next(e)
  })

  // The dialog is answered inside the tool call, so this call's end is the end
  // of this call's wait, and no other's.
  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId: _agent, ...input } = e as Record<string, unknown> & {
      tool: string
      tool_use_id: string
    }
    inFlight.set(tool_use_id, { tool, input: JSON.stringify(input) })
    try {
      return await next(e)
    } finally {
      inFlight.delete(tool_use_id)
      const wasWaiting = waitingIds.delete(tool_use_id) || isPromptUp
      isPromptUp = false
      if (wasWaiting) await settle($)
    }
  })

  on('turn.complete', async ($, e, next) => {
    inFlight.clear()
    waitingIds.clear()
    isPromptUp = false
    await writeMe($, { state: 'done', snippet: await mySnippet($) })
    void refresh($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writeMe($, { state: 'ended' })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || isCollapsed || deck.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const perRow = Math.max(1, Math.floor(e.props.bodyColumns / (CARD_WIDTH + 1)))
    const shown = deck.slice(0, perRow * 2)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {shown.map(card => {
            const isMe = card.link === meLink
            return (
              <Box
                key={`card:${card.id}`}
                flexDirection="column"
                width={CARD_WIDTH}
                borderStyle="round"
                borderColor={isMe ? 'cyan' : undefined}
                borderDimColor={!isMe}
                paddingX={1}
              >
                <Box flexDirection="row" justifyContent="space-between">
                  <Box flexDirection="row" gap={1} overflow="hidden">
                    <Text color={lampColor(card.state)}>●</Text>
                    <Button
                      key={`jump:${card.id}`}
                      plain
                      label={card.label}
                      onPress={() => void (isMe ? Promise.resolve() : jump($, card))}
                    />
                  </Box>
                  <Button key={`hide:${card.id}`} plain dimColor label="×" onPress={() => void hide($, card)} />
                </Box>
                {card.state === 'waiting' ? (
                  <Text color="red">{lampWord(card.state)}</Text>
                ) : (
                  <Text dimColor wrap="truncate-end">
                    {card.gist || lampWord(card.state)}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
        {deck.length > shown.length && (
          <Text dimColor>
            {' '}+{deck.length - shown.length} till
          </Text>
        )}
      </Box>
    )
  })
}
