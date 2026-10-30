/**
 * 清理正文开头完整的网页分类前缀。只处理外层前缀，不扫描参数字符串或引用正文。
 * 标签内的 JSON、判定文字都只是前缀内容，不能拿来构造调用或工具结果。
 */
export function stripSafetyBlocks(text: string): string {
  const prefix = /^\s*<ds_safety>[\s\S]*?<\/ds_safety>(?:\s*(?:Unsafe|Safe)(?=$|\s|[<{]))?\s*/i;
  let result = text;
  for (;;) {
    const match = prefix.exec(result);
    if (!match) return result;
    result = result.slice(match[0].length);
  }
}

/** 完整前缀清理后仍以开始标签开头，说明剩余前缀没有闭合。 */
export function hasUnclosedSafetyPrefix(text: string): boolean {
  return /^\s*<ds_safety>/i.test(text);
}
