// Defaults for the session's state. The atoms themselves are declared in the
// hooks module, where `claude plugin validate` can read every key inloop
// reads and writes.

import type { InloopSettings } from '../types'

export const DEFAULT_SETTINGS: InloopSettings = {
  mode: 'auto',
  depth: 'intermediate',
  focus: '',
  style: 'spoken',
  briefAgent: true,
  voice: '',
  autoVoiceSetup: true,
  autoModel: 'haiku',
  askModel: 'sonnet',
  useReader: true,
  autoEngine: 'model',
  minScore: 3,
  quietSeconds: 6,
}
