/**
 * 包入口：默认导出 `ProviderModule`。
 *
 * 这是一个 **web-session** 型 provider：没有 API Key，用浏览器里的 DeepSeek 会话
 * （token + cookie）直接调 `chat.deepseek.com` 的私有接口，因此不需要在本地或服务器
 * 上再跑一个反代容器。
 *
 * 关于「反代模式」：试过，撤掉了。DeepSeek 网页版没有原生 function calling，所以
 * 反代（`_reference/server.js`）做的也是**把工具写进系统提示词、再从文本里抠 JSON**
 * ——和这里一模一样，只是搬到另一个进程里。既然同一个模拟，就没必要维护第二条路；
 * 真有反代的人直接用官方的 `openai-chat-compat` 模块即可。
 *
 * 识图默认开 —— Cortico 的「多模态」开关即可关闭。
 *
 * 不实现 `availability()`：凭证住在端点目录的 `deepseek-auth.json` 里，而该钩子的
 * 签名拿不到 `host`，读不到文件。假装能判断比不判断更糟——缺凭证时由客户端在第一次
 * 请求上给出明确报错，并说明该放哪个文件。
 */
// availability 不实现的原因见文件头注释。
import type { ProviderModule, ListedModel } from 'cortico/providers/base.ts';
import type { ReasoningTier } from 'cortico/core/types.ts';
import type { Logger } from 'cortico/core/types.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { AUTH_FILE, authHeaders, deviceIdFor, loadAuth, type WebAuth } from './auth.ts';
import { Transport, type BrowserChoice, type BrowserMode, type TransportOptions } from './cdp/index.ts';
import { createClient } from './client.ts';
import { AccountHealth } from './health.ts';
import { MODELS } from './models.ts';
import { SessionBridge } from './session.ts';
import { WebSignIn, extractAuth } from './signin.ts';
import { RequestGate, type ThrottleOptions } from './throttle.ts';

/** 登录面板的 id；与 `src/webui/client.ts` 的 `panels` 键一致。 */
const SIGNIN_PANEL = 'signin';
/** 传输通道面板的 id。 */
const TRANSPORT_PANEL = 'transport';
const CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';

interface Texts {
  title: string;
  description: string;
  off: string;
  on: string;
  onNote: string;
}

const TEXT: Record<'zh' | 'en', Texts> = {
  zh: {
    title: 'DeepSeek Web（修复版）',
    description: '支持工具调用提取、参数校验和分类前缀清理。用浏览器里的 DeepSeek 网页会话直接对话与识图，不需要本地反代进程。工具调用靠提示词模拟（网页版没有原生 function calling），默认全部放行，可在端点配置里用白名单收窄。',
    off: '关闭深度思考',
    on: '开启深度思考（DeepThink）',
    onNote: 'DeepSeek 网页版只有开与关，没有强度档位。',
  },
  en: {
    title: 'DeepSeek Web (fix)',
    description: 'Supports tool-call extraction, validation and metadata cleanup. Talk to DeepSeek through a browser web session, with image understanding and no local proxy. Tool calls are simulated in the prompt (the web app has no native function calling); every tool is allowed by default and can be narrowed with an allowlist.',
    off: 'Thinking off',
    on: 'Thinking on (DeepThink)',
    onNote: 'DeepSeek Web only has on and off; there are no effort levels.',
  },
};

/** WebUI 的语言不止中英，落到这里只需要分两支。 */
function texts(language: Language): Texts {
  return language === 'zh' ? TEXT.zh : TEXT.en;
}

/**
 * 从端点 `options.*` 读节流参数；缺省用 `THROTTLE_DEFAULTS`。
 * 认不出的值一律退回默认——宁可按保守值跑，也不要因为一个手滑的 0 把闸门关掉。
 */
function readThrottle(entry: { options?: unknown }, log: Logger): ThrottleOptions {
  const options = (entry.options && typeof entry.options === 'object' ? entry.options : {}) as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const raw = options[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    minIntervalMs: num('minIntervalMs'),
    maxIntervalMs: num('maxIntervalMs'),
    maxInWindow: num('rateMaxInWindow'),
    log,
  };
}

function tiers(language: Language): ReasoningTier[] {
  const t = texts(language);
  return [
    { id: 'off', label: t.off, thinking: false },
    { id: 'on', label: t.on, thinking: true, effort: 'on', note: t.onNote },
  ];
}

