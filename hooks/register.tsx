import type { Register, EngineInterface, PluginOptions } from 'claude-code'

// switchboard: a band above the prompt with one small card per session you
// are working in right now.
//
// The mod runs in every session, and each session writes one JSON file about
// itself to ~/.claude/switchboard/sessions/<id>.json: its title and link from
// the desktop app, its exact state from the hooks below, the open question
// with its options, the prompt suggestion, and the engine session id that
// $.session.send addresses. Every session's band reads that folder.
//
// A card exists because you wrote in that session. It appears at your first
// prompt there, stays while the session lives and you have written in it
// within the window (red ones stay until handled), and goes when you press ×,
// when the session ends, or when its heartbeat stops.
//
// A place on the board belongs to a project, not a session: the first card of
// a folder takes the next free place, and a later session in the same folder
// sits with it. So a hand-off, which starts a fresh session in the same folder
// with a brief the old one wrote, lands where the old card was.

type State = 'working' | 'done' | 'waiting' | 'ended'

type Question = { text: string; options: string[] }

type Own = {
  id: string // the app's session id (local_...), the card's identity
  engineId: string // what $.session.id() answers; the send address
  title: string
  link: string
  cwd: string
  state: State
  snippet: string
  question: Question | null
  suggestion: string | null
  lastPromptAt: number
  updatedAt: number
  isRetired?: boolean // handed off to a new session; off the board for good
}

type Card = Own & { label: string; gist: string }

type Mini = { key: string; label: string; gist: string }

const POLL_MS = 3_000
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000
const LABEL_MAX = 18
const GIST_MAX = 22
const LABEL_ASK = 16
const GIST_ASK = 20
const PER_ROW = 3
const MIN_CARD = 24
const MAX_CARD = 40
// a message from another switchboard: consumed by the receiving mod, and
// either submitted as the person's own prompt there or, for HANDOFF, acted on
const RELAY = '[switchboard] '
const HANDOFF = 'handoff'

const HANDOFF_ASK =
  'Summarize our work and conversation so far so it can be handed to a new session with a fresh context: ' +
  'the goal, what has been done, the decisions made and why, the current state of the code or files, ' +
  'open problems, and the next steps. Write it as a brief for someone who has not seen this conversation. ' +
  'Reply with the brief only.'

let home = ''
let ownDir = ''
let me: Own | null = null
let hasPrompted = false
let heldTurnId: string | null = null
let isHandingOff = false
// ⇢ takes two presses: the first arms it for a few seconds, the second fires
let armedId: string | null = null
const ARM_MS = 4_000
// ↩ opens the card's answer on its second row: the question's options, or
// the prompt suggestion with a send button; it closes on its own
let openId: string | null = null
const OPEN_MS = 12_000
let deck: Card[] = []
let lastDeckJson = ''
let isCollapsed = false
let isPolling = false
let isSummarizing = false
let hidden: Record<string, number> = {}
let minis: Record<string, Mini> = {}
let slots: string[] = [] // folders, in the order their first card appeared
let order: string[] = [] // session ids, in the order they first appeared

// Tool calls in flight and which of them have a dialog up. Several tools can
// run at once, so one call ending must not clear another call's wait.
const inFlight = new Map<string, { tool: string; input: string }>()
const waitingIds = new Set<string>()
let isPromptUp = false

// --- options -----------------------------------------------------------------

let windowMs = 8 * 60 * 60 * 1000
let maxCards = 6
let shouldSummarize = true
let summaryModel = 'haiku'

function readOptions(options: PluginOptions) {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)
  windowMs = num(options.window_hours, 8) * 60 * 60 * 1000
  maxCards = Math.min(12, num(options.max_cards, 6))
  shouldSummarize = options.summarize !== false
  summaryModel = typeof options.model === 'string' && options.model ? options.model : 'haiku'
}

// --- small helpers -------------------------------------------------------------

const trim = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, Math.max(1, n - 1)) + '…' : flat
}

const lampColor = (state: State) =>
  state === 'working' ? 'yellow' : state === 'waiting' ? 'red' : state === 'done' ? 'green' : 'gray'

