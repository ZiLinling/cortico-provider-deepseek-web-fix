/**
 * 页面桥：在一个真实标签页里执行 `fetch`，把结果传回 Node。
 *
 * 两条路径：
 *   - `stream()`：补全用。响应头一拿到就回传，正文按分片走 `Runtime.bindingCalled`
 *     逐块送回，保住逐字输出。
 *   - `request()`：建会话 / 挑战 / 上传 / 轮询 / 探活用。整段读回，一次 evaluate 就够。
 *
 * 为什么要两条：`awaitPromise` 会等整个 body 读完，流式场景下等于「等 8 秒一次性蹦出来」；
 * 而小 JSON 响应走绑定回传是白白增加复杂度。
 */
import type { CdpConnection, CdpEvent } from './client.ts';

export interface PageEmit {
  id: string;
  kind: 'head' | 'chunk' | 'end' | 'error';
  status?: number;
  headers?: Record<string, string>;
  data?: string;
  message?: string;
  /** 只有 Node 直连的网络错误会置 true：这种值得让框架重试，浏览器挂掉则不值得。 */
  retryable?: boolean;
}

export interface PageRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

export interface PageInit {
  method?: string;
  headers?: Record<string, string>;
  /** 字符串（JSON）或 multipart 描述。 */
  body?: string | { __form: Array<{ name: string; filename?: string; type?: string; b64: string }> };
  redirect?: string;
}

/** 注入页面的脚本。只做四件事：发请求、回传头、回传分片、支持中断。 */
const PAGE_SCRIPT = String.raw`(() => {
  if (window.__dsTransport) return 'ready';
  const live = new Map();
  const emit = (payload) => { try { window.__dsEmit(JSON.stringify(payload)); } catch (e) {} };

  const buildInit = (init) => {
    const out = {
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      credentials: 'include',
      redirect: (init && init.redirect) || 'error',
    };
    const body = init && init.body;
    if (body && typeof body === 'object' && Array.isArray(body.__form)) {
      const form = new FormData();
      for (const part of body.__form) {
        const binary = atob(part.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        form.append(part.name, new File([bytes], part.filename || 'file', { type: part.type || 'application/octet-stream' }));
      }
      out.body = form;
    } else if (typeof body === 'string') {
      out.body = body;
    }
    return out;
  };

  const readHeaders = (response) => {
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return headers;
  };

  window.__dsTransport = {
    async request(id, path, init) {
      const controller = new AbortController();
      live.set(id, controller);
      try {
        const response = await fetch(path, Object.assign(buildInit(init), { signal: controller.signal }));
        const text = await response.text();
        return { status: response.status, headers: readHeaders(response), body: text };
      } catch (error) {
        return { status: 0, headers: {}, body: '', error: String((error && error.message) || error) };
      } finally {
        live.delete(id);
      }
    },

    async send(id, path, init) {
      const controller = new AbortController();
      live.set(id, controller);
      try {
        const response = await fetch(path, Object.assign(buildInit(init), { signal: controller.signal }));
        emit({ id: id, kind: 'head', status: response.status, headers: readHeaders(response) });
        if (!response.body) { emit({ id: id, kind: 'end' }); return; }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          emit({ id: id, kind: 'chunk', data: decoder.decode(chunk.value, { stream: true }) });
        }
        emit({ id: id, kind: 'end' });
      } catch (error) {
        emit({ id: id, kind: 'error', message: String((error && error.message) || error) });
      } finally {
        live.delete(id);
      }
    },

    abort(id) {
      const controller = live.get(id);
      if (controller) controller.abort();
    },

    /** 诊断用：还有几条请求在页面里跑着。中断没生效时会大于 0。 */
    liveCount() { return live.size; },
  };
  return 'ready';
})()`;

/**
 * 把 `a=b; c=d` 形式的 Cookie 头拆成条目。
 *
 * 单独抽出来是为了能测：cookie 值里允许出现 `=`（base64 常见），所以只能按**第一个**
 * `=` 切；空名、空段都要丢掉。
 */
export function parseCookieHeader(header: string | null | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out.push({ name, value: part.slice(index + 1).trim() });
  }
  return out;
}

export class PageBridge {
  private installed = false;
  private requestSeq = 0;
  private readonly listeners = new Set<(message: PageEmit) => void>();
  private readonly dispose: () => void;

  private constructor(
    private readonly connection: CdpConnection,
    private readonly session: string,
    private readonly origin: string,
  ) {
    this.dispose = connection.on(event => this.handle(event));
  }

