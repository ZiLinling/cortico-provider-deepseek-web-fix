/**
 * 用 CDP 驱动一个独立的浏览器配置，把「登录 DeepSeek」这件事变成一次点击。
 *
 * 为什么不用宿主开窗口：provider 扩展拿不到主进程的窗口能力（`ProviderWebUiHost` 只有
 * entries/instance/save）。但扩展**可以自己起一个 Chromium**——所以走 CDP。
 *
 * 为什么用独立 profile：绝不碰你日常浏览器的数据，也避免 Edge/Chrome 正在运行时
 * 因为 profile 被占用而启动失败。代价是这个窗口里要重新登录一次 DeepSeek。
 *
 * 流程：
 *   1. 起浏览器（Edge 优先，其次 Chrome），打开 chat.deepseek.com；
 *   2. 轮询 `ds_session_id` cookie 出现，并读 localStorage 里的 token；
 *   3. 拿到两样就交给上层验活、落盘；
 *   4. 关窗口、删临时目录。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGN_IN_URL = 'https://chat.deepseek.com';
/** 全流程超时：给人登录的时间。 */
const DEADLINE_MS = 8 * 60_000;
const POLL_MS = 1_500;

export interface BrowserFound {
  path: string;
  name: 'Edge' | 'Chrome';
}

export function findBrowser(prefer?: 'edge' | 'chrome'): BrowserFound | null {
  const candidates: Array<{ path: string; name: 'Edge' | 'Chrome' }> = [
    // Windows（实测过）
    { path: `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`, name: 'Edge' },
    { path: `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`, name: 'Edge' },
    { path: `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`, name: 'Chrome' },
    { path: `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`, name: 'Chrome' },
    { path: `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`, name: 'Chrome' },
    // macOS / Linux：只做路径兜底，没有实测过。
    { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', name: 'Edge' },
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', name: 'Chrome' },
    { path: '/usr/bin/microsoft-edge', name: 'Edge' },
    { path: '/usr/bin/microsoft-edge-stable', name: 'Edge' },
    { path: '/usr/bin/google-chrome', name: 'Chrome' },
    { path: '/usr/bin/google-chrome-stable', name: 'Chrome' },
    { path: '/usr/bin/chromium', name: 'Chrome' },
    { path: '/usr/bin/chromium-browser', name: 'Chrome' },
  ];
  // 传输通道允许指定浏览器；登录流程不指定，按 Edge 优先的默认顺序。
  const wanted = prefer === 'edge' ? 'Edge' : prefer === 'chrome' ? 'Chrome' : null;
  for (const candidate of candidates) {
    if (wanted && candidate.name !== wanted) continue;
    if (candidate.path && existsSync(candidate.path)) return candidate;
  }
  return null;
}

type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

interface CdpClient {
  send: Send;
  close(): void;
}

/** 极简 CDP 客户端：一个 WebSocket，按 id 配对 Promise。 */
async function connect(wsUrl: string): Promise<CdpClient> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('连不上浏览器调试端口')), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', event => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP 错误'));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          pending.delete(id);
          reject(error as Error);
        }
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}

async function waitForDebugger(port: number, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const info = await response.json() as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('浏览器没有在预期时间内打开调试端口');
}

export interface CapturedCredential {
  token: string;
  cookie: string;
  /** 网页里的设备标识；上游用它做风控分组，优先于派生值。 */
  deviceId?: string;
  hifDliq?: string;
  hifLeim?: string;
}

export type Progress = (message: string) => void;

/**
 * 开窗口等登录，成功后返回凭证。`signal` 中断时关窗口并返回 null。
 */
