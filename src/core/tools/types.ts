export interface ToolParam {
  name: string
  type: string // 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  mediaUrl?: string
  /** Path to a local file to send to the user (video, audio, document). */
  mediaPath?: string
  /**
   * What the media itself says, when it says something.
   *
   * A voice note carries words, and those words are the words. Without them the
   * channel cannot tell a caption that adds something ("проверяй, как звучит")
   * from one that repeats what is already being said out loud ("Ого, хакер наш
   * объявился…" said twice, once aloud and once underneath).
   */
  mediaText?: string
}

export interface Tool {
  name: string
  description: string
  parameters: ToolParam[]
  execute(params: Record<string, unknown>): Promise<ToolResult>
}
