import type { Register, EngineInterface, PluginOptions } from 'claude-code'

// switchboard: a band above the prompt with one card per recent session, and
// a detail strip under the cards that fills in when you hover one.
//
// Sources, merged per app session id:
//  1. The desktop app's session list ($.mcp.call on ccd_session_mgmt): title,
//     cwd, isRunning, lastActivityAt and the claude:// link that opens it.
//  2. The session's transcript on disk (~/.claude/projects/<cwd>/<id>.jsonl):
//     the last reply, and a tool call left unanswered, which from the outside
//     is what a permission dialog or an open question looks like.
//  3. For a session running this mod, its own exact state, written to
//     ~/.claude/switchboard/sessions/<id>.json by the hooks below: the open
//     question with its options, the prompt suggestion, the engine session id
//     that $.session.send addresses.
//  4. A small model turns title + last reply into a short label and gist,
//     cached in $.store so each pair is summarized once.
//
// Cards keep their place: the order they first appeared in is stored, and a
// new session is added at the end. Nothing moves when activity changes.

type State = 'working' | 'done' | 'waiting' | 'ended'

type Question = { text: string; options: string[] }

type Card = {
  id: string // the app's session id (local_...)
  engineId: string | null // what $.session.id() answers there; the send address
  title: string
  label: string
  gist: string
  cwd: string
  link: string
  state: State
  snippet: string
  question: Question | null
  suggestion: string | null
  lastActivityAt: number
  isExact: boolean // the mod runs in that session
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
  engineId: string
  state: State
  snippet: string
  question: Question | null
  suggestion: string | null
  updatedAt: number
}

type Tail = { path: string; mtimeMs: number; snippet: string; hasPendingTool: boolean; question: Question | null }

type Mini = { key: string; label: string; gist: string }

const POLL_MS = 3_000
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000
const CARD_WIDTH = 28
const DETAIL_ROWS = 4
const LABEL_MAX = 18
const GIST_MAX = 22
const LABEL_ASK = 16
const GIST_ASK = 20
const TAIL_BYTES = '80000'
// a tool call left unanswered this long, in a session without the mod, is
// read as a dialog; shorter and a slow Bash command looks the same
const WAITING_IDLE_MS = 20_000
// a message from another switchboard: consumed by the receiving mod and
// submitted as the person's own prompt there
const RELAY = '[switchboard] '

let home = ''
let ownDir = ''
let me: Own | null = null
let heldTurnId: string | null = null
let deck: Card[] = []
let lastDeckJson = ''
let isCollapsed = false
let isPolling = false
let isSummarizing = false
let hidden: Record<string, number> = {}
let minis: Record<string, Mini> = {}
let order: string[] = []
const tails = new Map<string, Tail>()

// Tool calls in flight and which of them have a dialog up. Several tools can
// run at once, so one call ending must not clear another call's wait.
const inFlight = new Map<string, { tool: string; input: string }>()
const waitingIds = new Set<string>()
let isPromptUp = false

// --- options -----------------------------------------------------------------

let windowMs = 12 * 60 * 60 * 1000
let maxCards = 8
let shouldSummarize = true
let summaryModel = 'haiku'

function readOptions(options: PluginOptions) {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)
  windowMs = num(options.window_hours, 12) * 60 * 60 * 1000
  maxCards = Math.min(16, num(options.max_cards, 8))
  shouldSummarize = options.summarize !== false
  summaryModel = typeof options.model === 'string' && options.model ? options.model : 'haiku'
}

// --- small helpers -------------------------------------------------------------

const trim = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

const lampColor = (state: State) =>
  state === 'working' ? 'yellow' : state === 'waiting' ? 'red' : state === 'done' ? 'green' : 'gray'

const stateWord = (state: State) =>
  state === 'working' ? 'working' : state === 'waiting' ? 'needs you' : state === 'done' ? 'done' : 'ended'

const mcpText = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')

// The AskUserQuestion input, cut down to the first question and its labels.
function toQuestion(input: unknown): Question | null {
  const q = (input as { questions?: { question?: string; options?: { label?: string }[] }[] })?.questions?.[0]
  if (!q?.question) return null
  const options = (q.options ?? []).map(o => o.label ?? '').filter(Boolean).slice(0, 4)
  return { text: q.question, options }
}

