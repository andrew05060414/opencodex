export interface AgyBridgeOptions {
  /** Merged over the environment of every agy child this instance starts. */
  env?: Record<string, string>
  /** The agy user home for this instance. Defaults to os.homedir(). */
  home?: string
  /** Replaces the bridge state file path, so instances never share state. */
  stateFile?: string
  /** Explicit agy executable; skips discovery and AGY_PATH. */
  agyPath?: string
}

export interface AgyBridge {
  /** Anthropic Messages in, Anthropic JSON or SSE Response out. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** Stops every agy process this instance owns. */
  shutdown(): Promise<void>
}

export function createAgyBridge(options?: AgyBridgeOptions): AgyBridge
