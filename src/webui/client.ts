/**
 * 端点编辑页里的「登录」面板。
 *
 * 主路径是**全自动**：点一下 → 扩展开一个独立浏览器窗口 → 你在里面登录 →
 * 扩展自动读凭证、验活、落盘 → 面板实时显示每一步。
 *
 * 粘贴登录仍保留（`showPaste`），作为没有 Edge/Chrome 或自动流程失败时的兜底。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { transportPanel } from './transport.ts';

type Phase = 'idle' | 'waiting' | 'verifying' | 'done' | 'failed' | 'expired';

interface SignInStatus {
  phase: Phase;
  message?: string;
  account?: string;
  url?: string;
  step?: string;
}

interface Texts {
  title: string;
  hint: string;
  signedOut: string;
  signedIn: (account?: string) => string;
  auto: string;
  paste: string;
  cancel: string;
  retry: string;
  busyDefault: string;
  pasteTitle: string;
  pasteHint: string;
  submit: string;
  noEndpoint: string;
}

const TEXT: Record<'zh' | 'en', Texts> = {
  zh: {
    title: '登录',
    hint: '点「自动登录」会开一个独立浏览器窗口（不影响你日常浏览器）。登录完成后凭证自动写入本机端点目录。',
    signedOut: '尚未登录。',
    signedIn: account => `已登录${account ? `（账号 ${account}）` : ''}。凭证在端点目录，修改后立即生效。`,
    auto: '自动登录',
    paste: '粘贴 cURL',
    cancel: '取消',
    retry: '重新登录',
    busyDefault: '正在登录…',
    pasteTitle: '粘贴 cURL',
    pasteHint: '在 chat.deepseek.com 按 F12 → Network，右键任一请求 → Copy as cURL，整段粘进来。',
    submit: '提交并验证',
    noEndpoint: '这个面板没有拿到端点名。请从「模型供应商」页打开具体端点后再试。',
  },
  en: {
    title: 'Sign in',
    hint: 'Automatic sign-in opens a separate browser window (your daily browser is untouched). The credential is written to the endpoint directory when done.',
    signedOut: 'Not signed in.',
    signedIn: account => `Signed in${account ? ` (account ${account})` : ''}.`,
    auto: 'Sign in',
    paste: 'Paste cURL',
    cancel: 'Cancel',
    retry: 'Sign in again',
    busyDefault: 'Signing in…',
    pasteTitle: 'Paste cURL',
    pasteHint: 'On chat.deepseek.com open DevTools → Network, right-click a request → Copy as cURL, then paste it here.',
    submit: 'Submit and verify',
    noEndpoint: 'This panel did not receive an endpoint name.',
  },
};

function texts(language: string): Texts {
  return language === 'zh' ? TEXT.zh : TEXT.en;
}

async function mount(ctx: WebUiPanelContext): Promise<void> {
  const t = texts(ctx.language);
  const { ui, root } = ctx;
  // 端点编辑页通过 scope.instance 告诉模块当前端点；invoke 在服务端拿不到它，必须自己带上。
  const endpoint = ctx.scope.instance;

  const sheet = ui.sheet({ title: t.title, desc: t.hint });
  const state = ui.msgline();
  const progress = ui.progress({ label: t.busyDefault, max: 4, value: 0 });
  progress.el.style.display = 'none';

  const bar = ui.rowbar();
  const auto = ui.button(t.auto, { variant: 'primary' });
  const paste = ui.button(t.paste, { size: 'sm' });
  const cancel = ui.button(t.cancel, { size: 'sm' });
  bar.append(auto, paste, cancel);

  // 粘贴兜底区，默认隐藏。
  const pasteBox = ui.h('div');
  pasteBox.style.display = 'none';
  const pasteHint = ui.msgline(t.pasteHint);
  const pasteInput = ui.textarea({ rows: 6, placeholder: 'curl ... -H "authorization: Bearer ..." -b "..."' });
  const pasteBar = ui.rowbar();
  const submit = ui.button(t.submit, { variant: 'primary', size: 'sm' });
  pasteBar.append(submit);
  pasteBox.append(pasteHint, pasteInput, pasteBar);

  sheet.body.append(state, progress.el, bar, pasteBox);
  root.append(sheet.el);

  let status: SignInStatus = { phase: 'idle' };

  const pct = (phase: Phase, step?: string): number | null => {
    if (phase === 'waiting') {
      if (!step) return 1;
      if (step.includes('准备') || step.includes('准备浏览器')) return 1;
      if (step.includes('登录') || step.includes('窗口')) return 2;
      if (step.includes('检测到') || step.includes('读取')) return 3;
      return 2;
    }
    if (phase === 'verifying') return 3;
    if (phase === 'done') return 4;
    return null;
  };

  const render = (): void => {
    const busy = status.phase === 'waiting' || status.phase === 'verifying';
    cancel.style.display = busy ? '' : 'none';
    auto.style.display = busy ? 'none' : '';
    paste.style.display = busy ? 'none' : '';
    auto.textContent = status.phase === 'done' ? t.retry : t.auto;

    const value = pct(status.phase, status.step);
    if (value === null) {
      progress.el.style.display = 'none';
    } else {
      progress.el.style.display = '';
      progress.setLabel(status.step ?? t.busyDefault);
      progress.setValue(value, 4);
    }

    if (status.phase === 'done') {
      state.textContent = t.signedIn(status.account);
      state.className = 'msgline';
    } else if (busy) {
      state.textContent = status.step ?? status.message ?? t.busyDefault;
      state.className = 'msgline';
    } else if (status.phase === 'failed' || status.phase === 'expired') {
      state.textContent = status.message ?? '';
      state.className = 'msgline bad';
    } else {
      state.textContent = t.signedOut;
      state.className = 'msgline';
    }
    auto.disabled = !endpoint;
    paste.disabled = !endpoint;
  };

  const call = async (method: string, extra?: unknown): Promise<SignInStatus> => {
    const args = extra === undefined ? [endpoint] : [endpoint, extra];
    return ctx.invoke<SignInStatus>(method, args);
  };

  const guard = (): boolean => {
    if (endpoint) return true;
    status = { phase: 'failed', message: t.noEndpoint };
    render();
    return false;
  };

  auto.addEventListener('click', async () => {
    if (!guard()) return;
    const release = ui.disable(auto, paste);
    try {
      status = await call('auto');
      render();
    } catch (error) {
      status = { phase: 'failed', message: (error as Error).message };
      render();
    } finally {
      release.dispose();
    }
  });

  paste.addEventListener('click', () => {
    pasteBox.style.display = pasteBox.style.display === 'none' ? '' : 'none';
    if (pasteBox.style.display === '') pasteInput.focus();
  });

  cancel.addEventListener('click', async () => {
    if (!guard()) return;
    try {
      status = await call('cancel');
      render();
    } catch {
      /* 取消失败就等它自己超时 */
    }
  });

  submit.addEventListener('click', async () => {
    if (!guard()) return;
    const value = pasteInput.value.trim();
    if (!value) return;
    const release = ui.disable(submit);
    status = { phase: 'verifying', step: '正在验证凭证…' };
    render();
    try {
      const result = await call('submit', value) as unknown as { ok: boolean; message: string };
      status = result.ok
        ? { phase: 'done', message: result.message, account: (await call('state')).account }
        : { phase: 'failed', message: result.message };
      if (result.ok) pasteInput.value = '';
      render();
    } catch (error) {
      status = { phase: 'failed', message: (error as Error).message };
      render();
    } finally {
      release.dispose();
    }
  });

  // 轮询：设置里每秒看一次，其余状态 3 秒一次，避免无谓请求。
  const tick = async (): Promise<void> => {
    if (!endpoint) return;
    try {
      const next = await call('state');
      // 只在状态真的变了才重画，避免拖选文本被反复打断。
      const changed = next.phase !== status.phase || next.step !== status.step
        || next.account !== status.account || next.message !== status.message;
      status = next;
      if (changed) render();
    } catch {
      /* 读失败不盖住当前画面 */
    }
  };

  ctx.interval(() => void tick(), status.phase === 'waiting' ? 1000 : 3000);
  await tick();
  render();
}

const bundle: WebUiClientBundle = { panels: { signin: { mount }, transport: transportPanel } };
export default bundle;
