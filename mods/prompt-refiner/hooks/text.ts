// Pure text work for the refiner: the model prompts, reply parsers, and the
// band's wrapping and row budget. No `$` here, so it tests without a session.

export const MAX_QUESTIONS = 3
const MAX_BODY_ROWS = 8
const MAX_CHANGES = 3
// Border (2), header (1), and the button row with room to wrap once (2).
const CHROME_ROWS = 5
const SKIPPED = 'skipped, no answer'

export const GAPS_SYSTEM = `You read a person's rough prompt for an AI coding and research assistant before it is refined.
Find only real gaps: two instructions that contradict each other, or a must-know fact that is missing and would change the work (for example which file or system, the goal behind it, the scope, or how to tell it is done).

Return JSON only, no prose, no code fences, in exactly this shape:
{"questions":[{"q":"<short question ending in a question mark>","options":["<option>","<option>"]}]}

Rules:
- 0 to 3 questions. When the prompt is clear, return {"questions":[]}. Fewer is better.
- Never ask about something the prompt already answers, and never ask about style or nice-to-haves.
- For a conflict, name both sides in the question and offer each side as an option.
- Each question has 2 or 3 short options (1 to 5 words), taken from the prompt where possible. No "Other" option; the person can type their own.`

export const REFINE_SYSTEM = `You rewrite a person's prompt for an AI coding and research assistant in the style they picked.

Return exactly this shape and nothing else:
<prompt>
the refined prompt
</prompt>
<changes>
- one short line per meaningful change
</changes>

The style for this rewrite comes with the prompt. Follow it exactly; it overrides every rule below where they differ.
- Keep every fact, name, path, number, link and tool from the draft and the answers.
- Never invent facts, names or numbers. Where something important is unknown, say so as a question for the assistant to ask, not a guess.
- Write in the person's voice (I, we, my), as if they wrote it.
- 2 to 5 changes, each under 12 words, saying what you made clearer, added, or cut.`

export type Gap = { q: string; options: string[] }
export type QA = { q: string; a: string | null }

const stripFences = (raw: string) =>
  raw
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim()

// Reads the gap check's reply. Throws on anything that is not the JSON asked
// for; the caller turns that into zero questions.
export const parseGaps = (raw: string): Gap[] => {
  const t = stripFences(raw)
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply')
  const json = JSON.parse(t.slice(a, b + 1)) as { questions?: unknown }
  if (!Array.isArray(json.questions)) throw new Error('no questions list in the reply')
  const out: Gap[] = []
  for (const item of json.questions) {
    if (out.length >= MAX_QUESTIONS) break
    const { q, options } = (item ?? {}) as { q?: unknown; options?: unknown }
    if (typeof q !== 'string' || !q.trim() || !Array.isArray(options)) continue
    const opts: string[] = []
    for (const o of options) {
      const label = typeof o === 'string' ? o.trim() : ''
      if (!label || /^other$/i.test(label) || opts.includes(label)) continue
      if (opts.length < 3) opts.push(label)
    }
    if (opts.length < 2) continue
    const question = q.trim().endsWith('?') ? q.trim() : `${q.trim()}?`
    out.push({ q: question, options: opts })
  }
  return out
}

// Reads the refine reply: the prompt between its tags, and the change bullets.
export const parseRefined = (raw: string): { text: string; changes: string[] } => {
  const t = stripFences(raw)
  const body = /<prompt>\s*([\s\S]*?)\s*<\/prompt>/i.exec(t)?.[1]?.trim()
  if (!body) throw new Error('the reply had no <prompt> block')
  const list = /<changes>([\s\S]*?)<\/changes>/i.exec(t)?.[1] ?? ''
  const changes = list
    .split('\n')
    .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
  return { text: body, changes }
}

// The chips the Refine button offers, like a keyboard's rewrite suggestions.
// `ask` asks gap questions first; `guide` asks for the person's own direction.
export const STYLES = [
  {
    key: 'clearer',
    label: 'Clearer',
    how: 'Open with the task in one plain sentence, then make the rest clearer and more specific. Keep it close to the draft\'s length, at most a third longer. Add no steps, checks or requirements the draft does not ask for. Plain prose and short bullets.',
  },
  { key: 'shorter', label: 'Shorter', how: 'Cut it to the fewest words that keep every fact and instruction. It must come out shorter than the draft.' },
  {
    key: 'elaborate',
    label: 'Elaborate',
    how: 'Improve it by making it fuller: turn vague parts into concrete asks, spell out the steps and details the draft implies, and where it leaves something important unsaid, add a line asking the assistant to check or ask me. Keep the draft\'s own shape and flow. No headings and no goal, constraints or done-criteria sections; that is a different style.',
  },
  {
    key: 'structured',
    label: 'Structured',
    how: 'Start with the line THE JOB and write it as four parts under these exact headings, each on its own line: THE JOB, THE WHY, THE GUARDRAILS, DONE MEANS. Nothing before THE JOB. Where it says nothing for a part, write "unknown: ask me".',
  },
  { key: 'ask', label: 'Ask me first', how: 'Open with the task in one plain sentence, then make it clearer and more specific using my answers.' },
  { key: 'guide', label: 'My guidance', how: 'Rewrite it the way my guidance says; the guidance decides length and shape.' },
] as const

export type StyleKey = (typeof STYLES)[number]['key']

export const refinePrompt = (draft: string, how: string, qa: QA[] = [], guidance?: string) => {
  let p = `Here is my prompt. Rewrite it.\n\n<draft>\n${draft}\n</draft>\n\nStyle for this rewrite: ${how}`
  if (qa.length) {
    const lines = qa.map(x => `Q: ${x.q}\nA: ${x.a ?? SKIPPED}`).join('\n\n')
    p += `\n\nI answered these questions first. Use the answers; leave out what was skipped.\n\n<answers>\n${lines}\n</answers>`
  }
  if (guidance) p += `\n\nMy guidance: ${guidance}`
  return p
}

// Word-wraps text to a width, keeping each line's indent; a word longer than
// the width is left whole for the Text's truncation to cut.
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    const indent = /^\s*/.exec(para)?.[0] ?? ''
    let line = ''
    for (const w of words) {
      if (line && indent.length + line.length + 1 + w.length > width) {
        out.push(indent + line)
        line = w
      } else {
        line = line ? `${line} ${w}` : w
      }
    }
    out.push(indent + line)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// How many prompt lines and change bullets the ready band shows within
// maxRows; a cut prompt spends one row on its "+N more lines" note.
export function layout(maxRows: number, lines: number, changes: number) {
  const room = Math.max(2, maxRows - CHROME_ROWS)
  let body = Math.max(1, Math.min(MAX_BODY_ROWS, lines, room))
  if (body < lines && body + 1 > room) body = room - 1
  const more = lines - body
  const shownChanges = Math.max(0, Math.min(MAX_CHANGES, changes, room - body - (more > 0 ? 1 : 0)))
  return { body, more, changes: shownChanges }
}
