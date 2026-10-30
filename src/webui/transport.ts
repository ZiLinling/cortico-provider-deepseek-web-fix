/**
 * 端点编辑页里的「传输通道」面板。
 *
 * 只做三件事：显示当前实际通道、一键启动浏览器、一键关闭。
 * 为什么需要面板而不是只留配置项：`auto` 模式在浏览器不可用时会**静默退回 Node**，
 * 用户以为自己在用浏览器通道，其实没有。这一块必须显式标红。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

type Mode = 'off' | 'auto' | 'on';
type Active = 'node' | 'browser' | 'unavailable';

interface HealthView {
  state: 'ok' | 'cooling';
  until: number | null;
  kind: string | null;
  message: string | null;
  lastSuccessAt: number | null;
  failures: number;
}

interface ChannelStatus {
  mode: Mode;
  active: Active;
  detail: string;
  lastError: string | null;
  profile: string;
  health?: HealthView | null;
}

interface Texts {
  title: string;
  hint: string;
  start: string;
  stop: string;
  noEndpoint: string;
  offHint: string;
  node: string;
  browser: string;
  unavailable: string;
  notStarted: string;
  starting: string;
  failed: (reason: string) => string;
  profileLabel: string;
  cooling: (until: string, reason: string | null) => string;
  healthy: string;
  reset: string;
  resetHint: string;
}

const TEXT: Record<'zh' | 'en', Texts> = {
  zh: {
    title: '传输通道',
    hint: 'Node 直连发出的请求，TLS 指纹不是浏览器（JA3 与 Edge 完全不同，且不走 HTTP/2）。'
      + '浏览器通道让请求从 chat.deepseek.com 的页面里发出，指纹与真实浏览器一致。'
      + '开启后会用独立 profile 起一个 Edge/Chrome 窗口，首次会自动沿用已有凭证，不需要重新登录。',
    start: '启动浏览器通道',
    stop: '关闭浏览器通道',
    noEndpoint: '这个面板没有拿到端点名。请从「模型供应商」页打开具体端点后再试。',
    offHint: '当前「传输通道」是 off。请在下方设置里改成 auto 或 on，再点「启动浏览器通道」。',
    node: '当前：Node 直连',
    browser: '当前：浏览器通道',
    unavailable: '当前：浏览器通道不可用',
    notStarted: '浏览器通道尚未启动（下一条消息会自动启动，或点下面的按钮）。',
    starting: '正在启动浏览器（首次可能要几秒）…',
    failed: reason => `启动失败：${reason}`,
    profileLabel: 'profile：',
    cooling: (until, reason) => `账号冷却中：${until} 之后自动恢复。${reason ?? ''}`.trim(),
    healthy: '账号状态正常。',
    reset: '解除冷却',
    resetHint: '确认账号确实没被限制再点；否则只是把「别撞墙」这道保护关掉。',
  },
  en: {
    title: 'Transport',
    hint: 'Requests sent from Node do not look like a browser at the TLS layer (different JA3, no HTTP/2). '
      + 'The browser channel sends them from the chat.deepseek.com page instead, so the fingerprint matches a real browser. '
      + 'It opens a separate Edge/Chrome window with its own profile and reuses your existing credential, so you do not need to sign in again.',
    start: 'Start browser channel',
    stop: 'Stop browser channel',
    noEndpoint: 'This panel did not receive an endpoint name.',
    offHint: 'Transport is set to off. Switch it to auto or on in the settings below, then start the channel.',
    node: 'Now: Node',
    browser: 'Now: browser',
    unavailable: 'Now: browser channel unavailable',
    notStarted: 'The browser channel is not running yet (the next message starts it, or use the button below).',
    starting: 'Starting the browser (a few seconds the first time)…',
    failed: reason => `Start failed: ${reason}`,
    profileLabel: 'profile: ',
    cooling: (until, reason) => `Account cooling down: recovers after ${until}. ${reason ?? ''}`.trim(),
    healthy: 'Account is healthy.',
    reset: 'Clear cooldown',
    resetHint: 'Only clear it if you are sure the account is fine; otherwise you are just removing the guard.',
  },
};

function texts(language: string): Texts {
  return language === 'zh' ? TEXT.zh : TEXT.en;
}

async function mount(ctx: WebUiPanelContext): Promise<void> {
  const t = texts(ctx.language);
  const { ui, root } = ctx;
  const endpoint = ctx.scope.instance;

  const sheet = ui.sheet({ title: t.title, desc: t.hint });
  const state = ui.msgline();
  const detail = ui.msgline();
  const health = ui.msgline();
  const bar = ui.rowbar();
  const start = ui.button(t.start, { variant: 'primary' });
  const stop = ui.button(t.stop, { size: 'sm' });
  const reset = ui.button(t.reset, { size: 'sm' });
  bar.append(start, stop, reset);
  sheet.body.append(state, detail, health, bar);
  root.append(sheet.el);

  let status: ChannelStatus | null = null;
  let busy = false;

  const clockOf = (at: number): string => {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  const render = (): void => {
    start.disabled = !endpoint || busy || status?.mode === 'off';
    stop.disabled = !endpoint || busy || status?.active !== 'browser';

    if (busy) {
      state.textContent = t.starting;
      state.className = 'msgline';
    } else if (!status) {
      state.textContent = '';
      state.className = 'msgline';
    } else if (status.active === 'browser') {
      state.textContent = `${t.browser}（${status.detail}）`;
      state.className = 'msgline';
    } else if (status.mode === 'off') {
      state.textContent = t.node;
      state.className = 'msgline';
    } else if (status.active === 'unavailable') {
      // 「还没启动」和「启动失败/断开」是两件事：前者是正常初始状态，不该标红吓人。
      state.textContent = status.lastError ? t.failed(status.lastError) : t.notStarted;
      state.className = status.lastError ? 'msgline bad' : 'msgline';
    } else {
      state.textContent = t.node;
      state.className = 'msgline';
    }

    detail.textContent = status?.mode === 'off'
      ? t.offHint
      : status ? `${t.profileLabel}${status.profile}` : '';
    detail.className = 'msgline';

    const view = status?.health;
    if (view?.state === 'cooling' && view.until) {
      health.textContent = t.cooling(clockOf(view.until), view.kind);
      health.className = 'msgline bad';
      reset.style.display = '';
    } else {
      health.textContent = view ? t.healthy : '';
      health.className = 'msgline';
      reset.style.display = 'none';
    }
    reset.disabled = !endpoint || busy;
  };

  const call = async (method: string): Promise<ChannelStatus | null> =>
    ctx.invoke<ChannelStatus | null>(method, [endpoint]);

  start.addEventListener('click', async () => {
    if (!endpoint || busy) return;
    busy = true;
    render();
    const release = ui.disable(start);
    try {
      status = await ctx.invoke<ChannelStatus>('channelStart', [endpoint]);
    } catch (error) {
      status = { mode: 'on', active: 'unavailable', detail: '', lastError: (error as Error).message, profile: status?.profile ?? '' };
    } finally {
      release.dispose();
      busy = false;
      render();
    }
  });

  stop.addEventListener('click', async () => {
    if (!endpoint || busy) return;
    const release = ui.disable(stop);
    try {
      status = await call('channelStop');
    } catch {
      /* 关不掉就等下一次轮询覆盖 */
    } finally {
      release.dispose();
      render();
    }
  });

  reset.addEventListener('click', async () => {
    if (!endpoint || busy) return;
    const release = ui.disable(reset);
    try {
      status = await call('cooldownReset');
    } catch {
      /* 读失败不盖住当前画面 */
    } finally {
      release.dispose();
      render();
    }
  });

  const tick = async (): Promise<void> => {
    if (!endpoint || busy) return;
    try {
      const next = await call('channel');
      const changed = next?.active !== status?.active || next?.mode !== status?.mode
        || next?.detail !== status?.detail || next?.lastError !== status?.lastError
        || next?.health?.state !== status?.health?.state
        || next?.health?.until !== status?.health?.until;
      status = next;
      if (changed) render();
    } catch {
      /* 读失败不盖住当前画面 */
    }
  };

  ctx.interval(() => void tick(), 3000);
  await tick();
  render();
}

export const transportPanel: WebUiClientBundle['panels'][string] = { mount };