/** 上游把上下文超限说成「内容过长」，中文与俄文两种文案都出现过。 */
function contextOverflow(error: { status: number; body: string }): boolean {
  return isContextOverflow(error)
    || (error.status === 400 && /内容过长|content too long|Содержание слишком длинное|上下文|too long/i.test(error.body));
}

/**
 * 接管「草稿端点」留下的状态。
 *
 * 为什么会这样：面板在**未保存**的端点上登录时，状态目录是 `providers/draft`；
 * 保存成新端点后状态目录变成 `providers/<name>`，凭证（以及浏览器 profile）就留在
 * `draft/` 里没跟过去。表现是「明明登录过了」，但每轮都报凭证缺失——从日志上极难看出来。
 *
 * 只搬目标目录**没有**的东西，绝不覆盖已有状态。
 */
function adoptDraftState(stateDir: string, log: Logger): void {
  const draftDir = join(dirname(stateDir), 'draft');
  if (!existsSync(draftDir)) return;

  const targetAuth = join(stateDir, AUTH_FILE);
  if (!existsSync(targetAuth)) {
    const draftAuth = join(draftDir, AUTH_FILE);
    if (existsSync(draftAuth)) {
      try {
        copyFileSync(draftAuth, targetAuth);
        log.info(`DeepSeek Web：已从草稿端点接管凭证（${stateDir}）`);
        // 之前那条冷却是因为「没有凭证」才产生的，搬完就没意义了；不清会白等十分钟。
        rmSync(join(stateDir, 'account-health.json'), { force: true });
      } catch (error) {
        log.warn(`DeepSeek Web：从草稿端点接管凭证失败（${(error as Error).message}）`);
      }
    }
  }

  // 浏览器 profile 可能有几百 MB：用 rename 而不是 copy。草稿的浏览器还开着时会失败，
  // 那种情况只提示一句，用户下次在正式端点里登录即可。
  const targetProfile = join(stateDir, 'browser-profile');
  if (!existsSync(targetProfile)) {
    const draftProfile = join(draftDir, 'browser-profile');
    if (existsSync(draftProfile)) {
      try {
        renameSync(draftProfile, targetProfile);
        log.info(`DeepSeek Web：已从草稿端点接管浏览器 profile（${stateDir}）`);
      } catch (error) {
        log.warn(`DeepSeek Web：草稿端点的浏览器 profile 没搬过来（${(error as Error).message}）`);
      }
    }
  }
}

