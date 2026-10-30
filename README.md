# DeepSeek Web（XML 修复版）

这是一个可与原版同时安装的 Cortico / Coopanion provider 插件，基于 MIT 许可的
`cortico-provider-deepseek-web@0.6.1` 修改。provider 是连接模型服务的适配插件。

修复模型输出下面这些完整调用时，调用被当成普通文本的问题：

```xml
<tool_call name="read_file">
{"path":"notes/pending.md"}
</tool_call>
```

以及参数写在开始标签中的变体（这种写法不属于规范 XML）：

```text
<tool_call name="pet_move_to" arguments={"to":0.34}></tool_call>
```

0.2.0 采用统一的「提取 → 校验 → 重封装」流程，保留原来的 JSON 调用信封。
网页模型通过提示词约定格式，偶尔会漏外层定界符；只要工具名明确、参数是完整 JSON 对象，
即使漏了标签的 `>` 或 `</tool_call>`，也会在参数校验通过后封装为标准 function_call。
字符串里的 `<happy>`、引号与括号按 JSON 内容处理，不作为外层标签。

保留原版的 DeepSeek 网页会话登录、图片、思考和传输通道功能。工具调用仍通过提示词模拟，
不能保证模型每次遵守格式。参数本身截断、无法确定唯一调用、工具未注册/未放行、参数校验失败时，
明确报告「工具调用未执行」并返回 422，不再静默降级成普通 message。
普通自然语言、普通 HTML 和普通数据仍作为消息处理。
本次修复不处理上游限流、空流或上下文超限，也不自动补发历史消息。

## 参数校验与输出处理

工具列表和参数定义由 coo 每轮传入，无须为新插件硬编码工具名。
校验使用 Ajv，对照工具的 JSON Schema 检查必填字段、类型、枚举、范围、数组、对象等约束。
不强制转换类型、不填默认值、不删除额外字段；格式修复仅调整外层包装，不猜测缺失参数内容。
目前不校验 Schema 的 `format` 注解，不能借此判断收件对象或正文是否符合用户意图。

有工具时先收齐本轮正文，再提取和校验，避免代码块或分片把调用提前落成 message；
思考内容仍按原有机制流式处理。校验通过会记录工具名与转换形式，不记录完整参数。
检测到调用但校验失败时不执行，且不增加模型纠正请求；自动让模型重写一次仍未实现。

## 安装和切换

1. 在 coo 的「扩展」页使用手动安装，从本机目录选择本包所在目录。也可在扩展目录内执行
   `corepack pnpm add "安装包的绝对路径.tgz"`。重启 coo 后加载。
2. 在「模型供应商」页新建端点，选择 **DeepSeek Web（XML 修复版）**，保存端点，然后使用其「登录」面板登录。
3. 模型选择原先使用的模型，例如 `deepseek-reasoner-search`，其他设置按需要填写；将该端点设为当前使用。
4. 发一条新请求，例如让宠物说一句话。检查对话是否显示，以及时间线是否出现 `pet_say` 的执行回执。
   QQ 发送涉及实际消息，请明确选定测试对象后再测试，并以 `qq_send` 的发送回执为准。

本包的包名是 `cortico-provider-deepseek-web-xml-fix`，模块 id 是 `deepseek-web-xml-fix`。
原插件无需卸载；要回退，在供应商页重新选用原端点即可。
安装包不包含你的登录凭证。新端点使用原有登录流程，凭证保存在部署的端点目录；原端点不用删除。

## 开发和检查

需要 Node 22 以上与 pnpm。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build:web
```

在 Cortico 开发目录中运行 `pnpm describe:extension <本包目录>`，再运行
`pnpm check:extension <本包目录>`。这些检查不发送真实聊天消息。
行为验证仍需安装到实际实例后观察工具回执。

## 来源与许可

源代码及登录面板来自 `cortico-provider-deepseek-web@0.6.1`，保留原 [LICENSE](LICENSE)。
原说明及历史分别保存在 [UPSTREAM-README.md](UPSTREAM-README.md) 和
[UPSTREAM-CHANGELOG.md](UPSTREAM-CHANGELOG.md)。这是本地制作的修复分支，不代表原作者发布的更新。
本次修改：统一提取工具名和完整 JSON 参数、按本轮工具定义校验、重封装；补充回归测试、独立模块身份及配置前缀。
