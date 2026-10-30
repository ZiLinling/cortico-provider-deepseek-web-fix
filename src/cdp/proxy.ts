/**
 * 本地回环代理：**所有补全请求的统一出口**。
 *
 * 两个作用：
 *
 * 1. **注入点**。框架的 `generate()` 直接调全局 `fetch`，没有发送钩子；但它只依赖 `Response`
 *    的四个能力。把 `transport.url` 指到这里，由我们决定「这条请求交给 Node 还是交给浏览器」，
 *    `generate()` 的重试退避、四档超时、计量、SSE 装配全部照旧。
 *
 * 2. **唯一的观测点**。`generate()` 在收到 429 时会按 `Retry-After` 重试（最多 3 次），
 *    而上游给的 `Retry-After` 可能是几分钟——表现就是「发了没反应」。在这里把 429 改成
 *    409 直接结束，既不重试也不傻等，同时把 `Retry-After` 带给上层去算冷却。
 *
 * 为什么不用「临时替换 globalThis.fetch」：那是进程级全局状态，`finally` 一旦没走到就是污染。
 * 换 URL 只改一个字符串。
 *
 * 安全：只绑 `127.0.0.1`；端口由系统分配；路径里带一次性 token。
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'cortico/core/types.ts';
import { parseRetryAfter } from 'cortico/providers/transport/errors.ts';
import { cleanResponseHeaders } from './headers.ts';
import type { PageEmit } from './page.ts';

/** 等响应头的最长时间；`generate()` 自己的超时会先触发，这里只是兜底。 */
const HEAD_TIMEOUT_MS = 90_000;
/** 单条响应的字节上限。上游正常一轮最多几百 KB；超过这个数说明哪里在重复灌数据。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ForwardRequest {
  id: string;
  /** 以 `/` 开头的路径（含 query）。 */
  path: string;
  method: string;
  /** 原始请求头；由各个 forward 自己决定要剥掉哪些。 */
  headers: Record<string, string>;
  body: string;
  /** 下游断开时触发，用来中断上游请求。 */
  signal: AbortSignal;
}

export type ForwardSink = (message: PageEmit) => void;

export interface ProxyOptions {
  log: Logger;
  /** 把请求真正发出去；结果通过 `sink` 回传。 */
  forward: (request: ForwardRequest, sink: ForwardSink) => Promise<void>;
  /** 单条响应的字节上限；测试可以调小。 */
  maxBytes?: number;
}

interface Pending {
  res: ServerResponse;
  headSent: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** 已经写出的字节数，用来挡住「重复灌数据」这类失控。 */
  bytes: number;
  controller: AbortController;
}