async function init($: EngineInterface) {
  if (home) return
  home = (await $.env.get('HOME')) ?? '/tmp'
  ownDir = `${home}/.claude/switchboard/sessions`
  hidden = ((await $.store.get('hidden')) as Record<string, number> | undefined) ?? {}
  minis = ((await $.store.get('minis-v2')) as Record<string, Mini> | undefined) ?? {}
  order = ((await $.store.get('order')) as string[] | undefined) ?? []
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

const settle = ($: EngineInterface) =>
  writeMe($, { state: waitingIds.size > 0 || isPromptUp ? 'waiting' : 'working' })

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

// The transcript of an app session: the file named by its id when there is
// one, else the .jsonl in its project folder whose mtime sits closest to the
// app's last activity (several sessions share a cwd).
async function pickTranscript($: EngineInterface, s: AppSession): Promise<{ path: string; mtimeMs: number } | null> {
  const dir = projectDir(s.cwd)
  let entries: { name: string; kind: string; mtimeMs: number }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return null
  }
  const named = entries.find(e => e.name === `${s.sessionId.replace(/^local_/, '')}.jsonl`)
  if (named) return { path: `${dir}/${named.name}`, mtimeMs: named.mtimeMs }

  const at = Date.parse(s.lastActivityAt)
  let best: { path: string; mtimeMs: number } | null = null
  let bestGap = Infinity
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
    const gap = Math.abs(e.mtimeMs - at)
    if (gap < bestGap) {
      bestGap = gap
      best = { path: `${dir}/${e.name}`, mtimeMs: e.mtimeMs }
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
  const pending = new Map<string, { name: string; input: unknown }>()
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
    for (const block of content as { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }[]) {
      if (r.type === 'assistant' && block.type === 'text' && block.text?.trim()) snippet = block.text
      if (r.type === 'assistant' && block.type === 'tool_use' && block.id) pending.set(block.id, { name: block.name ?? '', input: block.input })
      if (r.type === 'user' && block.type === 'tool_result' && block.tool_use_id) pending.delete(block.tool_use_id)
    }
  }
  const ask = [...pending.values()].find(p => p.name === 'AskUserQuestion')
  const tail: Tail = {
    path: picked.path,
    mtimeMs: picked.mtimeMs,
    snippet: trim(snippet, 80),
    hasPendingTool: pending.size > 0,
    question: ask ? toQuestion(ask.input) : null,
  }
  tails.set(s.sessionId, tail)
  return tail
}

// --- short labels from a small model ----------------------------------------

const miniKey = (title: string, snippet: string) => `${title}\u0000${snippet}`