  /** 找到一个属于目标站点的标签页；没有就新建一个。 */
  static async attach(connection: CdpConnection, origin: string): Promise<PageBridge> {
    const targets = await connection.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string }> }>(
      'Target.getTargets',
    );
    const pages = (targets.targetInfos ?? []).filter(info => info.type === 'page');
    const existing = pages.find(info => info.url.startsWith(origin)) ?? pages[0];
    const targetId = existing?.targetId ?? (await connection.send<{ targetId: string }>('Target.createTarget', { url: origin })).targetId;

    const attached = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.sessionId;
    await connection.send('Page.enable', {}, session);
    await connection.send('Runtime.enable', {}, session);

    if (!existing || !existing.url.startsWith(origin)) {
      await connection.send('Page.navigate', { url: origin }, session);
    }

    const bridge = new PageBridge(connection, session, origin);
    await bridge.waitForOrigin();
    return bridge;
  }

  get url(): string {
    return this.origin;
  }

  onEmit(handler: (message: PageEmit) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** 等页面真正停在目标站点上；否则 `fetch('/api/...')` 会打到 about:blank。 */
  private async waitForOrigin(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const evaluated = await this.connection.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      }, this.session).catch(() => null);
      if (evaluated?.result?.value === this.origin) return;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`浏览器页面没有停在 ${this.origin}（可能被网络拦截或需要代理）`);
  }

  /** 注入脚本并注册回传绑定。重复调用是安全的。 */
  async install(): Promise<void> {    if (this.installed) return;
    await this.connection.send('Runtime.addBinding', { name: '__dsEmit' }, this.session).catch(() => {
      // 已经注册过会报错；这不是问题。
    });
    const evaluated = await this.connection.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: PAGE_SCRIPT,
      returnByValue: true,
    }, this.session);
    if (evaluated?.exceptionDetails) throw new Error('注入页面脚本失败（页面可能已跳转）');
    this.installed = true;
  }

  async request(path: string, init: PageInit, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PageRequestResult> {
    const result = await this.evaluateRequest(path, init, options);
    // 页面跳转会把脚本冲掉，表现为「找不到 __dsTransport」。重装一次再试。
    if (result.status === 0 && /__dsTransport|undefined/i.test(result.error ?? '')) {
      this.installed = false;
      await this.install();
      return await this.evaluateRequest(path, init, options);
    }
    return result;
  }

  private async evaluateRequest(
    path: string,
    init: PageInit,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PageRequestResult> {
    await this.install();
    if (options.signal?.aborted) {
      return { status: 0, headers: {}, body: '', error: '请求已取消' };
    }
    const id = `q${++this.requestSeq}`;
    // 非流式调用也要能取消：上传一张几 MB 的图可能十几秒，用户点停止时不该还在传。
    const onAbort = (): void => {
      void this.abort(id);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const evaluated = await this.connection.send<{
        result?: { value?: PageRequestResult };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>('Runtime.evaluate', {
        expression: `window.__dsTransport.request(${JSON.stringify(id)}, ${JSON.stringify(path)}, ${JSON.stringify(init)})`,
        awaitPromise: true,
        returnByValue: true,
      }, this.session, options.timeoutMs ?? 60_000);
      if (evaluated?.exceptionDetails) {
        const text = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? '页面执行失败';
        return { status: 0, headers: {}, body: '', error: text };
      }
      return evaluated?.result?.value ?? { status: 0, headers: {}, body: '', error: '页面没有返回结果' };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 发起流式请求；结果通过 `onEmit` 回来。 */
  async stream(id: string, path: string, init: PageInit): Promise<void> {
    await this.install();
    const evaluated = await this.connection.send<{ exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression: `window.__dsTransport.send(${JSON.stringify(id)}, ${JSON.stringify(path)}, ${JSON.stringify(init)})`,
      awaitPromise: false,
      returnByValue: false,
    }, this.session);
    if (evaluated?.exceptionDetails) {
      throw new Error(`页面发起请求失败：${evaluated.exceptionDetails.text ?? '未知原因'}`);
    }
  }

  async abort(id: string): Promise<void> {
    await this.connection.send('Runtime.evaluate', {
      expression: `window.__dsTransport && window.__dsTransport.abort(${JSON.stringify(id)})`,
      returnByValue: true,
    }, this.session).catch(() => {
      // 页面已经没了，没必要再报错。
    });
  }

  /** 在页面里求值。只给自检与排障用，不参与业务链路。 */
  async evaluate<T>(expression: string): Promise<T | null> {
    const evaluated = await this.connection.send<{ result?: { value?: T } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }, this.session).catch(() => null);
    return evaluated?.result?.value ?? null;
  }

  /**
   * 把已有凭证里的 cookie 灌进浏览器。
   *
   * 为什么需要：页面 `fetch` 不能手工设 `Cookie`（禁止头），而浏览器自己的 profile 是全新的、
   * 里面没有登录态。不灌就等于「换了发送方但没带会话」。灌完之后 `deepseek-auth.json` 里的
   * 凭证仍然有效，用户**不需要重新登录**。
   *
   * 只在浏览器里的会话与磁盘不一致时灌：用户手动登录过、或者重新登录过一次，浏览器里的
   * WAF 会话已经更新，这时要**跟着磁盘走**，不能因为「已经有 ds_session_id」就跳过。
   */
  async ensureCookies(cookieHeader: string | null): Promise<boolean> {
    const wanted = parseCookieHeader(cookieHeader);
    if (!wanted.length) return false;

    const existing = await this.connection.send<{ cookies?: Array<{ name: string; value: string }> }>(
      'Network.getCookies', { urls: [`${this.origin}/`] }, this.session,
    ).catch(() => null);
    const live = new Map((existing?.cookies ?? []).map(cookie => [cookie.name, cookie.value]));
    // 全部一致才算「已经是最新」；只要有一项不同就整体覆盖。
    const current = wanted.every(cookie => live.get(cookie.name) === cookie.value);
    if (current) return false;

    const cookies = wanted.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      url: `${this.origin}/`,
      path: '/',
    }));
    await this.connection.send('Network.setCookies', { cookies }, this.session);
    return true;
  }

  disposeBridge(): void {
    this.dispose();
    this.listeners.clear();
  }

  private handle(event: CdpEvent): void {
    if (event.sessionId !== this.session) return;
    // 页面跳转/刷新会让注入的脚本消失，标记为需要重装。
    if (event.method === 'Runtime.executionContextsCleared' || event.method === 'Page.frameNavigated') {
      this.installed = false;
      return;
    }
    if (event.method !== 'Runtime.bindingCalled') return;
    if (event.params.name !== '__dsEmit') return;
    const payload = event.params.payload;
    if (typeof payload !== 'string') return;
    let message: PageEmit;
    try {
      message = JSON.parse(payload) as PageEmit;
    } catch {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // 单个订阅者出错不影响其它订阅者。
      }
    }
  }
}
