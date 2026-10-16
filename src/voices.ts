// The system voices inloop can speak with, best first. On macOS, `say -v '?'`
// lists them; Premium and Enhanced voices (free downloads in System Settings)
// are natural-sounding, the compact ones less so, and some are sound effects.

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'novelty'

export type Voice = { name: string; locale: string; quality: VoiceQuality }

/** macOS's joke and sound-effect voices: never picked, never offered. */
const NOVELTY = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Wobble', 'Good News', 'Jester',
  'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Zarvox', 'Fred', 'Junior', 'Ralph', 'Kathy', 'Deranged',
  'Hysterical', 'Pipe Organ', 'Princess', 'Agnes', 'Bruce', 'Vicki', 'Victoria',
  'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
])

/** Compact voices that are still pleasant, in order of preference. */
const GOOD_COMPACT = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Alex', 'Rishi', 'Aman', 'Tara']

function quality(name: string): VoiceQuality {
  if (/\(Premium\)/i.test(name)) return 'premium'
  if (/\(Enhanced\)/i.test(name)) return 'enhanced'
  const base = name.replace(/\s*\(.*\)\s*$/, '')
  return NOVELTY.has(base) ? 'novelty' : 'standard'
}

/** Reads `say -v '?'` output: one voice a line, `Name  locale  # sample`. */
export function parseVoices(listing: string): Voice[] {
  const out: Voice[] = []
  const seen = new Set<string>()
  for (const line of listing.split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]{2,4})\s+#/.exec(line)
    if (m === null) continue
    const name = m[1]!.trim()
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, locale: m[2]!.replace('-', '_'), quality: quality(name) })
  }
  return out
}

const RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, standard: 1, novelty: 0 }

/** English voices worth offering, best first: Premium, Enhanced, then pleasant compact ones. */
export function rankVoices(voices: readonly Voice[], language = 'en'): Voice[] {
  const compactRank = (v: Voice) => {
    const i = GOOD_COMPACT.indexOf(v.name.replace(/\s*\(.*\)\s*$/, ''))
    return i < 0 ? GOOD_COMPACT.length : i
  }
  const localeRank = (v: Voice) => (v.locale === 'en_US' ? 0 : v.locale === 'en_GB' ? 1 : 2)
  return voices
    .filter(v => v.quality !== 'novelty' && v.locale.startsWith(language))
    .sort((a, b) => RANK[b.quality] - RANK[a.quality] || compactRank(a) - compactRank(b) || localeRank(a) - localeRank(b) || a.name.localeCompare(b.name))
}

/** The voice to use: the chosen one if installed, else the best installed, else the system default. */
export function pickVoice(voices: readonly Voice[], chosen: string): string | undefined {
  if (chosen !== '' && voices.some(v => v.name === chosen)) return chosen
  return rankVoices(voices)[0]?.name
}

/** True when nothing natural-sounding is installed yet. */
export function needsBetterVoice(voices: readonly Voice[]): boolean {
  return voices.length > 0 && !voices.some(v => v.locale.startsWith('en') && (v.quality === 'premium' || v.quality === 'enhanced'))
}

export const VOICE_HELP =
  'For the most natural voice (free, offline), inloop downloads Kokoro by itself (~200 MB, once) when [uv](https://docs.astral.sh/uv/) is installed; `/inloop-voice setup` starts it now. Or download a Mac voice marked **Premium**: System Settings → Accessibility → Spoken Content → System voice → Manage Voices…'

/** Kokoro's voices worth offering (all built into its voice file), best first. */
export const KOKORO_VOICES: readonly { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (US, warm)' },
  { id: 'af_bella', label: 'Bella (US)' },
  { id: 'af_nicole', label: 'Nicole (US, soft)' },
  { id: 'am_michael', label: 'Michael (US)' },
  { id: 'am_fenrir', label: 'Fenrir (US)' },
  { id: 'bf_emma', label: 'Emma (UK)' },
  { id: 'bm_george', label: 'George (UK)' },
]

export type VoicePlan = { engine: 'kokoro'; id: string } | { engine: 'system'; name: string | undefined }

/**
 * Which engine and voice speak, from the setting: `kokoro:<id>`, a system
 * voice's name, or '' for the best available (Kokoro when it is set up).
 */
export function planVoice(setting: string, isKokoroReady: boolean, systemVoices: readonly Voice[]): VoicePlan {
  if (setting.startsWith('kokoro:')) {
    const id = setting.slice('kokoro:'.length)
    if (isKokoroReady && KOKORO_VOICES.some(v => v.id === id)) return { engine: 'kokoro', id }
    return { engine: 'system', name: pickVoice(systemVoices, '') }
  }
  if (setting === '' && isKokoroReady) return { engine: 'kokoro', id: KOKORO_VOICES[0]!.id }
  return { engine: 'system', name: pickVoice(systemVoices, setting) }
}

export function describePlan(plan: VoicePlan): string {
  if (plan.engine === 'kokoro') return `${KOKORO_VOICES.find(v => v.id === plan.id)?.label ?? plan.id} (Kokoro)`
  return plan.name ?? 'the system voice'
}
