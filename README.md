# Minecraft AI

这是一个基于 **Fabric 客户端 Mod + 本地 API** 的 Minecraft 控制台。网页只负责展示和提交操作，窗口发现、认证、消息校验和 Minecraft 主线程执行都在后端完成。

## 当前版本

- Minecraft：26.2
- Fabric Loader：0.19.3
- Java：25
- 传输：仅监听 `127.0.0.1`

## 启动控制台

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

每个实例使用启动时生成的 Bearer token。Node 后端只接受本地地址，并在发送前限制消息长度、换行和目标窗口。

## AI 自动回复

打开控制台左侧的“设置”，填写 Base URL、API Key、模型、触发名称和系统提示词，然后启用自动回复。后端会实时增量读取游戏聊天日志；当消息包含 `@触发名称` 时，调用 OpenAI 兼容的 `/chat/completions` 接口，并把返回文本发送到选定的 Minecraft 窗口。

配置保存在项目目录的 `data\auto-reply.json`，API Key 不会通过网页接口明文返回。后端会校验 URL、模型、提示词长度、消息长度、换行和目标窗口；多个 Minecraft 实例同时在线时，必须在设置中选择目标窗口。

自动回复配置接口：

- `GET /api/automation/config`
- `PUT /api/automation/config`

## 知识库

点击网页左侧“知识库”即可添加、编辑、停用或删除条目。每条知识包含标题、关键词和正文，最多保存 200 条；自动回复时会根据触发聊天内容匹配最多 5 条相关知识，并把不超过 12000 个字符的相关内容加入 AI 上下文。

知识库文件保存在 `data\knowledge-base.json`，管理接口为 `GET/POST/PUT/DELETE /api/knowledge-base`。所有条目的标题、关键词、正文长度和 ID 都由后端校验。

Agent 技能协议见 [skill.md](skill.md)。当前技能包括：`minecraft_inventory` 读取非空背包槽位，`minecraft_environment` 读取位置、状态、附近实体和周边方块。Node 接口分别为 `GET /api/skills/minecraft_inventory` 和 `GET /api/skills/minecraft_environment`，命令行入口分别为 `inventory` 和 `environment`。

第一阶段挖矿技能 `minecraft_mining` 已提供有限任务控制：`POST /api/skills/minecraft_mining` 开始，`GET /api/skills/minecraft_mining?windowId=...` 查询，`POST /api/skills/minecraft_mining/stop` 停止。当前 Mod 只扫描玩家周围 5 格内的已加载目标方块；后端限制目标方块、任务时长、目标数量和最大挖掘方块数。新增的 `minecraft_observe` 会聚合玩家当前行为、环境和任务状态，自动回复每次触发都会注入实时上下文。详细参数和 CLI 示例见 [skill.md](skill.md)。

## 日志路径

默认日志使用当前整合包的 `logs\latest.log`。如果启动器目录不同，可以设置 `MC_LOG_PATH`；控制台端口可通过 `MC_DASHBOARD_PORT` 修改。