export async function captureByBrowser(onProgress: Progress, signal: AbortSignal): Promise<CapturedCredential | null> {
  const browser = findBrowser();
  if (!browser) throw new Error('没找到 Edge 或 Chrome，装一个再试');

  const profile = mkdtempSync(join(tmpdir(), 'coopanion-ds-signin-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  let child: ChildProcess | null = null;
  let client: CdpClient | null = null;
  const cleanup = (): void => {
    client?.close();
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }
    // Chromium 关进程后 profile 目录还要一小会儿才释放。
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 占用中就留给系统清理 */
      }
    }, 1_500);
  };

  try {
    onProgress(`正在打开 ${browser.name}（独立配置，不影响你日常浏览器）`);
    child = spawn(browser.path, [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-sync',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      SIGN_IN_URL,
    ], { stdio: 'ignore' });

    const deadline = Date.now() + DEADLINE_MS;
    const wsUrl = await waitForDebugger(port, deadline);
    client = await connect(wsUrl);

    // 找到那个已打开 chat.deepseek.com 的页面。
    const targets = await client.send('Target.getTargets') as { targetInfos?: Array<{ targetId: string; type: string; url: string }> };
    const page = (targets.targetInfos ?? []).find(info => info.type === 'page');
    if (!page) throw new Error('浏览器没有打开任何页面');
    const attached = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }) as { sessionId: string };
    const session = attached.sessionId;

    // 把页面导航到登录地址（浏览器可能还没跳过去）。
    await client.send('Page.enable', {}, session);
    await client.send('Page.navigate', { url: SIGN_IN_URL }, session);

    onProgress('请在打开的窗口里登录 DeepSeek；登录完成后会自动继续');

    while (Date.now() < deadline) {
      if (signal.aborted) {
        onProgress('已取消');
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));

      // 1) token：`localStorage['userToken']` 是**唯一可靠**的登录标志。
      //    实测结构：{"value":"<64 字符 base64>","__version":...}
      //    不要用 ds_session_id 判断 —— 未登录时它也存在，会造成假阳性。
      const evaluated = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const read = (store, key) => {
            try { return store.getItem(key); } catch (e) { return null; }
          };
          return JSON.stringify({
            userToken: read(localStorage, 'userToken'),
            deviceId: read(localStorage, 'deepseek-device-id:chat'),
            cookie: read(localStorage, 'smidV2'),
          });
        })()`,
        returnByValue: true,
      }, session).catch(() => null) as { result?: { value?: string } } | null;

      const raw = evaluated?.result?.value;
      if (!raw) continue;
      let store: { userToken?: string | null; deviceId?: string | null };
      try {
        store = JSON.parse(raw) as typeof store;
      } catch {
        continue;
      }
      const token = parseUserToken(store.userToken ?? null);
      if (!token) {
        onProgress('请在打开的窗口里登录 DeepSeek；登录完成后会自动继续');
        continue;
      }

      // 2) cookie：实测需要的都在里面。全量带上，别挑 —— HWWAFSESID /
      //    HWWAFSESTIME 是 WAF 会话，少了容易被风控拦。
      const cookieResult = await client.send('Network.getCookies', { urls: [`${SIGN_IN_URL}/`] }, session).catch(() => ({ cookies: [] })) as {
        cookies?: Array<{ name: string; value: string }>;
      };
      const cookies = cookieResult.cookies ?? [];
      if (!cookies.length) {
        onProgress('已读到 token，但还没拿到 cookie，稍等…');
        continue;
      }

      const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const deviceId = (store.deviceId ?? '').trim();
      onProgress('已拿到凭证，正在验证');
      return { token, cookie: cookieHeader, ...(deviceId ? { deviceId } : {}) };
    }
    throw new Error('等待登录超时');
  } finally {
    cleanup();
  }
}

/**
 * 解析 `localStorage['userToken']`。
 *
 * 实测结构（2026-10）：`{"value":"<64 字符 base64>","__version":"0"}`
 * —— 值本身也可能没包 JSON，所以两种都认。
 */
export function parseUserToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { value?: unknown };
      if (typeof parsed.value === 'string' && looksLikeToken(parsed.value)) return parsed.value;
    } catch {
      return null;
    }
    return null;
  }
  return looksLikeToken(text) ? text : null;
}

/** DeepSeek 的 token 是 64 位左右、含 `+` `/` 的 base64，和 JWT 区分开。 */
function looksLikeToken(value: string): boolean {
  return value.length >= 40 && value.length <= 200 && /^[A-Za-z0-9+/=_-]+$/.test(value) && !value.startsWith('eyJ');
}
