/**
 * 上游失败分类。
 *
 * 为什么单独一层：原来所有失败都汇成一句 `HTTP 403`，用户不知道是「token 过期」「要过人机验证」
 * 还是「被限流」。这三种的下一步动作完全不同，混在一起等于没给信息。
 *
 * 判定依据是「状态码 + 响应正文」。正文里的文案是从实测抓包里攒的：上游会把原因写在
 * `data.biz_msg` 或 `msg` 里，也会在 WAF 拦截时返回一段 HTML。
 */
export type FailureKind =
  | 'rate_limit'
  | 'auth'
  | 'captcha'
  | 'context'
  | 'upstream'
  | 'transient'
  | 'network'
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  /** 一句话说明发生了什么。 */
  title: string;
  /** 下一步该做什么；`unknown` 时为 null。 */
  action: string | null;
  /** 账号级失败：需要冷却，而不是立刻重试。 */
  accountLevel: boolean;
}

const RATE_LIMIT = /too many|rate.?limit|请求过于频繁|请求太频繁|操作频繁|频率限制|throttl/i;
const CAPTCHA = /captcha|人机验证|验证码|安全验证|verify.*human|challenge required/i;
const AUTH = /token.*(?:expired|invalid)|登录.*(?:过期|失效)|unauthorized|not logged in|请先登录/i;
const CONTEXT = /内容过长|content too long|上下文.*(?:过长|超限)|context.*(?:length|window)|maximum context/i;

export function diagnose(status: number, body: string): Diagnosis {
  const text = String(body ?? '');

  // 限流优先于其它判断：429 一定是限流，正文里出现「频繁」也按限流算。
  if (status === 429 || RATE_LIMIT.test(text)) {
    return {
      kind: 'rate_limit',
      title: '被上游限流了',
      action: '冷却结束后会自动恢复，期间不会再发请求。想更快恢复就等久一点，别反复手动重试。',
      accountLevel: true,
    };
  }

  if (CAPTCHA.test(text)) {
    return {
      kind: 'captcha',
      title: '上游要求人机验证',
      action: '在浏览器里打开 chat.deepseek.com 手动过一次验证，然后回来重试。',
      accountLevel: true,
    };
  }

  if (status === 401 || AUTH.test(text)) {
    return {
      kind: 'auth',
      title: '登录已失效',
      action: '到端点页点「自动登录」重新授权一次。',
      accountLevel: true,
    };
  }

  if (status === 403) {
    // 403 可能是 WAF 拦了单次请求，也可能真的是账号问题。两种都按账号级处理：
    // 继续硬撞只会让处罚变重。
    return {
      kind: 'auth',
      title: '请求被上游拒绝（403）',
      action: '先等冷却结束；如果反复出现，重新登录一次，或在浏览器里打开 chat.deepseek.com 看看是否需要验证。',
      accountLevel: true,
    };
  }

  if (CONTEXT.test(text)) {
    return {
      kind: 'context',
      title: '上下文超出上游上限',
      action: '开一个新会话，或把更早的对话删掉。',
      accountLevel: false,
    };
  }

  if (status >= 500) {
    return {
      kind: 'transient',
      title: `上游临时故障（HTTP ${status}）`,
      action: '稍后重试即可；这不是账号问题。',
      accountLevel: false,
    };
  }

  // 流内错误事件：status 是 0，但 body 带着结构化的上游原因（框架的 `StreamErrorEvent` 就是这样）。
  // 不单独认出来的话会被当成「连不上上游」，指错方向。
  if (status === 0 && /^\s*\{/.test(text)) {
    return {
      kind: 'upstream',
      title: '上游在流中报错',
      action: '这是上游自己报的错，不是网络问题；稍后重试，反复出现就开一个新会话。',
      accountLevel: false,
    };
  }

  if (status === 0) {
    return {
      kind: 'network',
      title: '连不上上游',
      action: '检查网络、代理或防火墙。',
      accountLevel: false,
    };
  }

  return { kind: 'unknown', title: `上游返回 HTTP ${status}`, action: null, accountLevel: false };
}

/** 把诊断结果拼成给用户看的一句话。 */
export function explain(diagnosis: Diagnosis, until?: number | null): string {
  const when = until && until > Date.now() ? `（${clock(until)} 之后恢复）` : '';
  const action = diagnosis.action ? ` ${diagnosis.action}` : '';
  return `DeepSeek Web：${diagnosis.title}${when}。${action}`.replace(/\s+/g, ' ').replace('。 ', '。');
}

/** `HH:mm`，用于「冷却至几点」。 */
export function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