const stateWord = (state: State) =>
  state === 'working' ? 'working' : state === 'waiting' ? 'needs you' : state === 'done' ? 'done' : 'ended'

const mcpText = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')

// The AskUserQuestion input, cut down to the first question and its labels.
function toQuestion(input: unknown): Question | null {
  const q = (input as { questions?: { question?: string; options?: { label?: string }[] }[] })?.questions?.[0]
  if (!q?.question) return null
  const options = (q.options ?? [])
    .map(o => o.label ?? '')
    .filter(Boolean)
    .slice(0, 4)
  return { text: q.question, options }
}

async function init($: EngineInterface) {
  if (home) return
  home = (await $.env.get('HOME')) ?? '/tmp'
  ownDir = `${home}/.claude/switchboard/sessions`
  hidden = ((await $.store.get('hidden')) as Record<string, number> | undefined) ?? {}
  minis = ((await $.store.get('minis-v2')) as Record<string, Mini> | undefined) ?? {}
  slots = ((await $.store.get('slots')) as string[] | undefined) ?? []
  order = ((await $.store.get('order')) as string[] | undefined) ?? []
}

// --- this session's own file --------------------------------------------------

// The app knows this session's id, title and link; the engine's own id is the
// transcript's name and differs after a resume.
async function selfApp($: EngineInterface): Promise<{ sessionId?: string; title?: string; link?: string } | null> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (r.isError) return null
    return JSON.parse(mcpText(r)) as { sessionId?: string; title?: string; link?: string }
  } catch {
    return null
  }
}

async function writeMe($: EngineInterface, patch: Partial<Own> = {}) {
  if (!me || !hasPrompted) return
  me = { ...me, ...patch, updatedAt: await $.clock.now() }
  try {
    await $.fs.write(`${ownDir}/${me.id}.json`, JSON.stringify(me))
  } catch {
    // unwritable folder: the band still knows this session from memory
  }
}

const settle = ($: EngineInterface) =>
  writeMe($, { state: waitingIds.size > 0 || isPromptUp ? 'waiting' : 'working' })

async function lastReply($: EngineInterface) {
  const last = [...(await $.session.messages())].reverse().find(m => m.role === 'assistant' && m.text.trim())
  return last ? last.text.trim() : ''
}

const mySnippet = async ($: EngineInterface) => trim(await lastReply($), 80)

// The heartbeat: proves the session is alive, and picks up a title the app
// gave the session after its first prompt.
async function heartbeat($: EngineInterface) {
  if (!me || !hasPrompted) return
  const self = await selfApp($)
  await writeMe($, self?.title ? { title: self.title } : {})
}

// --- every session's file -----------------------------------------------------

async function readAll($: EngineInterface): Promise<Own[]> {
  const all = new Map<string, Own>()
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(ownDir)
  } catch {
    return me && hasPrompted ? [me] : []
  }
  const now = await $.clock.now()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const o = JSON.parse(await $.fs.read(`${ownDir}/${entry.name}`)) as Own
      // a process that died mid-turn never wrote 'ended'; the heartbeat tells
      if (o.state !== 'ended' && now - o.updatedAt > STALE_MS) o.state = 'ended'
      all.set(o.id, o)
    } catch {
      // half-written file: skip it this round
    }
  }
  if (me && hasPrompted) all.set(me.id, me)
  return [...all.values()]
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

// --- the deck -------------------------------------------------------------------

