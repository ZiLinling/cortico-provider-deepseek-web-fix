/**
 * 传输层：决定每一条补全请求「由谁发出去」，并提供唯一的观测点。
 *
 * 两条路：
 *   - **Node**：`fetch` 直连上游（默认，和 0.4.x 行为一致）。
 *   - **浏览器**：由 `chat.deepseek.com` 页面里的 `fetch` 发出，TLS 指纹与真实浏览器一致。
 *
 * 两者都经过本地回环代理，所以：
 *   - `generate()` 一行没改，重试退避 / 四档超时 / 计量 / SSE 装配全部保留；
 *   - 429 在代理里就被转成 409（不让 `generate()` 按 `Retry-After` 傻等几分钟再重试）；
 *   - 中断、字节上限、状态观测都只有一个地方要维护。
 */
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { LLMError } from 'cortico/providers/transport/errors.ts';
import { nodeHttp, type Http, type TransportChannel } from '../http.ts';
import { BrowserHost } from './browser.ts';
import { CdpConnection } from './client.ts';
import { stripForbiddenHeaders, cleanResponseHeaders, stripHopByHopHeaders, toHeaderRecord } from './headers.ts';
import { PageBridge, type PageInit } from './page.ts';
import { ChannelProxy, type ForwardRequest, type ForwardSink } from './proxy.ts';

export type BrowserMode = 'off' | 'auto' | 'on';
export type BrowserChoice = 'auto' | 'edge' | 'chrome';

export interface TransportOptions {
  baseUrl: () => string;
  /** 端点目录；profile 与端口记录都放在这里。 */
  stateDir: string;
  log: Logger;
  mode: () => BrowserMode;
  channel: () => BrowserChoice;
  headless: () => boolean;
  /** 已有凭证里的 cookie；用来给全新的浏览器 profile 播种会话，避免二次登录。 */
  cookie?: () => string | null;
}

export interface ChannelStatus {
  mode: BrowserMode;
  /** 当前这一轮实际用的通道。 */
  active: 'node' | 'browser' | 'unavailable';
  detail: string;
  lastError: string | null;
  /** 浏览器 profile 目录；登录态存在这里，出问题时可以整个删掉重来。 */
  profile: string;
}

export class Transport implements TransportChannel {
  private readonly browser: BrowserHost;
  private connection: CdpConnection | null = null;
  private page: PageBridge | null = null;
  private proxy: ChannelProxy | null = null;
  private proxyStarting: Promise<ChannelProxy> | null = null;
  private starting: Promise<boolean> | null = null;
  private lastError: string | null = null;
  /** `auto` 模式下退回 Node 的告警时间；每轮都刷一条会把日志淹掉。 */
  private fallbackWarnAt = 0;
  private exitHookRegistered = false;

  constructor(private readonly opts: TransportOptions) {
    this.browser = new BrowserHost({
      profileDir: join(opts.stateDir, 'browser-profile'),
      stateFile: join(opts.stateDir, 'browser-channel.json'),
      log: opts.log,
      channel: opts.channel,
      headless: opts.headless,
    });
  }

  /** 非流式调用（建会话 / 挑战 / 上传 / 轮询）。 */
  readonly http: Http = async (url, init) => {
    const ready = await this.ensure();
    if (!ready) {
      if (this.opts.mode() === 'on') throw new LLMError(this.unavailable(), 409, '');
      return nodeHttp(url, init);
    }
    const target = new URL(url);
    // 只接管上游自己的地址；别的（比如 wasm 下载）照旧走 Node。
    if (target.origin !== this.origin()) return nodeHttp(url, init);
    const page = this.page;
    if (!page) return nodeHttp(url, init);

    const payload = await this.pageInit(init);
    // 上传（multipart）可能十几秒，不能套默认的短超时；同时把 signal 传下去，
    // 用户点停止时上传也要真的断掉。
    const timeoutMs = init.body instanceof FormData ? 180_000 : 60_000;
    const result = await page.request(`${target.pathname}${target.search}`, payload, {
      timeoutMs,
      signal: init.signal ?? undefined,
    });
    this.opts.log.debug?.(
      `DeepSeek Web：页面内 ${payload.method} ${target.pathname} → ${result.status}`
      + (result.error ? `（${result.error.slice(0, 80)}）` : ''),
    );
    if (result.status === 0) {
      // 带上标记：否则 `respond()` 只能按 status 0 判成「连不上上游」，
      // 而真实原因是页面里那次 fetch 失败了。
      const message = `浏览器通道执行失败：${result.error ?? '未知原因'}`;
      throw new LLMError(message, 0, JSON.stringify({ error: { code: 'browser_transport', message } }));
    }
    // 浏览器已经解压过 body；`content-encoding` / `content-length` 留着会让下游误判。
    const headers = cleanResponseHeaders(result.headers);
    // 204/304 不允许带 body，`new Response` 会直接抛。
    const body = result.status === 204 || result.status === 304 ? null : result.body;
    return new Response(body, { status: result.status, headers });
  };

