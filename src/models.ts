/**
 * DeepSeek Web 的模型别名表。
 *
 * Web 端只有「统一模式」一个真实模型，`model_type` 之外靠 `thinking_enabled` /
 * `search_enabled` 两个开关表达差异。别名只是给既有客户端的面子，真实能力由开关决定。
 *
 * 上下文窗口故意**不报**：上游从不声明，猜一个数字会让 Core 按错误的窗口裁剪上下文。
 * 需要时由操作员在端点里手填 `contextWindow`。
 */

export interface WebModel {
  id: string;
  label: string;
  thinking: boolean;
  search: boolean;
  /** 曾经存在、现在由统一模式承接的别名。 */
  deprecated?: string;
}

const base = { thinking: false, search: false } as const;

export const MODELS: readonly WebModel[] = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat（默认）', ...base },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner（深度思考）', thinking: true, search: false },
  { id: 'deepseek-chat-search', label: 'DeepSeek Chat + 联网', thinking: false, search: true },
  { id: 'deepseek-reasoner-search', label: 'DeepSeek Reasoner + 联网', thinking: true, search: true },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', ...base },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', ...base },
  { id: 'deepseek-default', label: 'DeepSeek Default', ...base },
  { id: 'deepseek-r1', label: 'DeepSeek R1（R1 兼容名 → 深度思考）', thinking: true, search: false,
    deprecated: 'R1 已并入统一模式，这个名字只请求深度思考' },
  { id: 'deepseek-r1-search', label: 'DeepSeek R1 + 联网', thinking: true, search: true,
    deprecated: 'R1 已并入统一模式' },
  { id: 'deepseek-expert', label: 'DeepSeek Expert（专家模式）', thinking: true, search: false,
    deprecated: '专家模式已并入统一模式，只请求深度思考' },
  { id: 'deepseek-expert-search', label: 'DeepSeek Expert + 联网', thinking: true, search: true,
    deprecated: '专家模式已并入统一模式' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', thinking: true, search: false,
    deprecated: 'V4 Pro 已下线，由 V4.1 Flash 承接' },
  { id: 'deepseek-vision', label: 'DeepSeek Vision（识图）', ...base },
];

const BY_ID = new Map(MODELS.map(model => [model.id, model]));

/** 未知别名按 `deepseek-chat` 收；上游也是这个行为。 */
export function resolveModel(id: string | null | undefined): WebModel {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? BY_ID.get('deepseek-chat')!;
}

/**
 * 上游要的 `model_type`。
 *
 * 实测（抓包）网页发的是 `null` —— 网页版只有一个模型，靠 `thinking_enabled`
 * / `search_enabled` 区分档位。发 `'default'` 也能通，但和网页不一致，没必要。
 */
export const MODEL_TYPE: string | null = null;

/** 真实模型的自报名称，用于响应里的 `model` 字段，便于事后分辨。 */
export function realModelName(model: WebModel): string {
  let name = 'DeepSeek-V4.1-Flash (DeepSeek Web)';
  if (model.thinking) name += ' + DeepThink';
  if (model.search) name += ' + web search';
  return name;
}
