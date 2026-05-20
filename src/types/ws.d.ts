declare module 'ws' {
  import type { Buffer } from 'node:buffer'
  import type { EventEmitter } from 'node:events'

  export default class WebSocket extends EventEmitter {
    constructor(url: string)
    close(): void
    send(data: string): void
    on(event: 'close', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'message', listener: (data: string | Buffer) => void): this
    once(event: 'close', listener: () => void): this
    once(event: 'open', listener: () => void): this
    once(event: 'error', listener: (error: Error) => void): this
  }
}