function headersOf(raw: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export class ChannelProxy {
  private server: Server | null = null;
  private port = 0;
  private token = '';
  private counter = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: ProxyOptions) {}

  get listening(): boolean {
    return this.server !== null;
  }

  async listen(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.port, token: this.token };
    this.token = randomBytes(16).toString('hex');
    const server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        this.opts.log.debug?.(`DeepSeek Web：回环代理出错（${(error as Error).message}）`);
        // `handle` 自己处理过的情况响应已经结束；这里只兜「读 body 就失败」这类早期错误。
        if (res.writableEnded) return;
        if (!res.headersSent) res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'browser_transport', message: (error as Error).message } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('回环代理没能拿到端口');
    this.port = address.port;
    this.server = server;
    this.opts.log.debug?.(`DeepSeek Web：回环代理就绪（127.0.0.1:${this.port}）`);
    return { port: this.port, token: this.token };
  }

  urlFor(path: string): string {
    if (!this.server) throw new Error('回环代理还没启动');
    return `http://127.0.0.1:${this.port}/${this.token}${path}`;
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.controller.abort();
      try {
        entry.res.destroy();
      } catch {
        /* 已经关了 */
      }
    }
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    // 先掐断残留连接，否则 keep-alive 会让 close 等上几秒。
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** 把上游回传的分片交给对应的 HTTP 响应。 */
  deliver(message: PageEmit): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    const { res } = entry;
    switch (message.kind) {
      case 'head': {
        entry.headSent = true;
        clearTimeout(entry.timer);
        // 429 不能透给 `generate()`：它会按 Retry-After 睡几分钟再重试，用户看到的是「卡住」。
        // 改成 409（确定性失败）直接结束，并把 Retry-After 带给上层算冷却。
        if (message.status === 429) {
          const retryAfterMs = parseRetryAfter(message.headers?.['retry-after'] ?? null);
          this.pending.delete(message.id);
          entry.controller.abort();
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              code: 'account_rate_limit',
              message: '上游限流（HTTP 429）',
              status: 429,
              retryAfterMs,
            },
          }));
          break;
        }
        res.writeHead(message.status ?? 502, cleanResponseHeaders(message.headers));
        res.socket?.setNoDelay(true);
        break;
      }
      case 'chunk': {
        if (!entry.headSent) break;
        entry.bytes += message.data?.length ?? 0;
        const limit = this.opts.maxBytes ?? MAX_RESPONSE_BYTES;
        if (entry.bytes > limit) {
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          entry.controller.abort();
          this.opts.log.warn(`DeepSeek Web：单条响应超过 ${Math.round(limit / 1024 / 1024)}MB，已中断`);
          if (!res.writableEnded) res.end();
          break;
        }
        res.write(message.data ?? '');
        break;
      }
      case 'end':
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (res.writableEnded) break;
        if (!entry.headSent) {
          // 一条没有响应头就结束的流是协议违例；别让下游把 200 + 空 body 当成「模型没说话」。
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'browser_transport', message: '上游没有返回响应头' } }));
          break;
        }
        res.end();
        break;
      case 'error': {
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.controller.abort();
        if (res.writableEnded) break;
        if (entry.headSent) {
          // 头已经发出去了，没法改状态码；直接断开，让下游看到流提前结束。
          res.end();
          break;
        }
        res.writeHead(message.retryable ? 502 : 409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: message.retryable ? 'upstream_unreachable' : 'browser_transport',
            message: message.message ?? '浏览器通道执行失败',
          },
        }));
        break;
      }
    }
  }

  private async handle(req: import('node:http').IncomingMessage, res: ServerResponse): Promise<void> {
    const prefix = `/${this.token}`;
    const url = req.url ?? '';
    // 路径里的 token 就是凭据：32 位随机、只在本进程内出现过，且只绑 127.0.0.1。
    // 不能要求额外的私有头——`generate()` 只会带 `transport.headers()` 里的东西，
    // 它不知道这个 token，要求了就会把每一条正常请求也拒掉。
    if (!url.startsWith(prefix)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }

    const path = url.slice(prefix.length) || '/';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');

    const headers = headersOf(req.headers);
    // 私有头只在 Node ↔ 代理之间用，绝不能带进发往上游的请求。
    delete headers['x-ds-transport'];

    const id = `r${++this.counter}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.controller.abort();
      if (entry.res.writableEnded) return;
      if (!entry.headSent) {
        entry.res.writeHead(409, { 'content-type': 'application/json' });
        entry.res.end(JSON.stringify({ error: { code: 'browser_transport', message: '浏览器通道等响应头超时' } }));
      } else {
        entry.res.end();
      }
    }, HEAD_TIMEOUT_MS);

    this.pending.set(id, { res, headSent: false, timer, bytes: 0, controller });

    // 下游（`generate()` 的超时、用户点停止）一断开就中断上游，别让浏览器白跑。
    res.on('close', () => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (!res.writableEnded) entry.controller.abort();
    });

    try {
      await this.opts.forward(
        { id, path, method: req.method ?? 'POST', headers, body, signal: controller.signal },
        message => this.deliver(message),
      );
    } catch (error) {
      // 上游请求没发出去（跳转、注入失败、网络）：收掉这一条，别留一个等 90 秒的定时器。
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (!res.writableEnded) {
          if (!entry.headSent) res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'browser_transport', message: (error as Error).message } }));
        }
      }
      throw error;
    }
  }
}