async function buildDeck($: EngineInterface): Promise<Card[]> {
  const now = await $.clock.now()
  const cards: Card[] = []
  for (const o of await readAll($)) {
    if (o.state === 'ended' || o.isRetired) continue
    const hiddenAt = hidden[o.id]
    if (hiddenAt !== undefined && o.lastPromptAt <= hiddenAt) continue
    // a red card stays until handled; the others fall off after the window
    if (o.state !== 'waiting' && now - o.lastPromptAt > windowMs) continue
    const mini = minis[o.id]
    cards.push({
      ...o,
      label: mini?.label ?? trim(o.title, LABEL_MAX),
      gist: mini?.gist ?? trim(o.snippet, GIST_MAX),
    })
  }

  // a folder keeps its place; within it, sessions keep the order they came in
  const newSlots = cards.map(c => c.cwd).filter((cwd, i, all) => !slots.includes(cwd) && all.indexOf(cwd) === i)
  if (newSlots.length > 0) {
    slots = [...slots, ...newSlots].slice(-32)
    await $.store.set('slots', slots)
  }
  const fresh = cards.map(c => c.id).filter(id => !order.includes(id))
  if (fresh.length > 0) {
    order = [...order, ...fresh].slice(-64)
    await $.store.set('order', order)
  }
  cards.sort(
    (a, b) => slots.indexOf(a.cwd) - slots.indexOf(b.cwd) || order.indexOf(a.id) - order.indexOf(b.id),
  )
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

// × hides the card until you write in that session again
async function hide($: EngineInterface, card: Card) {
  hidden = { ...hidden, [card.id]: card.lastPromptAt }
  await $.store.set('hidden', hidden)
  await refresh($)
}

// Sends text to a session that runs this mod; its session.receive hook takes
// the relay, ends any wait and submits the text as the person's own prompt.
async function relay($: EngineInterface, card: Card, text: string) {
  const sent = await $.session.send({ to: { sessionId: card.engineId }, text: RELAY + text })
  $.ui.toast(sent.isDelivered ? `Sent to ${card.label}: ${trim(text, 40)}` : `Not delivered: ${sent.reason}`)
}

// What a relay does on arrival, also run directly for this session's own card:
// end a turn that is waiting on a dialog, then submit the text as the person's
// own prompt, so it answers the question instead of queueing behind it.
async function applyAnswer($: EngineInterface, text: string) {
  if (heldTurnId && (me?.question || me?.state === 'waiting')) {
    try {
      await $.turn.abort({ turnId: heldTurnId })
    } catch {
      // the turn had already ended; the prompt below runs when idle
    }
  }
  void $.prompt.submit({ text, asUser: true })
}

// Sends an answer to a card's session: through the relay for another
// session, directly for this one.
async function answer($: EngineInterface, card: Card, isMe: boolean, text: string) {
  openId = null
  $.ui.invalidate('ui.render')
  if (isMe) {
    await applyAnswer($, text)
    $.ui.toast(`Switchboard: ${trim(text, 40)}`)
  } else {
    await relay($, card, text)
  }
}

// ↩: opens the answer row when the card has something to answer with.
function pressAnswer($: EngineInterface, card: Card) {
  const hasOptions = card.question !== null && card.question.options.length > 0
  if (!hasOptions && !card.suggestion) {
    $.ui.toast(card.question ? 'That question has no options; open the session' : 'Nothing to answer there yet')
    return
  }
  openId = openId === card.id ? null : card.id
  $.ui.invalidate('ui.render')
  if (openId === card.id) {
    $.clock.after(OPEN_MS, () => {
      if (openId === card.id) {
        openId = null
        $.ui.invalidate('ui.render')
      }
    })
  }
}

// --- hand-off: this session writes a brief, a fresh one starts from it -------

// Step one, in the session being handed off: ask for the brief. The turn
// that answers it finishes the job in finishHandoff.
async function startHandoff($: EngineInterface) {
  if (isHandingOff) return
  isHandingOff = true
  $.ui.toast('Hand-off: writing the brief…')
  if (heldTurnId) {
    try {
      await $.turn.abort({ turnId: heldTurnId })
    } catch {
      // the turn had already ended; the prompt below runs when idle
    }
  }
  void $.prompt.submit({ text: HANDOFF_ASK, asUser: true })
}

// Step two: start a fresh session in the same folder with the brief as its
// first prompt, let it stand on its own in the sidebar, and retire this card.
// The new session's card takes this folder's place on the board.
async function finishHandoff($: EngineInterface) {
  if (!me) return
  const brief = await lastReply($)
  if (!brief) {
    isHandingOff = false
    $.ui.toast('Hand-off: no brief was written')
    return
  }
  try {
    const r = await $.mcp.call('ccd_session', 'start_session', {
      initiation: 'user_asked',
      context: 'fresh',
      title: trim(me.title.replace(/ \(continued\)$/, ''), 50) + ' (continued)',
      prompt: `This session continues an earlier one in the same folder. Brief from the previous session:\n\n${brief}\n\nPick up from the next steps.`,
      background:
        `Started by the switchboard mod as a hand-off from the session "${me.title}" in ${me.cwd}, ` +
        'whose context was getting long. The prompt is the brief that session wrote about its own work; ' +
        'treat it as the whole history.',
      use_worktree: false,
    })
    const text = mcpText(r)
    if (r.isError) throw new Error(text)
    const newId = text.match(/local_[0-9a-f-]+/)?.[0]
    if (newId) {
      // off the parent's thread in the sidebar: it is a continuation, not a side task
      try {
        await $.mcp.call('ccd_session_mgmt', 'detach_session', { session_id: newId })
      } catch {
        // stays nested; the board does not care
      }
    }
    await writeMe($, { isRetired: true })
    $.ui.toast('Handed off to a new session; this card retires')
    void jumpTo($, newId)
  } catch (error) {
    $.ui.toast(`Hand-off failed: ${trim(String(error), 60)}`)
  } finally {
    isHandingOff = false
  }
}

// The first press on ⇢ arms the card's hand-off and shows it plainly; the
// second, within ARM_MS, runs it. A press elsewhere, or time, disarms.
function pressHandoff($: EngineInterface, card: Card, isMe: boolean) {
  if (armedId !== card.id) {
    armedId = card.id
    $.ui.invalidate('ui.render')
    $.clock.after(ARM_MS, () => {
      if (armedId === card.id) {
        armedId = null
        $.ui.invalidate('ui.render')
      }
    })
    return
  }
  armedId = null
  $.ui.invalidate('ui.render')
  void (isMe ? startHandoff($) : relay($, card, HANDOFF))
}

async function jumpTo($: EngineInterface, appId: string | undefined) {
  if (!appId) return
  try {
    await $.process.run(['open', `claude://claude.ai/epitaxy/${appId}`])
  } catch {
    // the new session is in the sidebar either way
  }
}

// --- the band -----------------------------------------------------------------

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    await init($)
    const self = await selfApp($)
    const engineId = await $.session.id()
    const id = self?.sessionId ?? `local_${engineId}`
    const now = await $.clock.now()
    // Nothing is written until you prompt here: opening an old session to
    // look something up wakes its process, and that alone is not working in it.
    hasPrompted = false
    me = {
      id,
      engineId,
      title: self?.title ?? 'Untitled session',
      link: self?.link ?? `claude://claude.ai/epitaxy/${id}`,
      cwd: e.cwd,
      state: 'done',
      snippet: await mySnippet($),
      question: null,
      suggestion: null,
      lastPromptAt: now,
      updatedAt: now,
    }

    await $.command.register({ name: 'board', description: 'Show or hide the switchboard band', immediate: true })

    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    isCollapsed = !isCollapsed
    $.ui.invalidate('ui.render')
    return {}
  })

  // Your first prompt is what puts this session on the board.
  on('prompt.submit', async ($, e, next) => {
    hasPrompted = true
    await writeMe($, { state: 'working', suggestion: null, lastPromptAt: await $.clock.now() })
    return next(e)
  })

  // A turn that starts without prompt.submit (a session started with a brief)
  // still means someone wrote here.
  on('turn.start', async ($, e, next) => {
    heldTurnId = e.turnId
    const isFirst = !hasPrompted
    hasPrompted = true
    await writeMe($, { state: 'working', suggestion: null, ...(isFirst ? { lastPromptAt: await $.clock.now() } : {}) })
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
    const {
      tool,
      tool_use_id,
      agentId: _agent,
      ...input
    } = e as Record<string, unknown> & {
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
  // HANDOFF starts the hand-off here; any other text answers an open question
  // or runs as a prompt, the waiting turn ended first so it does not queue
  // behind the dialog.
  on('session.receive', async ($, e, next) => {
    if (!e.text.startsWith(RELAY) || e.agentId !== undefined) return next(e)
    const text = e.text.slice(RELAY.length).trim()
    if (!text) return { consumed: 'empty switchboard relay' }
    if (text === HANDOFF) {
      void startHandoff($)
      return { consumed: 'switchboard hand-off started' }
    }
    await applyAnswer($, text)
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
    // the turn that wrote the brief: start the new session from it
    if (isHandingOff) void finishHandoff($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writeMe($, { state: 'ended', question: null, suggestion: null })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || isCollapsed || deck.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // three cards across; each is two rows inside a thin frame: the lamp,
    // label, hand-off and ×, then the gist
    const cardWidth = Math.max(
      MIN_CARD,
      Math.min(MAX_CARD, Math.floor((e.props.bodyColumns - (PER_ROW - 1) * 2) / PER_ROW)),
    )
    const inner = cardWidth - 4 // less the frame and its padding
    const labelMax = Math.max(8, inner - 8) // room for ⇢ ↩ ×

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {deck.map(card => {
          const isMe = me !== null && card.id === me.id
          const isOpen = openId === card.id
          const options = card.question?.options ?? []
          return (
            // a thin frame around the whole card: dim, full strength on this
            // session, and the surface brightens it under the pointer by itself
            <Box
              key={`card:${card.id}`}
              flexDirection="column"
              width={cardWidth}
              paddingX={1}
              borderStyle="round"
              borderDimColor={!isMe}
              hover={{ borderDimColor: false }}
            >
              <Box flexDirection="column" width={inner}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Box flexDirection="row" gap={1} overflow="hidden">
                    <Text color={lampColor(card.state)}>●</Text>
                    <Button
                      key={`jump:${card.id}`}
                      plain
                      label={trim(card.label, labelMax)}
                      onPress={() => void (isMe ? Promise.resolve() : jump($, card))}
                    />
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    {armedId === card.id ? (
                      <Button
                        key={`handoff:${card.id}`}
                        variant="primary"
                        label="hand off"
                        onPress={() => pressHandoff($, card, isMe)}
                      />
                    ) : (
                      <Button
                        key={`handoff:${card.id}`}
                        plain
                        dimColor
                        label="⇢"
                        onPress={() => pressHandoff($, card, isMe)}
                      />
                    )}
                    <Button
                      key={`reply:${card.id}`}
                      plain
                      dimColor={!isOpen}
                      label="↩"
                      onPress={() => pressAnswer($, card)}
                    />
                    <Button key={`hide:${card.id}`} plain dimColor label="×" onPress={() => void hide($, card)} />
                  </Box>
                </Box>
                {isOpen && options.length > 0 ? (
                  // the answer row: the question's options, each one press
                  <Box flexDirection="row" gap={1} overflow="hidden">
                    {options.slice(0, 3).map(label => (
                      <Button
                        key={`answer:${card.id}:${label}`}
                        plain
                        label={trim(label, Math.floor(inner / Math.min(3, options.length)) - 1)}
                        onPress={() => void answer($, card, isMe, label)}
                      />
                    ))}
                    {options.length > 3 && <Text dimColor>…</Text>}
                  </Box>
                ) : isOpen && card.suggestion ? (
                  // the answer row: the suggestion in that session's prompt box
                  <Box flexDirection="row" gap={1} overflow="hidden">
                    <Button
                      key={`suggest:${card.id}`}
                      variant="primary"
                      label="send"
                      onPress={() => void answer($, card, isMe, card.suggestion ?? '')}
                    />
                    <Text dimColor wrap="truncate-end">
                      {trim(card.suggestion, inner - 9)}
                    </Text>
                  </Box>
                ) : card.state === 'waiting' ? (
                  <Text color="red" wrap="truncate-end">
                    {card.question ? trim(card.question.text, inner) : 'needs you'}
                  </Text>
                ) : (
                  <Text dimColor wrap="truncate-end">
                    {card.gist || stateWord(card.state)}
                  </Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
