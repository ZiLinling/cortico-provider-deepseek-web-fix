/**
 * 网页会话凭证。
 *
 * DeepSeek Web 不用 API Key，用的是浏览器里那套：`Authorization: Bearer <token>`
 * 加 Cookie，另有两个 `x-hif-*` 请求头。凭证来自端点自己的数据目录，与 Cortico
 * 的 `secret`（环境变量）机制兼容但不必依赖它 —— 四个字段拼成一个 JSON 塞进 .env
 * 太别扭。
 *
 * 落在 `<stateDir>/deepseek-auth.json`，结构与 FreeDeepseekAPI 的 `deepseek-auth.json`
 * 一致，方便直接把服务器上那份拷过来。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ProviderHost } from 'cortico/providers/base.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';

export interface WebAuth {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
  /** 网页侧的设备标识；有它就优先于派生的假 ID。 */
  deviceId?: string;
  /** SHA3 PoW 的 WASM 地址，随网页版本变化，所以由凭证一起带着。 */
  wasmUrl: string;
}

/** 客户端自报的版本；上游只用来分组统计，改了不影响语义。 */
export const CLIENT_VERSION = '2.7.0';
/** 网页端的 bundle 标识；上游部分接口会校验。 */
export const CLIENT_BUNDLE = 'com.deepseek.chat';

export const AUTH_FILE = 'deepseek-auth.json';

function pickString(source: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 字段名容错：网页抓包有时写 snake_case，有时写 camelCase。 */
export function parseAuth(raw: string): WebAuth {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DeepSeek 凭证不是合法 JSON：${(error as Error).message}`);
  }
  if (!json || typeof json !== 'object') throw new Error('DeepSeek 凭证必须是 JSON 对象');
  const source = json as Record<string, unknown>;
  const token = pickString(source, 'token', 'authToken', 'authorization');
  const cookie = pickString(source, 'cookie', 'cookies');
  const wasmUrl = pickString(source, 'wasmUrl', 'wasm_url', 'powWasmUrl');
  const missing = [!token && 'token', !cookie && 'cookie', !wasmUrl && 'wasmUrl'].filter(Boolean);
  if (missing.length) throw new Error(`DeepSeek 凭证缺少字段：${missing.join('、')}`);
  return {
    token: token!,
    cookie: cookie!,
    hifDliq: pickString(source, 'hif_dliq', 'hifDliq'),
    hifLeim: pickString(source, 'hif_leim', 'hifLeim'),
    deviceId: pickString(source, 'deviceId', 'device_id', 'xDeviceId'),
    wasmUrl: wasmUrl!,
  };
}

/**
 * 读取凭证：先看端点 `secret` 指的变量里有没有整份 JSON，再退回数据目录的文件。
 * 两者都没有时返回 null —— 由 `availability()` 报「需要登录」，而不是抛错中断。
 */
export function loadAuth(entry: LLMProviderEntry, host: ProviderHost): WebAuth | null {
  if (entry.secret) {
    let secret: string | undefined;
    try {
      secret = host.secret(entry.secret);
    } catch {
      secret = undefined;
    }
    if (secret && secret.trim().startsWith('{')) return parseAuth(secret);
  }
  try {
    return parseAuth(readFileSync(join(host.stateDir, AUTH_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** 每次请求的请求头；凭证缺 `x-hif-*` 时上游会自己忽略。 */
export function authHeaders(auth: WebAuth, deviceId?: string): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-bundle-id': CLIENT_BUNDLE,
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-app-version': CLIENT_VERSION,
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
    Authorization: `Bearer ${auth.token}`,
    'x-hif-dliq': auth.hifDliq ?? '',
    'x-hif-leim': auth.hifLeim ?? '',
    Origin: 'https://chat.deepseek.com',
    Referer: 'https://chat.deepseek.com/',
    Cookie: auth.cookie,
    'Content-Type': 'application/json',
  };
}

/**
 * 稳定的设备标识：上游用它做风控分组，每次请求换一个会显得可疑。
 * 优先用网页里那个真的；没有才由 token 派生（不额外存文件）。
 */
export function deviceIdFor(auth: WebAuth): string {
  if (auth.deviceId) return auth.deviceId;
  const hash = createHash('sha1').update(auth.token).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