  describe(): string {
    return this.page ? 'browser' : 'node';
  }

  status(): ChannelStatus {
    const mode = this.opts.mode();
    return {
      mode,
      active: this.page ? 'browser' : mode === 'off' ? 'node' : 'unavailable',
      detail: this.browser.describe(),
      lastError: this.lastError,
      profile: join(this.opts.stateDir, 'browser-profile'),
    };
  }

  /**
   * 补全请求的地址。**永远指向回环代理**——即使在 Node 模式下也一样，
   * 因为 429 的拦截和中断都发生在那一个地方。
   */
  async urlFor(path: string): Promise<string> {
    const mode = this.opts.mode();
    if (mode !== 'off') {
      const ready = await this.ensure();
      if (!ready) {
        if (mode === 'on') throw new LLMError(this.unavailable(), 409, '');
        const now = Date.now();
        if (now - this.fallbackWarnAt > 5 * 60_000) {
          this.fallbackWarnAt = now;
          this.opts.log.warn(`DeepSeek Web：浏览器通道不可用，本轮退回 Node（${this.lastError ?? '未知原因'}）`);
        }
      }
    }
    const proxy = await this.ensureProxy();
    return proxy.urlFor(path);
  }

  /** 按需启动浏览器。返回「这一轮能不能走浏览器」，不抛错（由调用方按模式决定报错还是降级）。 */
  async ensure(): Promise<boolean> {
    if (this.opts.mode() === 'off') return false;
    if (this.page && this.connection?.isAlive && this.proxy?.listening) return true;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return await this.starting;
  }

  /**
   * 重新登录之后把新凭证同步进正在运行的通道。
   *
   * 不做的后果：磁盘上是新 token，浏览器里还是旧 cookie，下一次请求被上游当成两个客户端。
   */
  async syncCookies(): Promise<boolean> {
    if (!this.page) return false;
    return await this.page.ensureCookies(this.opts.cookie?.() ?? null).catch(() => false);
  }

  async close(): Promise<void> {
    this.teardown();
    this.browser.kill();
    const proxy = this.proxy;
    this.proxy = null;
    await proxy?.close().catch(() => {
      // 关不掉只是端口晚点释放。
    });
  }

  private origin(): string {
    return new URL(this.opts.baseUrl()).origin;
  }

  private unavailable(): string {
    return `浏览器通道不可用：${this.lastError ?? '未知原因'}。`
      + '把端点里的「传输通道」改成 off 可以先恢复使用。';
  }

  /** 回环代理按需启动；它不依赖浏览器，Node 模式也要用。 */
  private async ensureProxy(): Promise<ChannelProxy> {
    if (this.proxy?.listening) return this.proxy;
    if (!this.proxyStarting) {
      this.proxyStarting = (async () => {
        const proxy = new ChannelProxy({
          log: this.opts.log,
          forward: (request, sink) => this.forward(request, sink),
        });
        await proxy.listen();
        this.proxy = proxy;
        if (!this.exitHookRegistered) {
          this.exitHookRegistered = true;
          // 应用退出时顺手关掉浏览器；只杀本进程起的，复用别人的不动。
          process.once('exit', () => this.browser.kill());
        }
        return proxy;
      })().finally(() => {
        this.proxyStarting = null;
      });
    }
    return await this.proxyStarting;
  }

  private async forward(request: ForwardRequest, sink: ForwardSink): Promise<void> {
    // 浏览器在就交给页面；否则 Node 直连。每一轮单独判断，所以中途切换也能生效。
    if (this.opts.mode() !== 'off' && this.page) {
      const page = this.page;
      // 下游断开（用户点停止、`generate()` 超时）要真的中断页面里那条请求，
      // 否则浏览器会一直生成下去——既浪费配额，也留下「发了不读」的行为。
      const onAbort = (): void => {
        void page.abort(request.id);
      };
      // 注意：这里**不能**在 `page.stream()` 返回后摘掉监听器——它只负责把请求发进页面，
      // 真正跑完是在页面里。监听器跟着 `request.signal` 走，那条 signal 是单次请求的，
      // 请求结束就一起被回收。
      request.signal.addEventListener('abort', onAbort, { once: true });
      await page.stream(request.id, request.path, {
        method: request.method,
        // 禁止头必须剥掉：页面 fetch 设不了 Cookie / Origin / Referer / UA，浏览器会自己生成。
        headers: stripForbiddenHeaders(request.headers),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'error',
      });
      return;
    }
    await forwardNode(request, sink, this.opts.baseUrl());
  }

