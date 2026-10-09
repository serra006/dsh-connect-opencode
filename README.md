# dsh-connect-opencode

把本机 **OpenCode**（`opencode serve`）里的**免费模型**接入 DeepSeek Harness（DSH）的模型选择器。
思路与插件结构对齐 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)，
opencode 协议桥接参考 [`ow-bridge`](https://github.com/louchi1984-coder/ow-bridge)。

> 免费 = OpenCode provider 目录里 `cost.input / output / cache.read / cache.write` 全为 0、且能输出文本、未废弃的模型。
> 具体有哪些免费模型由你的 OpenCode 配置决定；没有任何免费模型时，provider 注册为空（见下方「为什么列表是空的」）。

## 工作原理

```
DSH (pi-ai) ──OpenAI 兼容──▶ 本插件的本地 shim (127.0.0.1:<随机端口>)
                                  │  prepare()/decode()/sendSSE() 协议转换
                                  ▼
                          opencode serve --pure (本插件用隔离的 XDG 目录+随机端口+Basic 鉴权拉起)
```

- **`lib/opencode.js`**：找到 `opencode` 可执行文件，用隔离配置拉起一个 `opencode serve --pure`（并把你的全局 `opencode.json(c)` 与 `auth.json` **复制**进隔离目录，使自定义 provider 和密钥照常可用），实现它的 HTTP 客户端（`/global/health`、`/provider`、`/session`、`/session/:id/message`）。OpenCode 原生工具（bash/read/write…）一律 `deny`，执行权归 DSH。
- **`lib/catalog.js`**：从 `/provider` 里筛出免费模型（所有 provider，含内置 `opencode` Zen 和你自定义的 provider；`cost` 缺省视为 0；须支持文本输出、未废弃），转成 DSH 模型条目。模型 id 形如 `test/DeepSeek-V4-Flash`、`opencode/big-pickle`。
- **`lib/protocol.js` + `lib/shim.js`**：一个本地 OpenAI 兼容服务（`/v1/models`、`/v1/chat/completions`，支持 SSE 流式与工具调用的信封协议），把 OpenAI 请求翻译成 OpenCode 会话消息、再把响应翻回 OpenAI 格式。
- **`lib/index.js`**：DSH 入口（`name / inject / Config / apply`）。注册方式与 workbuddy 完全一致：`ctx.llm.registerAdapter` + `registerConfigurableProviders` + `registerModelDiscovery`，模型用 `@earendil-works/pi-ai` 的 `createProvider` + `openAICompletionsApi` + `PiAiAdapter` 接到 shim。

## 运行前提

- 已安装 DSH 和 **OpenCode**（`opencode` 在 `~/.opencode/bin`、npm 全局或 `PATH`）。
- OpenCode 里至少配置了一个**免费**模型/供应商（否则 provider 列表为空）。可用 `opencode models` 自查。

## 本地安装（自测）

两步即可让 DSH 加载（无需 `npm publish`）：

1. 把包目录拷进 profile 的 `node_modules`：
```powershell
Copy-Item -Recurse G:\xxx\dsh-connect-opencode "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-connect-opencode"
```
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` **数组末尾**加 `"dsh-connect-opencode"`。

注意：**不要**把它写进 `dependencies`——那会让 `pnpm install` 去 npm 拉一个不存在的版本而报错。加载只由 `bundles` 数组 + `node_modules` 物理目录驱动（插件自己的 `cordis.patch.yml` 会被逐层合入）。
然后**重启 DSH**（`patchReload: live` 只热更 patch 内容，bundles 列表变化必须重启）。

> 通过 dshmarket 安装/发布的插件不用做这两步——它会自动写依赖和 bundles。

改配置（enabled/binary/autoRefreshMin）在 profile 根 `cordis.patch.yml` 加一个条目即可，无需代码：
```yaml
- id: dsh-connect-opencode
  name: dsh-connect-opencode
  config:
    enabled: true
    autoRefreshMin: 10
```

CLI 可在 DSH 沙箱之外直接验证 opencode 链路（沙箱内 spawn 子进程会被拦，所以这一步必须在你本机终端跑）：

```sh
node dsh-connect-opencode/bin/cli.js doctor   # opencode 可执行文件是否找到
node dsh-connect-opencode/bin/cli.js models   # 列出发现的免费模型
node dsh-connect-opencode/bin/cli.js chat "你好"   # 走完整 shim+opencode 链路发一条消息
```

## 设置项（`Config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否向 DSH 提供 OpenCode provider |
| `binary` | `""` | opencode 可执行文件绝对路径；空=自动发现（`~/.opencode/bin`、npm 全局） |
| `autoRefreshMin` | `15` | 每隔多少分钟重扫一次免费模型（0=不重扫） |

> v0.1.0 暂未带前端设置卡片（无 client UI），改这些值目前可通过 profile 的 bundle 配置；卡片将在后续版本用 `dsh-client-ui-settings` 注入补上。

## 为什么模型列表是空的

provider 注册但模型为 0，通常因为：OpenCode 当前没有 cost=0 的模型；或 provider 名不是 `opencode`。
先用 `node bin/cli.js models` 看发现结果；需要免费额度可在 OpenCode 里配置带免费档的供应商。

## 发布（回答「怎么发布插件」）

插件本质是一个 **npm 包**，靠 `package.json` 的 `dsh` 字段被 DSH 识别。没有强制的注册平台：

1. **源码** 放 GitHub（可选但推荐，方便 issue/协作）。
2. **发布** 到 npm：`npm login && npm publish`（包名 `dsh-connect-opencode` 若被占用需改名）。别人 `npm i` 或 DSH 插件管理器安装。
3. **上架目录**（可选）：如 `dshfind.com` 这类第三方插件目录，提交你的包名/GitHub 链接以被更多人发现——非必需。

DSH 靠 `package.json` 里的：
```jsonc
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
和 `main: "lib/index.js"`、以及导出的 `name / inject / Config / apply` 把它当作插件加载。

## 已知边界

- **工具调用**：信封协议（`{content, calls}`）与 OpenAI `tool_calls` 的映射已实现，但**真实 opencode 端**的 `structured output` 返回字段名可能随版本变化——请用真实 `opencode serve` 跑 `bin/cli.js chat` 验证后再据此微调 `lib/opencode.js` 的 `format`/解析分支。沙箱内用 mock 已验证协议转换与 shim 全链路。
- **图片输入**：仅接受 base64 data URL（PNG/JPEG/WebP/GIF），整请求 ≤ 8 MB（同 ow-bridge）。
- **不转发** `temperature`/`max_tokens` 等采样参数；推理档位仅在模型声明 `variants` 时映射。

## 测试

`test/bridge.test.mjs` 用**模拟 opencode 服务器**（走 `fetch`，不 spawn 子进程）端到端验证：发现、`/v1/models`、非流式、SSE 流式、chat-only 拒绝工具、协议解码工具信封。运行：

```sh
node test/bridge.test.mjs
```

## 许可 / 致谢

MIT。协议层移植并简化自 `ow-bridge`（LaoDing，MIT），插件骨架结构参考 `dsh-connect-workbuddy`（dingminhua，MIT）。
