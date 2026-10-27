# Minecraft AI

这是一个基于 **Fabric 客户端 Mod + 本地 API** 的 Minecraft 控制台。网页只负责展示和提交操作，窗口发现、认证、消息校验和 Minecraft 主线程执行都在后端完成。

## 当前版本

- Minecraft：26.2
- Fabric Loader：0.19.3
- Java：25
- 传输：仅监听 `127.0.0.1`

## 启动控制台

首次启动或更新依赖后，在项目目录执行 `npm install`（千问实时 TTS 使用 `ws` WebSocket 客户端）。

```bat
F:\Project\MinecraffAI\minecraft-dashboard.cmd
```

然后打开 <http://127.0.0.1:3210>。控制台会读取游戏日志中的聊天信息，并通过 Mod API 发送聊天消息。

## 多窗口

每个 Minecraft 客户端进程都会在自己的游戏目录写入：

```text
<gameDir>\minecraft-ai\windows\<pid>.json
```

网页会列出所有仍能通过健康检查的实例。检测到多个实例时必须先选择目标窗口；后端会再次校验窗口 ID，避免前端传入过期或伪造的目标。

命令行查看窗口：

```bat
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs windows
```

## 安装 26.2 Mod

当前 26.2 没有可用的 Yarn/官方 Loom mappings，因此 Mod 使用实际 26.2 游戏 jar 和 Java 25 直接编译。已经构建的文件为：

```text
minecraft-ai-mod\build\libs\minecraft-ai-0.2.0.jar
```

PCL 使用自定义 `--gameDir` 时，Mod 必须放到版本目录下的 `mods`：

```text
<gameDir>\mods\minecraft-ai-0.2.0.jar
```

替换 jar 后必须完全退出并重新启动 Minecraft，Mod 启动后才会创建窗口注册文件。

## API

- `GET /health`
- `GET /state`
- `GET /inventory`
- `POST /chat`，请求体 `{ "message": "..." }`
- `POST /voice`，请求体为不超过 4 MB 的 16 位 PCM WAV，由 Plasmo Voice 客户端 LoopbackSource 播放

每个实例使用启动时生成的 Bearer token。Node 后端只接受本地地址，并在发送前限制消息长度、换行和目标窗口。

## AI 自动回复

打开控制台左侧的“设置”，填写 Base URL、API Key、模型、触发名称和系统提示词，然后启用自动回复。后端会实时增量读取游戏聊天日志；当消息包含 `@触发名称` 时，调用 OpenAI 兼容的 `/chat/completions` 接口，并把返回文本发送到选定的 Minecraft 窗口。

配置保存在项目目录的 `data\auto-reply.json`，API Key 不会通过网页接口明文返回。后端会校验 URL、模型、提示词长度、消息长度、换行和目标窗口；多个 Minecraft 实例同时在线时，必须在设置中选择目标窗口。

自动回复设置中的“历史消息条数”和“历史上下文字符数”可以自定义发送给 AI 的聊天背景，后端限制范围分别为 1～100 条和 256～30000 个字符；当前消息始终单独保留，不受历史条数限制。

设置中的“同步语音回答”开启后，文字回复发送成功才会生成 WAV，再交给 Minecraft Mod 的 `/voice` 接口。播放方式可选“本机播放”或“模拟麦克风发送给玩家”。模拟麦克风模式会调用 Plasmo Voice 的编码器和 UDP 上行链路，服务器会按正常语音权限、静音状态和语音距离处理，附近玩家可以听见。语音接口支持 OpenAI 兼容、VoiceRSS 免费接口和千问 TTS。VoiceRSS 每天提供 350 次免费请求，注册后取得 API Key，在设置中选择“VoiceRSS 免费（350 次/天）”、填写语音 API Key、语言 `zh-cn` 和音色 `Luli` 即可使用；VoiceRSS 不需要填写 Base URL 或模型。OpenAI 兼容模式仍使用 `/audio/speech`，语音 Base URL 留空时复用 AI Base URL。Minecraft 必须安装 Plasmo Voice（当前整合包中的 `语音模组-fabric-26.2.jar`），并完全重启客户端加载新 Mod。

