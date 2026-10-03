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
const INBOX_MS = 1_000
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000
const LABEL_MAX = 18
const GIST_MAX = 22
const LABEL_ASK = 16
const GIST_ASK = 20
const SNIPPET_MAX = 400 // of the latest reply, kept for the expanded card
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
let handoffTurnId: string | null = null // the turn that writes the brief
// the previous session's model, for a session the hand-off link opened: each
// request goes there from the start, and /model follows once no turn runs
let wantedModel: string | null = null
let isTurnRunning = false
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
type AppSession = { sessionId?: string; title?: string; link?: string; cwd?: string; model?: string; isArchived?: boolean }

async function selfApp($: EngineInterface): Promise<AppSession | null> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (r.isError) return null
    return JSON.parse(mcpText(r)) as AppSession
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

const mySnippet = async ($: EngineInterface) => trim(await lastReply($), SNIPPET_MAX)

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

// the label and gist are made for this title, reply and open question; a
// change in any of them is a new pair to summarize
const miniKey = (card: Pick<Card, 'title' | 'snippet' | 'question'>) =>
  `${card.title}\u0000${card.snippet}\u0000${card.question?.text ?? ''}`

// One card at a time, so a burst of activity costs one small call per poll
// and never blocks the band.
async function summarizeNext($: EngineInterface) {
  if (!shouldSummarize || isSummarizing) return
  const card = deck.find(c => c.state !== 'working' && minis[c.id]?.key !== miniKey(c))
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
      prompt:
        `Project folder: ${folder}\nSession title: ${card.title}\nLatest reply from Claude: ${card.snippet || '(nothing yet)'}` +
        (card.question ? `\nOpen question to the person right now (the gist should say what is asked): ${card.question.text}` : ''),
    })
    if (r.isAnswered) {
      const match = r.text.match(/\{[\s\S]*\}/)
      const parsed = match ? (JSON.parse(match[0]) as { label?: string; gist?: string }) : {}
      const mini: Mini = {
        key: miniKey(card),
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

// Leaves text in the inbox of a session that runs this mod. Its own poll
// picks it up within a second and acts on it: a hand-off, or an answer it
// submits as the person's own prompt. A file, not $.session.send, because a
// send from a mod has no model request behind it for auto mode's permission
// classifier to judge, and it is refused.
const inboxPath = (id: string) => `${home}/.claude/switchboard/inbox/${id}.json`

async function readInbox($: EngineInterface, id: string): Promise<string[]> {
  try {
    if (!(await $.fs.exists(inboxPath(id)))) return []
    const parsed = JSON.parse(await $.fs.read(inboxPath(id))) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

async function relay($: EngineInterface, card: Card, text: string) {
  try {
    const waiting = await readInbox($, card.id)
    await $.fs.write(inboxPath(card.id), JSON.stringify([...waiting, text]))
    $.ui.toast(`Sent to ${card.label}: ${trim(text, 40)}`)
  } catch (error) {
    $.ui.toast(`Not delivered: ${trim(String(error), 60)}`)
  }
}

// This session's side: whatever another switchboard left for it.
let isReadingInbox = false
async function pollInbox($: EngineInterface) {
  if (!me || isReadingInbox) return
  isReadingInbox = true
  try {
    const texts = await readInbox($, me.id)
    if (texts.length === 0) return
    await $.fs.write(inboxPath(me.id), '[]')
    for (const text of texts) {
      if (text === HANDOFF) {
        void startHandoff($)
      } else {
        await applyAnswer($, text)
        $.ui.toast(`Switchboard: ${trim(text, 40)}`)
      }
    }
  } finally {
    isReadingInbox = false
  }
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

// When the engine's own suggestion service says nothing within a moment of
// the turn ending, and the reply ends on a question or an offer, write the
// reply the person would most likely send to accept it, so ↩ has something.
async function suggestFallback($: EngineInterface, reply: string) {
  if (!shouldSummarize || !me || !hasPrompted) return
  const tail = reply.slice(-400)
  if (!/\?/.test(tail)) return
  const turnEndedAt = me.updatedAt
  $.clock.after(2_500, () => {
    void (async () => {
      if (!me || me.suggestion || me.state !== 'done' || me.lastPromptAt > turnEndedAt) return
      try {
        const r = await $.model.complete({
          model: summaryModel,
          effort: 'low',
          maxTokens: 60,
          timeoutMs: 10_000,
          system:
            'An assistant just ended its reply with a question or an offer. Write the one short message the person ' +
            'would most likely send back to accept it and let the work continue. Same language as the reply. ' +
            'One line, no quotes, no explanation.',
          prompt: tail,
        })
        if (r.isAnswered && r.text.trim() && me.state === 'done' && !me.suggestion) {
          await writeMe($, { suggestion: trim(r.text, 200) })
        }
      } catch {
        // no suggestion then; ↩ says so
      }
    })()
  })
}

// --- hand-off: this session writes a brief, a fresh one starts from it -------

// Step one, in the session being handed off: ask for the brief. The turn
// that answers it finishes the job in finishHandoff.
async function startHandoff($: EngineInterface) {
  if (isHandingOff) return
  isHandingOff = true
  handoffTurnId = null
  $.ui.log('hand-off: asking for the brief')
  $.ui.toast('Hand-off: writing the brief…')
  if (heldTurnId) {
    try {
      // ending the running turn raises its turn.complete; the brief's own
      // turn is the next one to start, and only that one finishes the hand-off
      await $.turn.abort({ turnId: heldTurnId })
    } catch {
      // the turn had already ended; the prompt below runs when idle
    }
  }
  void $.prompt.submit({ text: HANDOFF_ASK, asUser: true })
}

// A hand-off started through the app's link leaves this marker; the new
// session in that folder picks it up at start and takes the previous
// session's model. The opener itself arrives through the link, sent by the
// person's Enter: the app creates the session only then, so the mod cannot
// send it first, and must not send it again.
const pendingPath = () => `${home}/.claude/switchboard/handoff/pending.json`
// A session with no folder runs in a scratch workspace the app makes, and
// the app may make a fresh one for the session the link opens; two scratch
// workspaces count as the same place.
const isScratch = (p: string) => p.includes('/scratch-workspaces/')
const sameWorkspace = (a: string, b: string) => a === b || (isScratch(a) && isScratch(b))
const PENDING_MS = 10 * 60 * 1000

type Pending = { cwd?: string; model?: string; briefPath?: string; title?: string; at?: number }

// The marker is consumed once, by whichever of the start hooks reads it first.
let pendingRead: Promise<Pending | null> | null = null

function readPending($: EngineInterface): Promise<Pending | null> {
  pendingRead ??= (async () => {
    try {
      if (!(await $.fs.exists(pendingPath()))) return null
      const pending = JSON.parse(await $.fs.read(pendingPath())) as Pending
      const now = await $.clock.now()
      if (!pending.at || now - pending.at > PENDING_MS) return null
      await $.fs.write(pendingPath(), '{}')
      return pending
    } catch {
      return null
    }
  })()
  return pendingRead
}

// The brief, for the first turn's context: the new session reads it here,
// whatever folder the app put it in, so no file read is asked of the model.
async function briefContext($: EngineInterface): Promise<string | null> {
  const pending = await readPending($)
  if (!pending?.briefPath) return null
  try {
    const text = await $.fs.read(pending.briefPath)
    return `The switchboard mod handed this session off from the session "${pending.title ?? ''}". Its brief, also saved at ${pending.briefPath}:\n\n${text}`
  } catch {
    return null
  }
}

// /model <id> as the person would type it, which the app's indicator follows;
// run between turns only, and the model before and after says whether it took.
async function switchModel($: EngineInterface) {
  const wanted = wantedModel
  if (!wanted || isTurnRunning) return
  const before = await $.session.model()
  if (before === wanted) {
    wantedModel = null
    return
  }
  let note = ''
  try {
    const r = await $.command.run({ command: 'model', args: wanted })
    note = r.text ? trim(r.text, 120) : ''
  } catch (error) {
    note = trim(String(error), 120)
  }
  const after = await $.session.model()
  const tail = note ? ` (${note})` : ''
  if (after !== before) {
    wantedModel = null
    $.ui.log(`hand-off: model ${before} → ${after}${tail}`)
  } else {
    $.ui.log(`hand-off: model stays ${after}; wanted ${wanted}, and its requests keep going there${tail}`)
  }
}

async function takePendingHandoff($: EngineInterface, cwd: string) {
  try {
    const pending = await readPending($)
    if (!pending) return
    // the project folder, where the app opened the session elsewhere: the
    // app's own move, which the person approves
    if (pending.cwd && !isScratch(pending.cwd) && pending.cwd !== cwd) {
      try {
        const r = await $.mcp.call('ccd_directory', 'change_directory', { path: pending.cwd })
        $.ui.log(`hand-off: folder ${r.isError ? 'not moved' : 'moved'} to ${pending.cwd} (${trim(mcpText(r), 160)})`)
      } catch (error) {
        $.ui.log(`hand-off: folder not moved to ${pending.cwd}: ${trim(String(error), 160)}`)
      }
    }
    // the previous session's model, where the app started this one on
    // another. /model now would end the turn the opener started (a question
    // up counts as idle), so the requests are routed and the command waits.
    if (pending.model && pending.model !== (await $.session.model())) {
      wantedModel = pending.model
      $.ui.log(`hand-off: model ${pending.model}, as the previous session had: this turn's requests go there, /model follows after it`)
    }
    $.ui.log('hand-off: this session continues the one that wrote the brief')
  } catch {
    // an unreadable marker: the model stays the app's choice
  }
}

// The app starts a session from the link in the folder and on the model of
// its own last choices, whatever the link names. The new session's own
// switchboard sets the model and folder from the marker; from here, the
// first session the app lists after the link opened is named once in the
// log, with where it opened. (Setting its model from here through the app
// asks the person each time; the marker needs no one.)
const WATCH_MS = 5 * 60 * 1000

async function listApp($: EngineInterface): Promise<AppSession[]> {
  const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 20 })
  if (r.isError) return []
  const rows = JSON.parse(mcpText(r))
  return Array.isArray(rows) ? (rows as AppSession[]) : []
}

function watchNewSession($: EngineInterface, cwd: string, known: Set<string>, since: number) {
  let isBusy = false
  const timer = $.clock.every(POLL_MS, () => void tick())
  async function tick() {
    if (isBusy) return
    isBusy = true
    try {
      if ((await $.clock.now()) - since > WATCH_MS) {
        timer.cancel()
        $.ui.log(`hand-off: no new session seen within ${WATCH_MS / 60_000} minutes`)
        return
      }
      const fresh = (await listApp($)).find(s => s.sessionId && !s.isArchived && !known.has(s.sessionId))
      if (!fresh?.sessionId) return
      timer.cancel()
      const where = fresh.cwd && !sameWorkspace(fresh.cwd, cwd) ? ` in ${fresh.cwd}, not this folder` : ' in this folder'
      $.ui.log(`hand-off: the new session ${fresh.sessionId} opened${where}`)
    } catch (error) {
      timer.cancel()
      $.ui.log(`hand-off: could not watch for the new session: ${trim(String(error), 160)}`)
    } finally {
      isBusy = false
    }
  }
}

// Step two: save the brief as a file, start a fresh session in the same
// folder that reads it first, and retire this card. The new session's card
// takes this folder's place on the board. Each step leaves a line in the
// transcript, so a failure can be read afterwards.
//
// Two ways to start the session. The app's `start_session` tool inherits
// model, effort and permission mode, but it is behind a feature flag and not
// offered to every session. The app's own deep link,
// `claude://code/new?folder=…&q=…`, opens the new-session flow with the
// folder chosen and the prompt filled in, and works everywhere the app does.
async function finishHandoff($: EngineInterface) {
  if (!me) return
  const brief = await lastReply($)
  if (!brief) {
    isHandingOff = false
    $.ui.log('hand-off: the turn ended without a brief; nothing started')
    $.ui.toast('Hand-off: no brief was written')
    return
  }
  const title = me.title.replace(/ \(continued\)$/, '')
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'
  // inside the project, under its .claude folder: a file there is read
  // without a permission prompt, one outside the working directory is not
  const briefPath = `${me.cwd}/.claude/switchboard/handoff-${stamp}-${slug}.md`
  try {
    await $.fs.write(
      briefPath,
      `# Hand-off brief: ${title}\n\nFrom a Claude Code session in \`${me.cwd}\`, written by that session on ${stamp.slice(0, 10)} so a fresh session can continue its work.\n\n${brief}\n`,
    )
  } catch (error) {
    $.ui.log(`hand-off: could not save the brief: ${trim(String(error), 200)}`)
  }
  $.ui.log(`hand-off: brief of ${brief.length} characters saved to ${briefPath}`)
  // short, because it rides in the link that opens the new session
  const opener =
    `Continue the work handed off from the session "${title}". ` +
    'Its brief is in your context; it is the whole history. Pick up from its next steps.' +
    (isScratch(me.cwd) ? '' : ` The work is in ${me.cwd}: if this session is not in that folder, move there first with change_directory.`)

  let started = ''
  try {
    const r = await $.mcp.call('ccd_session', 'start_session', {
      initiation: 'user_asked',
      context: 'fresh',
      title: trim(title, 50) + ' (continued)',
      prompt: opener,
      background:
        `Started by the switchboard mod as a hand-off from the session "${title}" in ${me.cwd}, ` +
        'whose context was getting long. The brief that session wrote about its own work is at ' +
        `${briefPath}; treat it as the whole history.`,
      use_worktree: false,
    })
    const text = mcpText(r)
    if (r.isError) throw new Error(text)
    const newId = text.match(/local_[0-9a-f-]+/)?.[0]
    $.ui.log(`hand-off: start_session answered: ${trim(text, 200)}`)
    if (newId) {
      // off the parent's thread in the sidebar: it is a continuation, not a side task
      try {
        await $.mcp.call('ccd_session_mgmt', 'detach_session', { session_id: newId })
      } catch {
        // stays nested; the board does not care
      }
      void jumpTo($, newId)
    }
    started = 'through start_session'
  } catch (error) {
    $.ui.log(`hand-off: start_session is not available here (${trim(String(error), 120)}); opening the app's new-session link`)
    // The link opens the app's new-session page on this folder with the
    // opener filled in. The app creates the session only when that prompt is
    // sent, so one Enter is the person's; nothing else is. The new session's
    // own switchboard finds this marker at start and sets this session's
    // model there, where the app started it on another.
    // the model as the app names it, which its picker and set_session_model take
    let model = ''
    try {
      model = (await selfApp($))?.model || (await $.session.model())
    } catch {
      // the new session keeps the app's default
    }
    const known = new Set((await listApp($).catch(() => [])).map(s => s.sessionId ?? ''))
    known.add(me.id)
    const at = await $.clock.now()
    try {
      await $.fs.write(pendingPath(), JSON.stringify({ cwd: me.cwd, model, briefPath, title, at } satisfies Pending))
    } catch {
      // the model is then the app's choice
    }
    // a scratch folder named in the link is taken as "no folder" and a fresh
    // one is made, after a trust dialog about the old; so it is left out
    const folder = isScratch(me.cwd) ? '' : `folder=${encodeURIComponent(me.cwd)}&`
    const url = `claude://code/new?${folder}q=${encodeURIComponent(opener)}`
    try {
      const r = await $.process.run(['open', url])
      if (r.exitCode !== 0) throw new Error(r.stderr || `open exited ${r.exitCode}`)
      started = 'through the new-session link'
      watchNewSession($, me.cwd, known, at)
    } catch (error2) {
      $.ui.log(`hand-off: could not open the new-session link: ${trim(String(error2), 200)}`)
    }
  }

  if (started) {
    await writeMe($, { isRetired: true })
    $.ui.log(`hand-off: new session started ${started}; this card retires`)
    $.ui.toast('Handed off: new session opening with the brief; this card retires')
  } else {
    try {
      await $.ui.copy({ text: `Read the hand-off brief at ${briefPath} first, then continue from its next steps.` })
    } catch {
      // the path is in this transcript, just above
    }
    $.ui.toast('Hand-off: could not start a session; the brief is saved and its path copied')
  }
  isHandingOff = false
  handoffTurnId = null
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

    // a session the hand-off link opened: send its opener without an Enter
    void takePendingHandoff($, e.cwd)

    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(INBOX_MS, () => void pollInbox($))
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
    isTurnRunning = true
    heldTurnId = e.turnId
    // the first turn to start after a hand-off was asked for is the brief's
    if (isHandingOff && handoffTurnId === null) handoffTurnId = e.turnId
    const isFirst = !hasPrompted
    hasPrompted = true
    await writeMe($, { state: 'working', suggestion: null, ...(isFirst ? { lastPromptAt: await $.clock.now() } : {}) })
    return next(e)
  })

  // The dim suggestion in the prompt box: what another switchboard can send
  // on your behalf with one press.
  on('prompt.suggest', async ($, e, next) => {
    // recorded whether or not the box could show it: in the desktop app the
    // box is the app's own, and the engine may answer that it did not show
    if (e.text.trim()) await writeMe($, { suggestion: e.text.trim() })
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

  // Until /model has run, each request of the main loop goes to the
  // previous session's model.
  on('turn.step', async function* ($, e, next) {
    if (!wantedModel || e.agentId !== undefined) return yield* next(e)
    return yield* next({ ...e, model: wantedModel })
  })

  // A session the hand-off link opened reads the brief into its first turn.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source !== 'startup') return r
    const brief = await briefContext($)
    return brief ? { ...r, additionalContext: [...(r.additionalContext ?? []), brief] } : r
  })

  // Every model change in the transcript with who made it, so a hand-off's
  // own switch and one the app makes afterwards can be told apart.
  on('classic.PostModelSwitch', async ($, e, next) => {
    $.ui.log(`model: ${e.from_model} → ${e.to_model} (${e.source})`)
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
    if (e.agentId === undefined) {
      isTurnRunning = false
      if (wantedModel) $.clock.after(300, () => void switchModel($))
    }
    heldTurnId = null
    inFlight.clear()
    waitingIds.clear()
    isPromptUp = false
    const reply = await lastReply($)
    await writeMe($, { state: 'done', question: null, snippet: trim(reply, SNIPPET_MAX) })
    void refresh($)
    // the turn that wrote the brief, and no other (not the one a hand-off
    // interrupted, not a subagent's): start the new session from it
    if (isHandingOff && e.turnId === handoffTurnId && e.agentId === undefined) {
      if (e.isAborted) {
        isHandingOff = false
        handoffTurnId = null
        $.ui.log('hand-off: the brief was interrupted; nothing started')
      } else {
        void finishHandoff($)
      }
    } else if (!isHandingOff) {
      void suggestFallback($, reply)
    }
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
    // three cards across; each is two rows inside a thin frame: the lamp,
    // label, hand-off, reply and ×, then the gist
    const cardWidth = Math.max(MIN_CARD, Math.min(MAX_CARD, Math.floor((columns - (PER_ROW - 1)) / PER_ROW)))
    const perRow = Math.max(1, Math.floor((columns + 1) / (cardWidth + 1)))
    const inner = cardWidth - 4 // less the frame and its padding
    const labelMax = Math.max(8, inner - 8) // room for ⇢ ↩ ×

    // The popover: twice a card wide, drawn over the neighbours and never in
    // the flow, so no card moves when it shows. The band clips at its own
    // edge, so rows are reserved under the cards for the tallest popover
    // that may show, and none when no card has one.
    const wide = Math.min(columns, cardWidth * 2 + 1)
    const wideInner = wide - 4
    const rowsOf = (text: string, width: number) => Math.max(1, Math.ceil(text.length / Math.max(1, width)))
    const popoverRows = (card: Card) => {
      let rows = 2 // the frame
      if (trim(card.title, LABEL_MAX) !== card.label) rows += rowsOf(card.title, wideInner)
      if (card.question) {
        rows += rowsOf(card.question.text, wideInner)
        for (const option of card.question.options) rows += rowsOf(option, wideInner - 4)
      } else {
        rows += rowsOf(card.snippet || stateWord(card.state), wideInner)
        if (card.suggestion) rows += rowsOf(card.suggestion, wideInner - 9)
      }
      return rows
    }
    // A red card with a question shows the question and its options in the
    // card itself, so the band already has that height, and its popover under
    // the pointer is the same content wide. Any card shows the popover while
    // open with ↩; rows are reserved under the cards only then.
    // The desktop app draws the popover over the transcript above the band
    // and clips nothing, so there the cards stay two rows and no space is
    // kept. The terminal clips at the band's edge: there a red card shows its
    // question in the card, and rows are reserved while a card is open.
    const isTerminal = e.surface === 'terminal'
    const asks = (card: Card) => card.state === 'waiting' && card.question !== null
    // The popover is revealed by the pointer alone, which is the one way the
    // desktop app draws it whole. A red question has one; ↩ gives any card
    // one for a while, and since the pointer is on the card at the press, it
    // shows at once. In a terminal, which clips the popover, the same content
    // expands the card in the flow instead.
    const hasPopover = (card: Card) => asks(card) || openId === card.id
    const expandsInCard = (card: Card) => isTerminal && (asks(card) || openId === card.id)
    const cardRowCount = Math.ceil(deck.length / perRow)
    // rows kept free under the cards for a terminal's hover popover, which
    // hangs below the card and would otherwise be cut at the band's edge
    let reserve = 0
    if (isTerminal) {
      deck.forEach((card, i) => {
        if (!hasPopover(card)) return
        const rowsBelow = cardRowCount - 1 - Math.floor(i / perRow)
        reserve = Math.max(reserve, popoverRows(card) - 1 - rowsBelow * 4)
      })
      reserve = Math.max(0, Math.min(reserve, e.props.maxRows - cardRowCount * 4))
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {deck.map((card, i) => {
            const isMe = me !== null && card.id === me.id
            const isOpen = openId === card.id
            const options = card.question?.options ?? []
            // a popover that would run past the band's right edge hangs from
            // the card's right edge instead
            const column = (i % perRow) * (cardWidth + 1)
            const anchorRight = column + wide > columns
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
                {/* Row two is the short form: the gist, red while the session
                    needs you. A card that asks a question goes on below it with
                    the question and one row per option, in the card's own
                    width; the popover shows the same thing wide. */}
                <Text
                  color={card.state === 'waiting' ? 'red' : undefined}
                  dimColor={card.state !== 'waiting'}
                  wrap="truncate-end"
                >
                  {card.gist ||
                    (card.state === 'waiting' ? (card.question ? 'asks you' : 'needs you') : stateWord(card.state))}
                </Text>
                {/* A terminal only: the card expanded in the flow, taller and
                    never wider. The full title where it adds to the label, then
                    the question with one row per option, or the latest reply in
                    full with the suggestion and a send button. */}
                {expandsInCard(card) && (
                  <Box flexDirection="column">
                    {isOpen && trim(card.title, LABEL_MAX) !== card.label && (
                      <Text bold wrap="wrap">
                        {card.title}
                      </Text>
                    )}
                    {card.question && (
                      <Text color="red" wrap="wrap">
                        {card.question.text}
                      </Text>
                    )}
                    {options.length > 0 ? (
                      options.map((label, n) => (
                        <Box key={`option-in:${card.id}:${n}`} flexDirection="row" gap={1}>
                          <Button
                            key={`answer-in:${card.id}:${label}`}
                            plain
                            hotkey={String(n + 1)}
                            label={`[${n + 1}]`}
                            onPress={() => void answer($, card, isMe, label)}
                          />
                          <Box width={inner - 4}>
                            <Text wrap="wrap">{label}</Text>
                          </Box>
                        </Box>
                      ))
                    ) : (
                      <Text dimColor wrap="wrap">
                        {card.snippet || stateWord(card.state)}
                      </Text>
                    )}
                    {options.length === 0 && card.suggestion && (
                      <Box flexDirection="row" gap={1}>
                        <Button
                          key={`suggest-in:${card.id}`}
                          variant="primary"
                          label="send"
                          onPress={() => void answer($, card, isMe, card.suggestion ?? '')}
                        />
                        <Box width={inner - 9}>
                          <Text wrap="wrap">{card.suggestion}</Text>
                        </Box>
                      </Box>
                    )}
                  </Box>
                )}
                {hasPopover(card) && (
                  // The popover: the full title where it adds to the label, the
                  // whole question with one row per option (a small numbered
                  // button, the text wrapped beside it), or the latest reply in
                  // full and the suggestion with a send button. Shown while the
                  // card is open; otherwise drawn hidden, and the surface reveals
                  // it while the pointer is over the card or the popover itself.
                  <Box
                    position="absolute"
                    // above the card in the desktop app, where nothing clips and
                    // the prompt sits right under the band; below it in a terminal,
                    // which clips above the band and keeps rows free below
                    {...(isTerminal ? { top: 2 } : { bottom: 2 })}
                    {...(anchorRight ? { right: -2 } : { left: -2 })}
                    width={wide}
                    flexDirection="column"
                    paddingX={1}
                    borderStyle="round"
                    borderColor={card.state === 'waiting' ? 'red' : undefined}
                    display="none"
                    hover={{ display: 'flex' }}
                  >
                    {trim(card.title, LABEL_MAX) !== card.label && (
                      <Text bold wrap="wrap">
                        {card.title}
                      </Text>
                    )}
                    {card.question && (
                      <Text color="red" wrap="wrap">
                        {card.question.text}
                      </Text>
                    )}
                    {options.length > 0 ? (
                      options.map((label, n) => (
                        <Box key={`option:${card.id}:${n}`} flexDirection="row" gap={1}>
                          <Button
                            key={`answer:${card.id}:${label}`}
                            plain
                            hotkey={String(n + 1)}
                            label={`[${n + 1}]`}
                            onPress={() => void answer($, card, isMe, label)}
                          />
                          <Box width={wideInner - 4}>
                            <Text wrap="wrap">{label}</Text>
                          </Box>
                        </Box>
                      ))
                    ) : (
                      <Text dimColor wrap="wrap">
                        {card.snippet || stateWord(card.state)}
                      </Text>
                    )}
                    {options.length === 0 && card.suggestion && (
                      <Box flexDirection="row" gap={1}>
                        <Button
                          key={`suggest:${card.id}`}
                          variant="primary"
                          label="send"
                          onPress={() => void answer($, card, isMe, card.suggestion ?? '')}
                        />
                        <Box width={wideInner - 9}>
                          <Text wrap="wrap">{card.suggestion}</Text>
                        </Box>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
        {reserve > 0 && <Box height={reserve} />}
      </Box>
    )
  })
}
