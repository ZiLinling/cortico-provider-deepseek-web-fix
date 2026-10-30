/**
 * 浏览器进程的启动、复用与关闭。
 *
 * 为什么用独立 profile：绝不碰用户日常浏览器的数据；同时 `--remote-debugging-port`
 * 在默认 profile 上会被 Chromium 拒绝（安全策略），必须配独立 `--user-data-dir`。
 *
 * profile 是**持久化**的：登录一次之后 cookie 留在里面，通道随时可用，不必每次重登。
 * 代价是这个目录里存着 DeepSeek 的登录态，敏感级别等同 `deepseek-auth.json`。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { findBrowser } from '../browser-signin.ts';

export interface BrowserEndpoint {
  port: number;
  wsUrl: string;
  version: string;
}

export interface BrowserHostOptions {
  /** 持久化 profile 目录。 */
  profileDir: string;
  /** 记录端口，供扩展重载后复用同一个浏览器。 */
  stateFile: string;
  log: Logger;
  channel: () => 'auto' | 'edge' | 'chrome';
  headless: () => boolean;
}

interface PortRecord {
  port: number;
  /** 启动时的产品串；复用前比对，避免端口被别的 Chromium 占用时误连。 */
  product?: string;
}

/** 调试端口从这段区间随机取，避开常用端口。 */
const PORT_MIN = 50_000;
const PORT_SPAN = 10_000;
const START_TIMEOUT_MS = 30_000;

function randomPort(): number {
  return PORT_MIN + Math.floor(Math.random() * PORT_SPAN);
}

async function probe(port: number): Promise<BrowserEndpoint | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    const info = await response.json() as { webSocketDebuggerUrl?: string; Browser?: string };
    if (!info.webSocketDebuggerUrl) return null;
    return { port, wsUrl: info.webSocketDebuggerUrl, version: info.Browser ?? 'unknown' };
  } catch {
    return null;
  }
}

export class BrowserHost {
  private child: ChildProcess | null = null;
  /** 当前浏览器是不是本进程起的；不是的话退出时不要杀它。 */
  private owned = false;
  private endpoint: BrowserEndpoint | null = null;

  constructor(private readonly opts: BrowserHostOptions) {}

  describe(): string {
    return this.endpoint ? `${this.endpoint.version} (port ${this.endpoint.port})` : '未启动';
  }

  async ensure(): Promise<BrowserEndpoint> {
    if (this.endpoint) {
      const alive = await probe(this.endpoint.port);
      if (alive) return alive;
      this.endpoint = null;
    }

    // 上一次进程可能留下一个还在跑的浏览器（扩展重载、应用异常退出）。能连上就直接用，
    // 避免「profile 被占用 → 新进程起不来」这个很难解释的失败。
    const reused = await this.reuse();
    if (reused) {
      this.endpoint = reused;
      this.opts.log.debug?.(`DeepSeek Web：复用已在运行的浏览器（端口 ${reused.port}）`);
      return reused;
    }

    return await this.launch();
  }

  private async reuse(): Promise<BrowserEndpoint | null> {
    try {
      const record = JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as PortRecord;
      if (!Number.isInteger(record.port) || record.port <= 0) return null;
      const endpoint = await probe(record.port);
      if (!endpoint) return null;
      // 端口可能被别的 Chromium（包括用户日常浏览器）复用。产品串对不上就不认，
      // 否则会把请求发进别人的浏览器——那比冷启动糟糕得多。
      if (record.product && endpoint.version !== record.product) {
        this.opts.log.debug?.(`DeepSeek Web：端口 ${record.port} 上是另一个浏览器，不复用`);
        return null;
      }
      return endpoint;
    } catch {
      return null;
    }
  }

  private async launch(): Promise<BrowserEndpoint> {
    const prefer = this.opts.channel();
    const browser = findBrowser(prefer === 'auto' ? undefined : prefer);
    if (!browser) {
      throw new Error(
        prefer === 'auto'
          ? '没找到 Edge 或 Chrome。装一个再开浏览器通道，或把通道切回 Node。'
          : `没找到 ${prefer === 'edge' ? 'Edge' : 'Chrome'}。换个浏览器通道，或把通道切回 Node。`,
      );
    }
    mkdirSync(this.opts.profileDir, { recursive: true });
    const port = randomPort();
    const args = [
      `--user-data-dir=${this.opts.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-sync',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      // 不加 --enable-automation：那会把 navigator.webdriver 置为 true，页面脚本可读。
      ...(this.opts.headless() ? ['--headless=new'] : []),
      'about:blank',
    ];
    this.opts.log.info(`DeepSeek Web：启动 ${browser.name} 作为传输通道（独立 profile）`);
    const child = spawn(browser.path, args, { stdio: 'ignore' });
    this.child = child;
    this.owned = true;

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const endpoint = await probe(port);
      if (endpoint) {
        this.endpoint = endpoint;
        try {
          writeFileSync(this.opts.stateFile, JSON.stringify({ port, product: endpoint.version } satisfies PortRecord), 'utf8');
        } catch {
          // 记不下端口只是下次要冷启动，不影响本次。
        }
        this.opts.log.debug?.(`DeepSeek Web：浏览器就绪（${endpoint.version}，端口 ${port}）`);
        return endpoint;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const reason = child.exitCode !== null
      ? `浏览器进程提前退出（退出码 ${child.exitCode}）`
      : '浏览器没有在预期时间内打开调试端口';
    this.kill();
    throw new Error(
      `${reason}。常见原因：profile 目录被另一个浏览器占用（${join(this.opts.profileDir)}）。`
      + '关掉那个窗口再试，或把通道切回 Node。',
    );
  }

  /** 只杀本进程起的浏览器；复用别人的不要动。 */
  kill(): void {
    if (this.child && this.owned && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        /* 已经退出 */
      }
    }
    this.child = null;
    this.owned = false;
    this.endpoint = null;
  }

  /** profile 是否已经存在（用来判断「是不是第一次用，要登录」）。 */
  hasProfile(): boolean {
    return existsSync(this.opts.profileDir);
  }
}