千问语音：选择“千问 TTS（实时语音合成）”，在“语音 API Key”填写千问平台的 Key，默认模型为 `qwen3-tts-flash-realtime`，音色为 `Cherry`，语言为 `zh-cn`。语音 Base URL 留空时使用[官方模型 API 示例](https://www.qianwenai.com/models/qwen3-tts-flash-realtime#api-reference)中的 `wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/realtime`，也可填写与 Key 对应的百炼 WebSocket 地址（如 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`）；千问不会复用 AI 的 Base URL 或 Key。后端按[客户端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events)和[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-server-events)处理实时会话，将 24 kHz、16 位单声道 PCM 合并为 WAV，完整合成成功后才播放；超时、提前断线、无效或超过 4 MB 的音频会报错。语音速度沿用 -10～10，映射为千问的 0.5～2.0 倍速（0 为正常速度）。语音 Key 只保存在后端配置中，不会通过配置读取接口明文返回。验证：`node --test tests/qwen-tts.test.mjs tests/voice.test.mjs`。

自动回复配置接口：

- `GET /api/automation/config`
- `PUT /api/automation/config`

语音排错：设置页的“检查语音连接”调用 `GET /api/voice/status?windowId=...`，会显示语音通道、有效距离、麦克风静音、UDP 连接和最近一次发送错误。Mod 的 `GET /voice` 返回 `voiceBridgeVersion: 2`；旧版仅返回入队成功，必须完全重启 Minecraft 更新。新版 `POST /voice` 等到本机播放或客户端发送完成才返回 `completed: true`，不会把入队当成完成。附近语音使用服务器的普通 `proximity` 通道和默认编码器配置，不会自动改用群组/广播通道；真实麦克风正在发言时拒绝并发发送。模拟麦克风模式默认不回放给发送者，需要用附近另一位玩家确认接收；客户端发送完成不能证明对方已听见。Minecraft 重启后窗口 ID 会变化，请在后台重新选择并保存目标窗口。回归验证：`python tests/test_voice_bridge.py`、`node --test tests/voice.test.mjs`。

## 知识库

点击网页左侧“知识库”即可添加、编辑、停用或删除条目。每条知识包含标题、关键词和正文，最多保存 200 条；自动回复时会根据触发聊天内容匹配最多 5 条相关知识，并把不超过 12000 个字符的相关内容加入 AI 上下文。

知识库文件保存在 `data\knowledge-base.json`，管理接口为 `GET/POST/PUT/DELETE /api/knowledge-base`。所有条目的标题、关键词、正文长度和 ID 都由后端校验。

## 自主进化与经验学习

自动回复成功后，后端会把本次用户问题、助手回答和技能结果保存为一条“待审核经验”，文件位于 `data\experiences.json`。待审核经验不会进入模型上下文；在网页左侧“经验学习”中审核通过后，系统才会按聊天内容检索并注入相关经验。经验只能影响回答内容和表达，不能改变安全策略、窗口选择、技能参数上限或执行权限。

也可以在游戏中发送明确反馈：`@MinecraftAI 记住这条` 或 `@MinecraftAI 以后都这样：先观察实时状态再回答` 会启用最近一条经验；`@MinecraftAI 回答错了` 会停用最近一条经验。后端只识别这些明确命令，不根据模型自行判断学习结果。经验接口为 `GET/POST/PUT/DELETE /api/experiences`、`POST /api/experiences/:id/approve`、`POST /api/experiences/:id/reject` 和 `POST /api/experiences/feedback`。

Agent 技能协议见 [skill.md](skill.md)。当前技能包括：`minecraft_inventory` 读取非空背包槽位，`minecraft_environment` 读取位置、状态、附近实体和周边方块。Node 接口分别为 `GET /api/skills/minecraft_inventory` 和 `GET /api/skills/minecraft_environment`，命令行入口分别为 `inventory` 和 `environment`。

第一阶段挖矿技能 `minecraft_mining` 已提供有限任务控制：`POST /api/skills/minecraft_mining` 开始，`GET /api/skills/minecraft_mining?windowId=...` 查询，`POST /api/skills/minecraft_mining/stop` 停止。当前 Mod 只扫描玩家周围 5 格内的已加载目标方块；发现目标后会短距离靠近再挖掘，没有目标时原地等待，不会主动寻矿。后端限制目标方块、任务时长、目标数量和最大挖掘方块数。新增的 `minecraft_observe` 会聚合玩家当前行为、环境和任务状态，自动回复每次触发都会注入实时上下文。详细参数和 CLI 示例见 [skill.md](skill.md)。

## 挖矿工具选择

自动挖矿会先读取背包，按“下界合金镐 → 钻石镐 → 铁镐 → 金镐 → 石镐 → 木镐”选择工具；主背包和副手中的镐会交换到快捷栏后再使用。实际挖掘时仅选择能正确采集目标方块的镐，无可用镐则停止。任务状态会显示 `equipping`（切换镐子中）和实际 `selectedTool`。此能力需要更新并重启 Mod，校验与交换都由后端和 Mod 执行。验证：`node --test tests/mining.test.mjs`、`python tests/test_mining_tools.py`。

## 跟随玩家

新增 `minecraft_players`（识别附近玩家）和 `minecraft_follow`（选择并持续跟随）。聊天输入 `@MinecraftAI 跟随`，AI 会先识别 32 格内的其他玩家，多人时选择最近的一位并锁定 UUID；也可使用 `跟随 Steve`、`跟随我` 和 `停止跟随`。靠近后保持约 3 格距离，目标继续移动时恢复跟随；与挖矿任务互斥。Mod 会在周围 12 格内进行局部寻路：一格台阶跳跃通过，两格及以上障碍绕行，小于四格的落差允许直接下落（可能受到摔落伤害），四格及以上落差避开；现在支持下楼梯和连续下降。支持半砖、楼梯和连续台阶，不再因目标总高度差超过三格直接停止；无可通行路线持续 5 秒后停止。世界状态面板新增“无视周围安全行走”按钮，打开后允许通过危险方块并接受更大的下落风险，仍保留实体碰撞和生命状态检查。

接口为 `GET /api/skills/minecraft_players`、`POST/GET /api/skills/minecraft_follow` 和 `POST /api/skills/minecraft_follow/stop`；参数限制、状态和命令行示例见 [skill.md](skill.md)。替换构建的 Mod jar 后，完全退出并重启 Minecraft，同时重启控制台使新技能生效。

新增 `minecraft_teleport` 传送技能。玩家在聊天中发送 `@MinecraftAI 传送到我这里来`、`@MinecraftAI tp 到我这里` 或 `@MinecraftAI 传送过来` 时，后端从聊天前缀解析真实玩家 ID，并通过 Mod 发送 `/tpa 玩家ID`。不会接受消息正文中的任意目标 ID，也不会执行疑问句或取消指令。接口为 `POST /api/skills/minecraft_teleport`，参数为 `windowId` 和经过后端校验的 `targetName`。

验证命令：`node --test tests/follow.test.mjs`、`python tests/test_follow_navigation.py`；Mod 编译：`python minecraft-ai-mod/compile-manual.py`。

## 日志路径

默认日志使用当前整合包的 `logs\latest.log`。如果启动器目录不同，可以设置 `MC_LOG_PATH`；控制台端口可通过 `MC_DASHBOARD_PORT` 修改。

## 统一事件与任务状态

控制台现在维护统一的后端事件队列。聊天日志只是 `chat.message` 事件来源之一；`MinecraftEventSource` 会轮询 Mod 的实时状态，把连接、世界快照、挖矿和跟随任务状态变化写入同一队列，高频快照会合并，失败和断线事件会提升为紧急事件。

任务状态保存在 `data\tasks.json`，包括目标状态、进度、失败原因、是否可重试、尝试次数和续跑次数。模型可以通过 `minecraft_tasks` 查询、续跑或取消任务；控制台接口为 `GET/POST /api/tasks`，事件诊断接口为 `GET /api/events`。所有续跑参数仍由后端重新校验，安全停止、背包已满和目标丢失不会自动重试。

## Numen 风格工具执行器

工具登记和执行已经迁移为后端控制的 Numen 风格边界：模型只能看到工具名称、说明和参数 schema，真正的处理器只保留在 Node 后端。`ToolRegistry` 会拒绝重复或非法工具名，并在调用处理器前重新校验 JSON 参数；工具名允许一次大小写修复，未知工具会返回结构化失败。

`ToolExecutor` 对每个模型回复中的调用按顺序执行，逐个发出 `agent.tool_started` 和 `agent.tool_result` 事件，再把结果写回 ReAct 对话。执行批次有数量和单调用时限；聊天、断线和其他紧急事件可以中断当前调用，当前和排队调用都会以失败结果结算，模型不会收到未配对的工具消息。工具清单和执行器诊断可通过 `GET /api/tools` 查看。

## 自动合成

新增 `minecraft_recipes` 和 `minecraft_craft`：查询当前服务器已解锁的真实配方，支持背包 2×2 与交互范围内可见工作台的 3×3 合成。模型可以依次完成“原木 → 木板 → 木棍/工作台 → 工具”，每一步结果回到 ReAct 再判断；前置材料和工作台仍需实际获取。数量表示本次新增产物，按配方整批取整。

Mod 在主线程校验材料、背包空间、维度、容器和任务互斥，通过原版协议填料、取出并读回背包。合成任务接入统一事件/状态和取消机制，失败后不自动重放；取消时保留已完成产物，无法安全回收的材料通过 `recoveryRequired` 提示检查。

接口、限制和验证说明见 [自动合成说明](docs/crafting.md) 与 [技能协议](skill.md)。替换 Mod 后需完全退出并重启 Minecraft，同时重启 Node 控制台。