const DEEPSEEK_WEB: ProviderModule = {
  id: 'deepseek-web-fix',
  title: TEXT.zh.title,
  description: TEXT.zh.description,
  describe: {
    // 上游是 DeepSeek 自己的网页协议，既不是 Responses 也不是 Chat Completions。
    protocols: ['deepseek-web'],
    auth: ['web-session'],
    local: false,
    input: ['text', 'image'],
  },
  defaultBaseUrl: 'https://chat.deepseek.com',
  baseUrlSuggestions: ['https://chat.deepseek.com'],
  reasoningTiers: tiers('zh'),
  serviceTiers: [],
  localize: language => {
    const t = texts(language);
    return { title: t.title, description: t.description, reasoningTiers: tiers(language) };
  },
  contextOverflow,
  accepts: (entry, _spec, mime) => entry.multimodal === true && mime.startsWith('image/'),
  config: (name, _entry, language) => {
    const zh = language === 'zh';
    const owner = 'provider:deepseek-web-fix';
    // 拆成两组：设置页里「工具」和「限速/通道」是两件事，混在一起很难找。
    const tools: ConfigGroup = {
      id: `llm.deepseek-web-fix.${name}`,
      owner,
      schema: {
        type: 'object',
        title: zh ? '工具' : 'Tools',
        properties: {
          [`providers.${name}.options.tools`]: {
            type: 'string',
            title: zh ? '放行名单' : 'Allowed tools',
            description: zh
              ? '逗号分隔的工具名白名单。留空 = 全部放行（先全开、实测后再收敛）；填 none = 全部关闭，只做纯对话。'
              : 'Comma-separated allowlist. Empty = allow every tool; "none" = conversation only.',
          },
        },
      },
    };
    const transport: ConfigGroup = {
      id: `llm.deepseek-web-fix.${name}.transport`,
      owner,
      schema: {
        type: 'object',
        title: zh ? '请求与通道' : 'Requests and transport',
        properties: {
          [`providers.${name}.options.minIntervalMs`]: {
            type: 'integer',
            minimum: 0,
            maximum: 60_000,
            title: zh ? '请求间隔下限（毫秒）' : 'Min interval (ms)',
            description: zh
              ? '两次请求之间至少隔多久。默认 2000。固定间隔的方差≈0，是最明显的「定时器特征」，所以配合上限随机取值。'
              : 'Minimum gap between requests. Default 2000. A fixed interval has near-zero variance and looks like a timer, so it is randomized with the maximum.',
          },
          [`providers.${name}.options.maxIntervalMs`]: {
            type: 'integer',
            minimum: 0,
            maximum: 120_000,
            title: zh ? '请求间隔上限（毫秒）' : 'Max interval (ms)',
            description: zh
              ? '默认 4000。实际等待在上下限之间随机取值。调低会明显提高被限流的风险。'
              : 'Default 4000. The actual wait is random between the bounds. Lowering it raises the risk of being throttled.',
          },
          [`providers.${name}.options.rateMaxInWindow`]: {
            type: 'integer',
            minimum: 0,
            maximum: 200,
            title: zh ? '30 分钟内最多请求数' : 'Max requests per 30 min',
            description: zh
              ? '默认 20。超过就强制长休 60~180 秒。填 0 关掉这道闸（不建议）。'
              : 'Default 20. Past it the provider rests for 60-180 seconds. 0 disables this gate (not recommended).',
          },
          [`providers.${name}.options.maxRefImages`]: {
            type: 'integer',
            minimum: 0,
            maximum: 60,
            title: zh ? '单次最多带几张图' : 'Max image refs per request',
            description: zh
              ? '默认 24。上游对一次请求的图片条目数有上限（实测 40~52），超了整轮被拒、且该会话此后每轮都失败，所以只带最近的 N 份。填 0 = 不限制（不推荐）。'
              : 'Default 24. The upstream caps image refs per request (measured 40-52); exceeding it rejects the whole turn and every later turn on that chat. Only the most recent N are sent. 0 disables the cap (not recommended).',
          },
          [`providers.${name}.options.browserTransport`]: {
            type: 'string',
            enum: ['off', 'auto', 'on'],
            title: zh ? '传输通道' : 'Transport',
            description: zh
              ? 'off = Node 直连（默认）；auto = 浏览器在就用、不在退回 Node；on = 只用浏览器，不可用就报错。'
                + '浏览器通道让请求从 chat.deepseek.com 的页面里发出，TLS 指纹与真实浏览器一致。'
                + '开启时会用独立 profile 起一个 Edge/Chrome 窗口，并自动沿用已有凭证，不需要重新登录。'
              : 'off = Node (default); auto = use the browser when available, fall back to Node; on = browser only, fail otherwise. '
                + 'The browser channel sends requests from the chat.deepseek.com page, so the TLS fingerprint matches a real browser. '
                + 'It opens a separate Edge/Chrome window with its own profile and reuses your existing credential, so no re-login is needed.',
          },
          [`providers.${name}.options.browserChannel`]: {
            type: 'string',
            enum: ['auto', 'edge', 'chrome'],
            title: zh ? '用哪个浏览器' : 'Browser',
            description: zh
              ? '默认 auto（Edge 优先，其次 Chrome）。选定的浏览器不存在时会报错并提示切回 Node。'
              : 'Default auto (Edge first, then Chrome). If the chosen browser is missing the provider reports it and suggests switching back to Node.',
          },
          [`providers.${name}.options.browserHeadless`]: {
            type: 'boolean',
            title: zh ? '无头模式' : 'Headless',
            description: zh
              ? '默认关。无头模式的 UA 与 GPU/字体特征与真浏览器有差异，反而更容易被识别，只在没有桌面环境时开。'
              : 'Off by default. Headless differs in UA and GPU/font features, which is easier to detect; only enable it on machines without a desktop.',
          },
        },
      },
    };
    return [tools, transport];
  },
  create(name, entry, host) {
    // 先看要不要接管草稿端点留下的凭证 / 浏览器 profile（见 adoptDraftState 的说明）。
    adoptDraftState(host.stateDir, host.log);
    const current = () => host.currentEntry?.() ?? entry;
    const models: ListedModel[] = MODELS.map(model => ({
      id: model.id,
      displayName: model.label,
      // 网页版的统一模式能吃图；选模型时顺手把端点的「多模态」打开。
      inputImages: true,
    }));
    // 会话桥跨 `create()` 复用：端点重建不该丢掉「上一条 chat 聊到哪」。
    const bridge = host.resource?.<SessionBridge>('sessions', () => new SessionBridge()) ?? new SessionBridge();
    // 登录过程也是跨 `create()` 的状态：面板可能先问 status 再开始。
    const signIn = host.resource?.<WebSignIn>('signin', () => new WebSignIn(
      () => host.stateDir,
      auth => verifyCredential(current().baseUrl || DEEPSEEK_WEB.defaultBaseUrl!, auth),
    )) ?? new WebSignIn(() => host.stateDir, auth => verifyCredential(current().baseUrl || DEEPSEEK_WEB.defaultBaseUrl!, auth));
    // 阶段一：默认全开，先跑一遍看哪些工具在这个模型上真的能用，再收敛成白名单。
    // 端点里填 `options.tools` 可覆盖：`none` = 纯对话，`a,b,c` = 只放这三个。
    const allowedTools = (): readonly string[] | null => {
      const raw = (current().options ?? {}).tools;
      if (typeof raw !== 'string') return null;
      const text = raw.trim();
      if (!text) return null;
      if (/^none$/i.test(text)) return [];
      return text.split(',').map(item => item.trim()).filter(Boolean);
    };
    // 请求闸门跨 `create()` 复用：限速状态必须跟端点走，不能因实例重建清零。
    // 依据见 `throttle.ts`：并发会触发账号级限流，固定间隔是最明显的机器特征。
    const gate = host.resource?.<RequestGate>('throttle', () => new RequestGate(readThrottle(current(), host.log)))
      ?? new RequestGate(readThrottle(current(), host.log));
    const maxRefImages = (): number => {
      const raw = (current().options ?? {}).maxRefImages;
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 24;
    };
    // 只认枚举里的值；手滑写错一律退回默认，不要因为一个错字把通道换成预期之外的东西。
    const readEnum = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
      const raw = (current().options ?? {})[key];
      const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
    };
    const channelOptions = (): TransportOptions => ({
      baseUrl: () => current().baseUrl || DEEPSEEK_WEB.defaultBaseUrl!,
      stateDir: host.stateDir,
      log: host.log,
      mode: () => readEnum<BrowserMode>('browserTransport', ['off', 'auto', 'on'], 'off'),
      channel: () => readEnum<BrowserChoice>('browserChannel', ['auto', 'edge', 'chrome'], 'auto'),
      headless: () => (current().options ?? {}).browserHeadless === true,
      cookie: () => loadAuth(current(), host)?.cookie ?? null,
    });
    // 通道跨 `create()` 复用：浏览器进程与代理端口不该因为端点重建而重启。
    const channel = host.resource?.<Transport>('channel', () => new Transport(channelOptions()))
      ?? new Transport(channelOptions());
    // 冷却状态必须落盘且跨 `create()` 复用：否则端点一重建就把冷却忘了，接着撞。
    const healthFile = join(host.stateDir, 'account-health.json');
    const health = host.resource?.<AccountHealth>('health', () => new AccountHealth({ file: healthFile, log: host.log }))
      ?? new AccountHealth({ file: healthFile, log: host.log });
    // 实例创建时把「用的是哪个目录、哪条通道、凭证在不在」记一行。
    // 排障时这三样决定了 90% 的失败原因，之前它们只存在于代码里。
    // debug 级别：设置页会周期性重建实例，info 会把日志刷满。
    host.log.debug?.(
      `DeepSeek Web：端点 ${name}｜目录 ${host.stateDir}｜通道 ${channelOptions().mode()}`
      + `｜凭证 ${loadAuth(current(), host) ? '已加载' : '缺失'}`,
    );
    return {
      // 面板要同时拿到登录控制器、传输通道和冷却状态。
      control: { signIn, channel, health },
      client: createClient({
        baseUrl: entry.baseUrl || DEEPSEEK_WEB.defaultBaseUrl!,
        auth: () => loadAuth(current(), host),
        stateDir: host.stateDir,
        log: host.log,
        keepThinking: host.keepThinking,
        session: bridge,
        readBlob: host.readBlob,
        allowedTools,
        multimodal: () => current().multimodal === true,
        // 句柄不带 MIME；上传层按文件头判断，这里只作补充。
        mimeOf: () => undefined,
        gate,
        maxRefImages,
        channel,
        http: channel.http,
        health,
      }),
      listModels: async () => models,
      // 上游不声明上下文窗口。猜一个数字会让 Core 按错误的上限裁剪历史，宁可交给操作员手填。
      contextWindow: () => undefined,
      compatibilityKey: () => [name, 'deepseek-web-fix'],
    };
  },
  webUi(host) {
    return {
      panels: [
        { id: SIGNIN_PANEL, title: host.language === 'zh' ? '登录' : 'Sign in', description: host.language === 'zh' ? '用浏览器里的 DeepSeek 会话登录' : 'Sign in with a DeepSeek web session' },
        {
          id: TRANSPORT_PANEL,
          title: host.language === 'zh' ? '传输通道' : 'Transport',
          description: host.language === 'zh' ? '请求由 Node 还是真实浏览器发出' : 'Whether requests are sent by Node or a real browser',
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== SIGNIN_PANEL && panel !== TRANSPORT_PANEL) throw new Error(`未知面板：${panel}`);
        // 端点名必须由面板带上来：invoke 在服务端拿不到浏览器侧的 ctx.scope。
        const name = args[0];
        if (typeof name !== 'string' || !name) {
          throw new Error('没有收到端点名：请从「模型供应商」页打开这个端点后再试');
        }
        const target = host.entries().find(item => item.name === name);
        if (!target) throw new Error(`端点「${name}」不存在`);
        const control = host.instance(target.name).control as
          { signIn?: unknown; channel?: Transport; health?: AccountHealth } | undefined;

        // 传输通道面板只关心通道，不需要登录控制器。
        if (panel === TRANSPORT_PANEL) {
          const channel = control?.channel;
          if (!channel) throw new Error('这个端点没有传输通道');
          const snapshot = () => ({ ...channel.status(), health: control?.health?.snapshot() ?? null });
          switch (method) {
            case 'channel':
              return snapshot();
            case 'channelStart': {
              const ready = await channel.ensure();
              return { ready, ...snapshot() };
            }
            case 'channelStop':
              await channel.close();
              return snapshot();
            case 'cooldownReset': {
              control?.health?.reset();
              return snapshot();
            }
            default:
              throw new Error(`未知方法：${method}`);
          }
        }

        const signIn = control?.signIn;
        if (!(signIn instanceof WebSignIn)) throw new Error('这个端点没有登录控制器，可能没有正确加载扩展');
        switch (method) {
          case 'state':
            return signIn.status();
          case 'auto': {
            const result = await signIn.startAutomatic();
            // 重新登录后：把新凭证同步进正在运行的通道，并解除「登录失效」造成的冷却。
            // 不解除的话，用户登录成功了却还要等到冷却结束才能说话。
            await control?.channel?.syncCookies();
            control?.health?.reset();
            return result;
          }
          case 'start':
            return signIn.start();
          case 'cancel':
            await signIn.cancel();
            return signIn.status();
          case 'submit': {
            const result = await signIn.accept(String(args[1] ?? ''));
            if ((result as { ok?: boolean }).ok) {
              await control?.channel?.syncCookies();
              control?.health?.reset();
            }
            return result;
          }
          default:
            throw new Error(`未知方法：${method}`);
        }
      },
    };
  },
};

/**
 * 只验「凭证还能不能拿到 PoW 挑战」：拿到就说明 token 与 cookie 没失效。
 * 这是最轻的验活方式——不发对话、不消耗额度。
 */
export async function verifyCredential(baseUrl: string, auth: WebAuth): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${CHALLENGE_PATH}`, {
    method: 'POST',
    headers: { ...authHeaders(auth, deviceIdFor(auth)) },
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json() as { data?: { biz_data?: { challenge?: unknown } } };
  if (!json?.data?.biz_data?.challenge) {
    throw new Error('DeepSeek 没有发出挑战，登录可能已失效或需要人机验证');
  }
}

export default DEEPSEEK_WEB;
export { DEEPSEEK_WEB, contextOverflow, extractAuth };
