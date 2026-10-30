/**
 * 账号健康状态：被限流/被拒之后进入冷却，冷却期内**一个请求都不发**。
 *
 * 为什么必须有这一层：现在失败只是报错，下一轮照样把请求打上去。对网页端来说，
 * 在处罚期内继续撞是最容易把「临时限制」升级成「封号」的做法——反代的
 * `markAccountFailure` 就是专门干这件事的。
 *
 * 冷却要落盘：不落盘的话，用户重启一次应用就把冷却忘了，接着撞。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Logger } from 'cortico/core/types.ts';
import { clock, diagnose, explain, type Diagnosis, type FailureKind } from './errors.ts';

export interface HealthOptions {
  /** 落盘路径（端点目录下）。 */
  file: string;
  log: Logger;
  now?: () => number;
  /** 限流但上游没给 Retry-After 时，等多久。 */
  rateLimitMs?: number;
  /** 登录失效时的冷却；这段时间够用户去重新登录。 */
  authMs?: number;
  /** 人机验证的冷却；给人留出去过验证的时间。 */
  captchaMs?: number;
  /** 冷却上限：上游给的 Retry-After 再长也不等，免得一条请求挂几十分钟。 */
  maxCooldownMs?: number;
}

export interface HealthSnapshot {
  state: 'ok' | 'cooling';
  until: number | null;
  kind: FailureKind | null;
  message: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failures: number;
}

export interface ObserveResult {
  diagnosis: Diagnosis;
  /** 进入冷却时是恢复时刻；不是账号级失败时为 null。 */
  until: number | null;
}

interface Stored {
  until?: number;
  kind?: FailureKind;
  message?: string;
  lastSuccessAt?: number | null;
  lastFailureAt?: number | null;
  failures?: number;
}

const DEFAULTS = {
  rateLimitMs: 3 * 60_000,
  authMs: 10 * 60_000,
  captchaMs: 30 * 60_000,
  maxCooldownMs: 30 * 60_000,
} as const;

export class AccountHealth {
  private readonly now: () => number;
  private until: number | null = null;
  private kind: FailureKind | null = null;
  private message: string | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private failures = 0;

  constructor(private readonly opts: HealthOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** 冷却中返回 `allowed: false`，并给出可以直接展示的文案。 */
  check(): { allowed: true } | { allowed: false; until: number; message: string } {
    const at = this.now();
    if (this.until && this.until > at) {
      return {
        allowed: false,
        until: this.until,
        message: this.message ?? `DeepSeek Web：账号冷却中（${clock(this.until)} 之后恢复）。`,
      };
    }
    // 冷却结束：清掉状态，别让「已经过期」的记录一直挂在面板上。
    if (this.until) this.clear();
    return { allowed: true };
  }

  /** 记录一次失败；账号级失败会进入冷却。 */
  observe(status: number, retryAfterMs: number | null, body: string): ObserveResult {
    const diagnosis = diagnose(status, body);
    this.lastFailureAt = this.now();
    this.failures += 1;

    if (!diagnosis.accountLevel) {
      this.persist();
      return { diagnosis, until: null };
    }

    const configured = diagnosis.kind === 'rate_limit'
      ? this.opts.rateLimitMs ?? DEFAULTS.rateLimitMs
      : diagnosis.kind === 'captcha'
        ? this.opts.captchaMs ?? DEFAULTS.captchaMs
        : this.opts.authMs ?? DEFAULTS.authMs;
    // 上游给的 Retry-After 优先，但要封顶：一条请求挂几十分钟比失败更糟。
    const wanted = diagnosis.kind === 'rate_limit' && retryAfterMs !== null ? retryAfterMs : configured;
    const duration = Math.min(Math.max(wanted, 1_000), this.opts.maxCooldownMs ?? DEFAULTS.maxCooldownMs);

    this.until = this.now() + duration;
    this.kind = diagnosis.kind;
    this.message = explain(diagnosis, this.until);
    this.persist();
    this.opts.log.warn(
      `DeepSeek Web：${diagnosis.title}，冷却 ${Math.round(duration / 1000)}s 至 ${clock(this.until)}`,
    );
    return { diagnosis, until: this.until };
  }

  /** 一次成功就说明恢复；把失败计数与冷却都清掉。 */
  succeed(): void {
    this.lastSuccessAt = this.now();
    this.failures = 0;
    if (this.until || this.kind || this.message) this.clear();
    else this.persist();
  }

  snapshot(): HealthSnapshot {
    const at = this.now();
    const cooling = Boolean(this.until && this.until > at);
    return {
      state: cooling ? 'cooling' : 'ok',
      until: cooling ? this.until : null,
      kind: cooling ? this.kind : null,
      message: cooling ? this.message : null,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      failures: this.failures,
    };
  }

  /** 面板里的「立即解除冷却」；只在用户明确知道自己在做什么时用。 */
  reset(): void {
    this.clear();
  }

  private clear(): void {
    this.until = null;
    this.kind = null;
    this.message = null;
    this.persist();
  }

  private load(): void {
    try {
      const stored = JSON.parse(readFileSync(this.opts.file, 'utf8')) as Stored;
      this.until = typeof stored.until === 'number' && stored.until > 0 ? stored.until : null;
      this.kind = stored.kind ?? null;
      this.message = typeof stored.message === 'string' ? stored.message : null;
      this.lastSuccessAt = typeof stored.lastSuccessAt === 'number' ? stored.lastSuccessAt : null;
      this.lastFailureAt = typeof stored.lastFailureAt === 'number' ? stored.lastFailureAt : null;
      this.failures = typeof stored.failures === 'number' && stored.failures >= 0 ? stored.failures : 0;
      if (this.until && this.until <= this.now()) {
        // 重启时冷却早就过了，直接当正常状态。
        this.until = null;
        this.kind = null;
        this.message = null;
      }
    } catch {
      // 文件不存在或坏掉都按「没有记录」处理，不该因为一个缓存文件挡住启动。
    }
  }

  private persist(): void {
    const payload: Stored = {
      ...(this.until ? { until: this.until } : {}),
      ...(this.kind ? { kind: this.kind } : {}),
      ...(this.message ? { message: this.message } : {}),
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      failures: this.failures,
    };
    const temp = `${this.opts.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(payload), 'utf8');
      renameSync(temp, this.opts.file);
    } catch (error) {
      this.opts.log.debug?.(`DeepSeek Web：冷却状态落盘失败（已忽略）：${(error as Error).message}`);
    }
  }
}
