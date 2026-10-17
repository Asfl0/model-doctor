# Model Doctor

便携式（portable）模型能力测试器。输入 **Base URL + API Key + Model**，一键探测模型是否真的具备视觉、思考、函数调用、JSON 与流式能力。

**零依赖**：只用 Node.js 内置模块（`node:http`、`fetch`、`node:zlib`），不需要 `npm install`，不需要 Electron，不需要编译。拷走整个目录即可运行。

---

## 快速开始

```bash
# 1. 需要 Node.js >= 18
node -v

# 2. 启动（会自动打开浏览器）
node bin/model-doctor.mjs

# 指定端口
node bin/model-doctor.mjs --port 7788

# 不自动开浏览器
node bin/model-doctor.mjs --no-open
```

浏览器打开后：Base URL 与 API Key 已预填默认值，页面会自动向上游搜索模型列表，点标签或 🔍 选模型 → 勾测试项 → 开始测试。

### Windows 一键启动

双击 `start.bat` 即可。

也可以直接用命令行：`node bin\model-doctor.mjs`

> `start.bat` 必须保持 **ASCII + CRLF** 换行。若被编辑器另存成 LF，会报一堆 `'"' 不是内部或外部命令` 之类的错。

---

## 命令行模式（无界面，适合 CI）

```bash
node bin/model-doctor.mjs --base https://api.openai.com/v1 --key sk-xxx --model gpt-4o-mini
```

```
▶ 测试模型 gpt-4o-mini @ https://api.openai.com/v1

✔ 基础对话                     模型正常响应，延迟 812ms
✔ 视觉（Chatbox 等价）         视觉输入被接受，模型回复：The image is red.
✔ 函数调用（Chatbox 等价）     挂起 get_weather 工具后模型发起了工具调用（402ms 首块）
✔ 视觉识别（严格判分）          颜色识别正确（顺序 red,blue,green,yellow）
✔ 思考能力                     答案正确（9），并输出了思考内容
✔ 函数调用（严格判分）          正确调用 get_weather(location=San Francisco)
✔ JSON 模式                   返回合法 JSON 且字段齐全

结论: 能力全面  得分 1  (7/7)  P50 812ms
```

JSON 输出：

```bash
node bin/model-doctor.mjs --base ... --key ... --model ... --json > report.json
```

退出码：`0` 可用，`2` 基础对话失败（模型不可用）。

只跑指定项：

```bash
node bin/model-doctor.mjs --base ... --key ... --model ... --tests basic,vision,reasoning
```

---

## 测试项

### 复刻 Chatbox 的三项

Chatbox 开源仓库中 `src/renderer/utils/model-tester.ts` 的判定标准是**只验证请求成功、不校验内容**。本项目的前三项与它行为一致：

| 项 | Chatbox 原名 | 请求形态 | 判定 |
|---|---|---|---|
| 基础对话 | `basicTest` | `messages=[{user,'Hi'}]`，非流式 | **不发错即通过** |
| 视觉 | `visionTest` | 1x1 PNG + "What color is in this image?"，`onResultChange` 回调 | **多模态通道被接受即通过** |
| 函数调用 | `toolTest` | 流式 + `tools={get_weather}(execute 桩)`，prompt 只是 `"What is the weather in San Francisco?"`，**不传 `tool_choice`、不传 `max_tokens`**，`maxSteps:1` | **只要不抛异常就通过**（不校验响应内是否含 `tool_call`） |

> 三项都只能证明"接口没报错"：一个把图片当空气、把 `tools` 数组直接忽略的模型同样会全过——这是 Chatbox 原实现的固有限制，复刻时刻意保留了这个语义，否则无法与官方结果对账。
>
> 工具调用那项的请求形状与 Chatbox 逐字一致：**不在 prompt 里点名工具**、**不发 `tool_choice`**、**不发 `max_tokens`**、走流式。判据也一致——`try/catch` 包住 `chat()`，不抛异常即 ✓。模型是否真的会调工具、参数对不对，全部交给下面的严格项。

### 增强判分项

为了真正测出能力，额外做了 5 项严格校验：

