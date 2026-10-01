export interface IncomingMessage {
  channelName: string
  userId: string
  text: string
  timestamp: number
  metadata?: Record<string, unknown>
  /** Base64-encoded images attached to the message or quoted reply. */
  images?: string[]
}

export interface OutgoingMessage {
  text: string
  mode?: 'text' | 'voice' | 'video' | 'selfie'
  mediaUrl?: string
  /** Path to a local file to send to the user (video, audio, document). */
  mediaPath?: string
  /**
   * Everything the turn produced, in the order it made it.
   *
   * `mediaUrl` and `mediaPath` are the last of these and stay for the channels
   * that read them. A turn can make more than one thing — two voice notes when
   * she is asked for two, or a voice and a picture together — and a single slot
   * kept only the last, dropping the rest without a word.
   */
  media?: Array<{ url?: string; path?: string; text?: string }>
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Progress events emitted by the Engine during agentic loop. */
export type EngineProgressEvent =
  | { type: 'thinking' }
  | { type: 'tool_start'; tool: string; turn: number }
  | { type: 'tool_end'; tool: string; turn: number; success: boolean }
  | { type: 'turn_complete'; turn: number; totalTurns: number }
  | { type: 'text_chunk'; chunk: string }

export type ProgressCallback = (event: EngineProgressEvent) => void