  private async start(): Promise<boolean> {
    try {
      const endpoint = await this.browser.ensure();
      const connection = await CdpConnection.connect(endpoint.wsUrl);
      const page = await PageBridge.attach(connection, this.origin());
      await page.install();
      // 全新 profile 里没有会话；用磁盘上已有的 cookie 播种，用户不必重新登录。
      const seeded = await page.ensureCookies(this.opts.cookie?.() ?? null).catch(() => false);
      if (seeded) this.opts.log.info('DeepSeek Web：已同步登录态到浏览器通道');
      await this.ensureProxy();

      this.connection = connection;
      this.page = page;
      this.lastError = null;
      // 页面回传的分片交给代理，否则代理永远等不到响应头。
      page.onEmit(message => this.proxy?.deliver(message));
      connection.closed.then(() => {
        if (this.connection !== connection) return;
        // 记下原因，面板才能区分「还没启动」和「启动后断了」。
        this.lastError = '浏览器连接已断开（下次请求会自动重启）';
        this.teardown();
      });
      this.opts.log.info(`DeepSeek Web：传输通道 = 浏览器（${endpoint.version}）`);
      return true;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.teardown();
      if (this.opts.mode() === 'auto') {
        this.opts.log.warn(`DeepSeek Web：浏览器通道启动失败，退回 Node（${this.lastError}）`);
      }
      return false;
    }
  }

  private teardown(): void {
    const page = this.page;
    const connection = this.connection;
    this.page = null;
    this.connection = null;
    page?.disposeBridge();
    connection?.close();
  }

  /** 把 `fetch` 的 init 翻译成页面能执行的形式；FormData 走 base64 重建。 */
  private async pageInit(init: RequestInit): Promise<PageInit> {
    const headers = stripForbiddenHeaders(toHeaderRecord(init.headers));
    const body = init.body;
    const payload: PageInit = {
      method: init.method ?? 'GET',
      headers,
      redirect: typeof init.redirect === 'string' ? init.redirect : 'error',
    };

    if (body === null || body === undefined) return payload;
    if (typeof body === 'string') {
      payload.body = body;
      return payload;
    }
    if (body instanceof URLSearchParams) {
      payload.body = body.toString();
      return payload;
    }
    if (body instanceof FormData) {
      // 交给浏览器写 boundary：手写的 content-type 会让上游解析失败。
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type') delete headers[key];
      }
      const parts: Array<{ name: string; filename?: string; type?: string; b64: string }> = [];
      for (const [name, value] of body.entries()) {
        if (typeof value === 'string') {
          parts.push({ name, b64: Buffer.from(value, 'utf8').toString('base64') });
          continue;
        }
        const bytes = Buffer.from(await value.arrayBuffer());
        parts.push({
          name,
          filename: value.name || 'file',
          type: value.type || 'application/octet-stream',
          b64: bytes.toString('base64'),
        });
      }
      payload.body = { __form: parts };
      return payload;
    }
    throw new Error('浏览器通道不支持这种请求体');
  }
}

/** Node 直连：把 `fetch` 的响应翻译成和页面一致的分片消息。 */
async function forwardNode(request: ForwardRequest, sink: ForwardSink, baseUrl: string): Promise<void> {
  const base = baseUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${request.path}`, {
      method: request.method,
      headers: stripHopByHopHeaders(request.headers),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'error',
      signal: request.signal,
    });
  } catch (error) {
    // 网络层失败值得让框架重试（502），浏览器挂掉不值得（409）。
    sink({
      id: request.id,
      kind: 'error',
      message: request.signal.aborted ? '请求已取消' : `连接上游失败：${(error as Error).message}`,
      retryable: !request.signal.aborted,
    });
    return;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  sink({ id: request.id, kind: 'head', status: response.status, headers });
  if (!response.body) {
    sink({ id: request.id, kind: 'end' });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sink({ id: request.id, kind: 'chunk', data: decoder.decode(chunk.value, { stream: true }) });
    }
  } catch (error) {
    sink({ id: request.id, kind: 'error', message: (error as Error).message });
    return;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经结束的流取消失败是正常的。
    }
  }
  sink({ id: request.id, kind: 'end' });
}
