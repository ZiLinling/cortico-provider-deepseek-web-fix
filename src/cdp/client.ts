/**
 * 极简 CDP 客户端：一条 WebSocket，按 `id` 配对 Promise，另外把事件分发给订阅者。
 *
 * 只用到三个域：`Target`（找/建标签页）、`Runtime`（执行脚本、绑定回调）、`Page`（导航）。
 * 这三个是 CDP 里最稳定的部分，浏览器升级不容易改坏。
 *
 * 与 `browser-signin.ts` 里那份的区别：那份只发不收（登录轮询够用），这份要接收
 * `Runtime.bindingCalled` 才能把 SSE 分片流式传回来，所以必须处理事件。
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  /** 扁平会话模式下的标签页会话 id。 */
  sessionId?: string;
}

export type CdpHandler = (event: CdpEvent) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SEND_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<CdpHandler>();
  private alive = true;
  private readonly closedPromise: Promise<void>;
  private markClosed!: () => void;

  private constructor(private readonly socket: WebSocket) {
    this.closedPromise = new Promise<void>(resolve => {
      this.markClosed = resolve;
    });
    socket.addEventListener('message', event => this.dispatch(event.data));
    socket.addEventListener('close', () => this.onClose('CDP 连接已关闭'));
    socket.addEventListener('error', () => this.onClose('CDP 连接出错'));
  }

  static async connect(wsUrl: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连不上浏览器调试端口'));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** 连接关闭时 resolve；用来在外部做「断了就重连」。 */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  on(handler: CdpHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = SEND_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('CDP 连接已断开'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  close(): void {
    this.onClose('CDP 连接被主动关闭');
    try {
      this.socket.close();
    } catch {
      /* 已经关了 */
    }
  }

  private dispatch(raw: unknown): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP 错误'));
      else waiter.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // 一个订阅者抛错不该拖垮整条连接。
      }
    }
  }

  private onClose(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.pending.clear();
    this.markClosed();
  }
}
