/**
 * 本地登录页：给「浏览器会话」型 provider 一个体面的登录流程。
 *
 * DeepSeek 网页版没有 OAuth，只有浏览器里的会话（token + cookie）。所以这里不假装能做
 * 单点登录，而是把「打开页面 → 在 DeepSeek 登录 → 把凭证交回来」这件事做顺：
 *
 *   1. `start()` 起一个只听 127.0.0.1 的一次性 HTTP 服务，端口由系统分配；
 *   2. 返回的 URL 由系统浏览器打开，页面给出可点的链接与粘贴框；
 *   3. 提交的凭证先**真的拿去验一次**（要一次 PoW 挑战），验过才落盘；
 *   4. 落盘后通知等待方，页面切到成功态，服务自动关闭。
 *
 * 安全取舍：
 *   - 只绑 `127.0.0.1`，不对外；
 *   - URL 里带一次性随机 token，别的页面猜不到；
 *   - 10 分钟没人完成就自己退出；
 *   - 凭证只写入端点目录，不留在内存日志里；
 *   - `frame-ancestors 'none'` 等头齐全，防被别的站点套壳。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_FILE, parseAuth, type WebAuth } from './auth.ts';
import { captureByBrowser } from './browser-signin.ts';

/** 一次登录最多等这么久，超时自动结束。 */
const SIGN_IN_MS = 10 * 60_000;
/** 页面上可粘贴的字段长度上限，防止被塞巨量内容。 */
const MAX_BODY_CHARS = 16_384;

export type SignInPhase = 'idle' | 'waiting' | 'verifying' | 'done' | 'failed' | 'expired';

export interface SignInStatus {
  phase: SignInPhase;
  /** 给操作员看的说明，界面语言由调用方决定。 */
  message?: string;
  /** 已登录时带上账号标识（token 的尾部指纹，绝不回传原值）。 */
  account?: string;
  /** 登录页地址；只在 `waiting` 时有。 */
  url?: string;
  /** 自动登录时的实时进度，面板直接显示。 */
  step?: string;
}

/** 验证凭证是否真的能用：拿一次 PoW 挑战，能拿到挑战就说明 token/cookie 没失效。 */
export type Verify = (auth: WebAuth) => Promise<void>;

interface Session {
  token: string;
  url: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  resolve: (auth: WebAuth | null) => void;
  settled: boolean;
}

