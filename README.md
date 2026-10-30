# DeepSeek Web（XML 修复版）

这是一个可与原版同时安装的 Cortico / Coopanion provider 插件，基于 MIT 许可的
`cortico-provider-deepseek-web@0.6.1` 修改。provider 是连接模型服务的适配插件。

修复模型输出下面这种完整调用时，工具名被忽略、调用被当成普通文本的问题：

```xml
<tool_call name="read_file">
{"path":"notes/pending.md"}
</tool_call>
```

保留原版的 DeepSeek 网页会话登录、图片、思考和传输通道功能。工具调用仍通过提示词模拟，
不能保证模型每次遵守格式；缺少闭合标签、无效 JSON 和多个拼接的 XML 调用不会被本次新增分支执行。
本次修复不处理上游限流、空流或上下文超限，也不自动补发历史消息。

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
本次修改：新增 XML name 属性解析和回归测试；使用独立模块 id、名称与配置前缀；修正过时的工具支持注释。