| 项 | 方法 | 判定 |
|---|---|---|
| 视觉识别（严格） | 送 2x2 四色网格（红/蓝/绿/黄），要求按阅读顺序报色 | 至少 3/4 顺序正确 |
| 思考能力 | 经典"17 只羊，除了 9 只都跑了"题 + 要求输出思考过程 | 最终答案 == 9，并检测 `thinking` 内容 |
| 函数调用（严格） | 同上工具请求 | `tool_calls[0].function.name === 'get_weather'` 且 `location` 含 San Francisco |
| JSON 模式 | `response_format: {type:'json_object'}` | 返回可解析 JSON 且含 `name`/`age` |
| 流式输出 | `stream: true` SSE | 能收到内容，统计首 token 延迟 |

思考内容检测同时支持三种形式：`message.reasoning_content`、`message.reasoning`、正文内 `<think>...</think>`。

---

## 结论分级

| 分级 | 含义 |
|---|---|
| 能力全面 | 视觉/函数调用/思考/JSON 中≥3 项通过且无缺项 |
| 视觉 + 思考，缺 JSON | 部分能力，明确列出缺失项 |
| 仅文本对话 | 全部非基础项失败 |
| 不可用 | 基础对话就失败 |

---

## 目录结构

```
model-doctor/
├── bin/model-doctor.mjs      入口（服务模式 + CLI 模式）
├── src/
│   ├── server.mjs            本地 HTTP 服务（静态 + REST + SSE）
│   ├── core/
│   │   ├── constants.mjs     测试素材与提示词
│   │   ├── http.mjs          OpenAI 兼容客户端（流式/非流式/错误分类）
│   │   ├── tests.mjs         8 个测试项实现
│   │   └── runner.mjs        并发调度、取消、报告与结论判定
│   ├── web/                  前端（原生 HTML/CSS/JS，无构建）
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── assets/
│       ├── vision-grid.png   2x2 四色网格素材
│       └── vision-grid.b64
├── scripts/
│   ├── build-test-assets.mjs 重新生成视觉素材
│   ├── mock-upstream.mjs     本地 Mock 上游（自测用）
│   └── e2e-test.mjs          端到端自测
├── start.bat                 Windows 双击启动（CRLF + ASCII）
└── package.json
```

---

## API（也可被脚本直接调用）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/tests` | 测试项清单 |
| `POST` | `/api/models` | 拉上游模型列表 |
| `POST` | `/api/run` | 创建并异步启动测试，返回 `runId` |
| `GET` | `/api/run/:id` | 当前快照 |
| `GET` | `/api/run/:id/events` | SSE 实时进度 |
| `GET` | `/api/run/:id/report` | 完整报告 |
| `POST` | `/api/run/:id/cancel` | 取消 |

```bash
curl -X POST http://127.0.0.1:7788/api/run \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4o-mini","tests":["basic","vision","reasoning"]}'
```

---

## URL 参数（便于分享与自动化）

```
http://127.0.0.1:7788/?base=https://api.openai.com/v1&key=sk-xxx&model=gpt-4o-mini&tests=basic,vision&autostart=1
```

---

## 隐私

- 服务默认**只监听 `127.0.0.1`**，同一局域网其他机器无法访问。
- API Key 只在内存中使用，转发给上游；不会被写盘。
- 勾选"记住配置"后才会存入浏览器 `localStorage`，不上传任何地方。
- 无遥测、无外链请求。

---

## 自测

```bash
# 终端 1：启动 mock 上游
node scripts/mock-upstream.mjs 8099

# 终端 2：跑端到端测试
node scripts/e2e-test.mjs

# 或直接用 CLI 打 mock
node bin/model-doctor.mjs --base http://127.0.0.1:8099/v1 --key sk-test --model mock-vision
```

---

## 常见问题

**Q: 报 `HTTP 404`？**
Base URL 少写了 `/v1`。例如应填 `https://api.openai.com/v1` 而非 `https://api.openai.com`。

**Q: 视觉项通过但严格视觉项失败？**
说明模型接受图片但不真正理解图像内容——这是最常见的"伪多模态"。Chatbox 的视觉测试会放过这种模型，严格项不会。

**Q: 思考项显示"未输出思考内容"但仍然通过？**
说明模型答对了但没走推理链，通常是普通模型直接猜对。报告里 `sawThinking` 字段会如实标记。

**Q: 能否测试不支持 `/models` 接口的服务？**
可以。⟳ 拉列表只是便利功能，直接手输模型名即可。