/** 只用于展示的账号指纹：token 的 sha256 前 8 位，绝不回传原值。 */
function fingerprint(auth: WebAuth): string {
  return createHash('sha256').update(auth.token).digest('hex').slice(0, 8);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

function page(token: string, message: string, ok: boolean): string {
  // 页面故意做得很朴素：它只是一次性表单，不需要主题，也不该像 DeepSeek 的官方页。
  const action = `/submit?t=${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>DeepSeek Web 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
body{font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:34rem;margin:8vh auto;padding:0 20px}
h1{font-size:1.25rem;margin:0 0 .25rem}
p{color:#666;margin:.4rem 0}
ol{padding-left:1.2rem}
textarea{width:100%;height:11rem;font:12px/1.5 ui-monospace,Consolas,monospace;padding:10px;box-sizing:border-box}
button{margin-top:.75rem;padding:.55rem 1.2rem;font-size:.95rem;cursor:pointer}
.ok{color:#0a7}.bad{color:#c22}
code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:3px}
@media(prefers-color-scheme:dark){p{color:#aaa}}
</style></head><body>
<h1>DeepSeek Web 登录</h1>
<p class="${ok ? 'ok' : ''}">${escapeHtml(message)}</p>
${ok ? '' : `<ol>
<li>点开 <a href="https://chat.deepseek.com" target="_blank" rel="noreferrer">chat.deepseek.com</a> 并登录。</li>
<li>按 <code>F12</code> 打开开发者工具，切到 <strong>Network</strong> 面板，随便发一句话。</li>
<li>找到任意一个发往 <code>chat.deepseek.com</code> 的请求，右键 → <strong>Copy</strong> → <strong>Copy as cURL</strong>。</li>
<li>把复制到的内容整段粘进下面。</li>
</ol>
<form method="post" action="${action}">
<textarea name="paste" placeholder="把 Copy as cURL 的内容整段粘在这里" autofocus></textarea>
<div><button type="submit">提交并验证</button></div>
</form>
<p>也可以直接粘贴 <code>{"token":"…","cookie":"…","wasmUrl":"…"}</code> 形式的 JSON。</p>`}
</body></html>`;
}

/**
 * 从「Copy as cURL」文本里抠出 token、cookie 与 wasmUrl。
 * 这是给人用的入口，所以尽量宽容：Windows / bash 两种引号风格都认。
 */
export function parseCurl(text: string): { token?: string; cookie?: string } {
  const unquote = (value: string): string => value.trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\"/g, '"')
    .trim();
  // `-H 'Authorization: Bearer xxx'`、`--header "Cookie: ..."`、PowerShell 的 `-Headers @{Authorization="..."}`。
  const header = (name: string): string | undefined => {
    const flag = new RegExp(`(?:-H|--header|\\bheader)\\s+(['"])[\\s\\S]*?${name}\\s*:\\s*([\\s\\S]*?)\\1`, 'i').exec(text);
    if (flag?.[2]) return unquote(flag[2]);
    const hash = new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i').exec(text);
    return hash?.[2] ? unquote(hash[2]) : undefined;
  };
  const authorization = header('Authorization');
  const cookieHeader = header('Cookie');
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  return { token: token || undefined, cookie: cookieHeader || undefined };
}

/** 从页面站点里找一个能用的 wasmUrl：登录页自身会用，但通常随版本变化。 */
const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

export class WebSignIn {
  private session: Session | null = null;
  private last: SignInStatus = { phase: 'idle' };
  private cancelBrowser: AbortController | null = null;

  constructor(
    private readonly stateDir: () => string,
    private readonly verify: Verify,
    private readonly wasmUrl: () => string = () => DEFAULT_WASM,
  ) {}

  status(): SignInStatus {
    // 从没在本次进程里登录过、但磁盘上已有凭证 —— 这就是「已登录」。
    // 之前这里只回内存里的 `last`（初值 idle），导致刷新/重开后面板一律显示
    // 「尚未登录」，即使凭证好好的。
    if (this.last.phase === 'idle') {
      const saved = this.readSaved();
      if (saved) return { phase: 'done', account: fingerprint(saved) };
    }
    return { ...this.last };
  }

  /** 读磁盘上的凭证，读不出来返回 null。不验活——面板不该每次轮询都打上游。 */
  private readSaved(): WebAuth | null {
    try {
      return parseAuth(readFileSync(join(this.stateDir(), AUTH_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 内部：更新状态并留下进度，供面板轮询。 */
  private set(status: SignInStatus): SignInStatus {
    this.last = status;
    return this.status();
  }

  /**
   * 真自动：起一个独立浏览器，等你在里面登录，然后自动读凭证、验活、落盘。
   * 面板只负责显示 `step`。
   */
  async startAutomatic(): Promise<SignInStatus> {
    if (this.last.phase === 'waiting' || this.last.phase === 'verifying') return this.status();
    await this.cancel();
    const controller = new AbortController();
    this.cancelBrowser = controller;
    this.set({ phase: 'waiting', step: '正在准备浏览器…' });

    void (async () => {
      try {
        const captured = await captureByBrowser(step => this.set({ phase: 'waiting', step }), controller.signal);
        if (!captured) {
          this.set({ phase: 'idle', step: '已取消' });
          return;
        }
        this.set({ phase: 'verifying', step: '正在验证凭证是否有效…' });
        const auth: WebAuth = { ...captured, wasmUrl: this.wasmUrl() };
        await this.verify(auth);
        this.persist(auth);
        this.set({ phase: 'done', message: '登录成功', account: fingerprint(auth) });
      } catch (error) {
        if (controller.signal.aborted) {
          this.set({ phase: 'idle', step: '已取消' });
          return;
        }
        this.set({ phase: 'failed', message: (error as Error).message });
      } finally {
        if (this.cancelBrowser === controller) this.cancelBrowser = null;
      }
    })();

    return this.status();
  }

  /** 起一个一次性登录页，返回它的地址。重复调用会顶掉前一个。 */
  async start(): Promise<SignInStatus> {
    await this.cancel();
    const token = randomBytes(24).toString('hex');
    const server = createServer((request, response) => void this.handle(request, response, token));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('登录页没能拿到端口'));
      });
    });
    const url = `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`;
    const session: Session = {
      token, url, server,
      timer: setTimeout(() => void this.expire(), SIGN_IN_MS),
      resolve: () => {},
      settled: false,
    };
    this.session = session;
    this.last = { phase: 'waiting', url };
    return this.status();
  }

  /** 等这次登录有结果（成功给出 auth，取消/超时给出 null）。 */
  async wait(): Promise<WebAuth | null> {
    const session = this.session;
    if (!session) return null;
    return new Promise<WebAuth | null>(resolve => {
      session.resolve = resolve;
    });
  }

  async cancel(): Promise<void> {
    // 先中断自动登录：它会自己收尾（关浏览器、清临时目录）。
    if (this.cancelBrowser) {
      this.cancelBrowser.abort();
      this.cancelBrowser = null;
    }
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (!session.settled) {
      session.settled = true;
      session.resolve(null);
      if (this.last.phase === 'waiting') this.last = { phase: 'idle' };
    }
    clearTimeout(session.timer);
    await new Promise<void>(resolve => session.server.close(() => resolve()));
  }

  private async expire(): Promise<void> {
    const session = this.session;
    if (!session || session.settled) return;
    this.last = { phase: 'expired', message: '登录页超时，请重新点一次登录' };
    await this.cancel();
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, token: string): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const common: Record<string, string> = {
      // 一次性表单页：不许被别的站点套壳，也不许把凭证带出去。
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    if (url.searchParams.get('t') !== token) {
      response.writeHead(403, { ...common, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('链接无效或已过期');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page(token, '在 DeepSeek 登录后，把请求复制回来。', false));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/submit') {
      const body = await readBody(request);
      const result = await this.accept(body);
      response.writeHead(result.ok ? 200 : 400, { ...common, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page(token, result.message, result.ok));
      return;
    }

    response.writeHead(404, { ...common, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }

  /** 校验并落盘；页面与面板共用同一条路径。 */
  async accept(raw: string): Promise<{ ok: boolean; message: string }> {
    let auth: WebAuth;
    try {
      auth = extractAuth(raw, this.wasmUrl());
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    try {
      await this.verify(auth);
    } catch (error) {
      return { ok: false, message: `凭证验证失败：${(error as Error).message}` };
    }
    try {
      this.persist(auth);
    } catch (error) {
      return { ok: false, message: `写入凭证失败：${(error as Error).message}` };
    }
    const session = this.session;
    this.last = { phase: 'done', message: '登录成功', account: fingerprint(auth) };
    if (session && !session.settled) {
      session.settled = true;
      session.resolve(auth);
      clearTimeout(session.timer);
      // 页面已经回完了，稍等一下再关，免得浏览器看到空连接。
      setTimeout(() => void session.server.close(), 500);
      this.session = null;
    }
    return { ok: true, message: '验证通过，凭证已保存。可以关掉这个页面了。' };
  }

  /** 原子写：先写临时文件再改名，避免半个文件被读到。 */
  private persist(auth: WebAuth): void {
    const dir = this.stateDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, AUTH_FILE);
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = {
      token: auth.token,
      cookie: auth.cookie,
      ...(auth.hifDliq ? { hif_dliq: auth.hifDliq } : {}),
      ...(auth.hifLeim ? { hif_leim: auth.hifLeim } : {}),
      ...(auth.deviceId ? { deviceId: auth.deviceId } : {}),
      wasmUrl: auth.wasmUrl,
    };
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_CHARS) {
        reject(new Error('提交内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      // 表单提交是 application/x-www-form-urlencoded；直接 POST 原始文本也接受。
      const params = new URLSearchParams(text);
      resolve(params.get('paste') ?? text);
    });
    request.on('error', reject);
  });
}

/**
 * 把用户交回来的东西变成凭证：认三种输入——完整 JSON、Copy as cURL、只有 token+cookie 的两行。
 */
export function extractAuth(raw: string, fallbackWasm: string): WebAuth {
  const text = raw.trim();
  if (!text) throw new Error('没有收到内容');

  if (text.startsWith('{')) {
    // `parseAuth` 要求三个字段齐全，但登录页只该向用户要 token 与 cookie；
    // wasmUrl 缺了就用默认值补上，补完再交给严格的校验器。
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`不是合法 JSON：${(error as Error).message}`);
    }
    if (!json || typeof json !== 'object') throw new Error('JSON 必须是一个对象');
    const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const merged = {
      ...json,
      wasmUrl: asText(json.wasmUrl) ?? asText(json.wasm_url) ?? fallbackWasm,
      hif_dliq: asText(json.hif_dliq) ?? asText(json.hifDliq),
      hif_leim: asText(json.hif_leim) ?? asText(json.hifLeim),
    };
    return parseAuth(JSON.stringify(merged));
  }

  const fromCurl = parseCurl(text);
  if (fromCurl.token && fromCurl.cookie) {
    return { token: fromCurl.token, cookie: fromCurl.cookie, wasmUrl: fallbackWasm };
  }

  // 兜底：整段里直接找 `Bearer xxx` 与 `ds_session_id=`。
  const bearer = /Bearer\s+([A-Za-z0-9._-]{20,})/.exec(text);
  const session = /(ds_session_id=[^\s;'"]+(?:;\s*smidV2=[^\s;'"]+)?)/.exec(text);
  if (bearer?.[1] && session?.[1]) {
    return { token: bearer[1], cookie: session[1], wasmUrl: fallbackWasm };
  }
  throw new Error('没认出凭证：请粘贴完整的 「Copy as cURL」 内容，或 {"token":"…","cookie":"…"} 形式的 JSON');
}