// One card at a time, so a burst of activity costs one small call per poll
// and never blocks the band.
async function summarizeNext($: EngineInterface) {
  if (!shouldSummarize || isSummarizing) return
  const card = deck.find(c => c.state !== 'working' && minis[c.id]?.key !== miniKey(c.title, c.snippet))
  if (!card) return
  isSummarizing = true
  try {
    const folder = card.cwd.split('/').pop() ?? ''
    const r = await $.model.complete({
      model: summaryModel,
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
    if (!s.isRunning && now - at > windowMs) continue
    const hiddenAt = hidden[s.sessionId]
    if (hiddenAt !== undefined && at <= hiddenAt) continue

    const link = s.link ?? `claude://claude.ai/epitaxy/${s.sessionId}`
    const exact = own.get(s.sessionId)
    let state: State
    let snippet = ''
    let question: Question | null = null
    let suggestion: string | null = null
    let engineId: string | null = null
    if (exact) {
      state = exact.state
      snippet = exact.snippet
      question = exact.question
      suggestion = exact.suggestion
      engineId = exact.engineId
    } else {
      const tail = await readTail($, s)
      snippet = tail?.snippet ?? ''
      question = tail?.question ?? null
      engineId = tail ? (tail.path.split('/').pop() ?? '').replace(/\.jsonl$/, '') || null : null
      const idleMs = tail ? now - tail.mtimeMs : Infinity
      if (tail?.hasPendingTool && idleMs > WAITING_IDLE_MS) state = 'waiting'
      else if (s.isRunning || idleMs < 15_000) state = 'working'
      else state = 'done'
    }
    const title = s.title || 'Untitled session'
    const mini = minis[s.sessionId]
    cards.push({
      id: s.sessionId,
      engineId,
      title,
      label: mini?.label ?? trim(title, LABEL_MAX),
      gist: mini?.gist ?? trim(snippet, GIST_MAX),
      cwd: s.cwd,
      link,
      state,
      snippet,
      question,
      suggestion,
      lastActivityAt: at,
      isExact: !!exact,
    })
  }

  // keep each card where it first appeared; a new one goes last
  const fresh = cards.map(c => c.id).filter(id => !order.includes(id))
  if (fresh.length > 0) {
    order = [...order, ...fresh].slice(-64)
    await $.store.set('order', order)
  }
  cards.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return cards.slice(0, maxCards)
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

// --- actions on another session --------------------------------------------

async function jump($: EngineInterface, card: Card) {
  try {
    const r = await $.process.run(['open', card.link])
    if (r.exitCode !== 0) throw new Error(r.stderr)
  } catch {
    await $.ui.copy({ text: card.link })
    $.ui.toast('Could not open the session; its link is on the clipboard')
  }
}

// × hides the card until that session shows new activity
async function hide($: EngineInterface, card: Card) {
  hidden = { ...hidden, [card.id]: card.lastActivityAt }
  await $.store.set('hidden', hidden)
  await refresh($)
}

// Sends text to a session that runs this mod; its session.receive hook takes
// the relay, ends any wait and submits the text as the person's own prompt.
async function relay($: EngineInterface, card: Card, text: string) {
  if (!card.engineId) {
    $.ui.toast('No address for that session yet')
    return
  }
  const sent = await $.session.send({ to: { sessionId: card.engineId }, text: RELAY + text })
  $.ui.toast(sent.isDelivered ? `Sent to ${card.label}: ${trim(text, 40)}` : `Not delivered: ${sent.reason}`)
}

// --- the band -----------------------------------------------------------------

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    await init($)
    const self = await selfApp($)
    const engineId = await $.session.id()
    const id = self?.sessionId ?? `local_${engineId}`
    me = { id, engineId, state: 'done', snippet: await mySnippet($), question: null, suggestion: null, updatedAt: await $.clock.now() }
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
    await writeMe($, { state: 'working', suggestion: null })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    heldTurnId = e.turnId
    await writeMe($, { state: 'working', suggestion: null })
    return next(e)
  })

  // The dim suggestion in the prompt box: what another switchboard can send
  // on your behalf with one press.
  on('prompt.suggest', async ($, e, next) => {
    const shown = await next(e)
    if (shown.isShown) await writeMe($, { suggestion: e.text })
    return shown
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

  // A question to the person is a wait too, and its options go on the card.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const question = toQuestion(e)
    waitingIds.add(e.tool_use_id)
    await writeMe($, { state: 'waiting', question })
    try {
      return await next(e)
    } finally {
      waitingIds.delete(e.tool_use_id)
      await writeMe($, { state: waitingIds.size > 0 ? 'waiting' : 'working', question: null })
    }
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

  // A relay from another switchboard: never shown to Claude as a message.
  // If a question is open here, the turn is ended first, so the text answers
  // it as a fresh prompt instead of queueing behind the dialog.
  on('session.receive', async ($, e, next) => {
    if (!e.text.startsWith(RELAY) || e.agentId !== undefined) return next(e)
    const text = e.text.slice(RELAY.length).trim()
    if (!text) return { consumed: 'empty switchboard relay' }
    if (heldTurnId && (me?.question || me?.state === 'waiting')) {
      try {
        await $.turn.abort({ turnId: heldTurnId })
      } catch {
        // the turn had already ended; the prompt below runs when idle
      }
    }
    void $.prompt.submit({ text, asUser: true })
    $.ui.toast(`Switchboard: ${trim(text, 40)}`)
    return { consumed: 'switchboard relay submitted as a prompt' }
  })

  on('turn.complete', async ($, e, next) => {
    heldTurnId = null
    inFlight.clear()
    waitingIds.clear()
    isPromptUp = false
    await writeMe($, { state: 'done', question: null, snippet: await mySnippet($) })
    void refresh($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writeMe($, { state: 'ended', question: null, suggestion: null })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || isCollapsed || deck.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const detailWidth = Math.max(40, Math.min(columns, 100))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {deck.map(card => {
            const isMe = me !== null && card.id === me.id
            return (
              <Box
                key={`card:${card.id}`}
                hover={{ scope: `sb:${card.id}` }}
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
                  <Text color="red">{card.question ? 'asks you' : 'needs you'}</Text>
                ) : (
                  <Text dimColor wrap="truncate-end">
                    {card.gist || stateWord(card.state)}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        {/* The detail strip: the same height always; a hovered card fills it. */}
        <Box key="detail" height={DETAIL_ROWS} width={detailWidth} flexDirection="column" paddingX={1}>
          <Text dimColor>
            <Text color="yellow">●</Text> working <Text color="green">●</Text> done <Text color="red">●</Text> needs you{' '}
            <Text color="gray">●</Text> ended · hover a card for details, click its name to go there
          </Text>
          {deck.map(card => {
            const canRelay = card.isExact && card.engineId !== null && !(me && card.id === me.id)
            return (
              <Box
                key={`detail:${card.id}`}
                position="absolute"
                top={0}
                left={0}
                width={detailWidth}
                height={DETAIL_ROWS}
                display="none"
                hover={{ scope: `sb:${card.id}`, display: 'flex' }}
                flexDirection="column"
                paddingX={1}
                borderStyle="round"
                borderColor={lampColor(card.state)}
              >
                <Box flexDirection="row" gap={1}>
                  <Text color={lampColor(card.state)}>●</Text>
                  <Text bold wrap="truncate-end">
                    {card.title}
                  </Text>
                  <Text dimColor>{stateWord(card.state)}</Text>
                </Box>
                {card.question ? (
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Text wrap="truncate-end">{trim(card.question.text, detailWidth - 4)}</Text>
                    {canRelay
                      ? card.question.options.map(label => (
                          <Button key={`answer:${card.id}:${label}`} label={label} onPress={() => void relay($, card, label)} />
                        ))
                      : card.question.options.length > 0 && <Text dimColor>open the session to answer</Text>}
                  </Box>
                ) : (
                  <Text dimColor wrap="truncate-end">
                    {card.snippet || stateWord(card.state)}
                  </Text>
                )}
                {!card.question && card.suggestion && canRelay && (
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key={`suggest:${card.id}`}
                      variant="primary"
                      label="Send suggestion"
                      onPress={() => void relay($, card, card.suggestion ?? '')}
                    />
                    <Text dimColor wrap="truncate-end">
                      {trim(card.suggestion, detailWidth - 22)}
                    </Text>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
