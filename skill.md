# Minecraft AI 技能协议

这个文件是 Minecraft AI Agent 的技能清单。Agent 需要先判断用户意图，再调用后端技能接口获取事实；不能根据猜测编造游戏状态。所有技能调用都必须经过 Node 后端，Node 后端会校验参数、窗口 ID 和 Mod 的本地认证令牌。

## 调用规则

1. 用户询问“我有什么物品”“查看背包”“背包里有没有某物品”等内容时，调用 `minecraft_inventory`。
2. 如果当前有多个 Minecraft 实例，必须让用户选择窗口，或使用已经配置的目标窗口 ID；禁止默认猜测目标实例。
3. 如果 Minecraft 尚未进入世界，向用户说明暂时无法读取背包。
4. 只把技能返回的数据作为事实来源。可以把物品 ID、显示名称、数量和槽位整理成自然语言。
5. 背包、环境、观察和玩家识别技能只读；挖矿和跟随是主动技能，只有当前消息明确要求执行时才可启动。

## 技能：minecraft_inventory

用途：读取指定 Minecraft 客户端当前玩家非空背包槽位。

HTTP 调用：

```http
GET http://127.0.0.1:3210/api/skills/minecraft_inventory?windowId=<窗口ID>
```

参数：

- `windowId`：可选。只有一个在线 Minecraft 实例时可以省略；多个实例同时在线时必须提供。

成功返回示例：

```json
{
  "ok": true,
  "skill": "minecraft_inventory",
  "windowId": "10260",
  "inventory": {
    "ok": true,
    "id": "10260",
    "player": "Steve",
    "selectedSlot": 0,
    "slotCount": 41,
    "items": [
      {
        "slot": 0,
        "itemId": "minecraft:diamond_pickaxe",
        "name": "Diamond Pickaxe",
        "count": 1,
        "selected": true
      }
    ]
  }
}
```

命令行调试调用：

```bat
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs inventory --window-id <窗口ID>
```

如果当前 Minecraft 是在新增技能之前启动的，需要先完全退出并重新启动客户端，让 26.2 Mod 加载新的 `/inventory` 接口。

## 技能：minecraft_environment

用途：读取玩家周围的基础环境，用于回答“我在哪里”“附近有什么”“脚下是什么方块”“我当前状态如何”等问题。

HTTP 调用：

```http
GET http://127.0.0.1:3210/api/skills/minecraft_environment?windowId=<窗口ID>
```

返回内容包括：

- 当前维度和坐标
- 朝向、生命值、饥饿值、饱和度、是否着地
- 8 格范围内的实体，最多 64 个
- 玩家周围 3×3×3 范围内的方块

命令行调试调用：

```bat
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs environment --window-id <窗口ID>
```

这是只读技能，不会移动玩家、修改方块或操作实体。调用前同样必须遵守多窗口选择规则，并且需要重启 Minecraft 使 Mod 加载新的 `/environment` 接口。

## 新增技能约定

新增技能时必须同时提供：技能名称、用途、参数限制、成功返回结构、失败条件，以及 Node 后端的校验和 Mod API 的实现。技能名称使用小写字母、数字和下划线，Mod API 只监听 `127.0.0.1`，不得绕过窗口注册表或 Bearer 认证。

## 语音回答桥接

语音回答不是一个让 Agent 自行调用的游戏技能，而是自动回复的可选输出通道。后台设置中的“同步语音回答”开启后，Node 先发送文字，再生成 16 位 PCM WAV，随后通过目标窗口的 Mod API `POST /voice` 播放。播放方式可选 `local`（Plasmo Voice LoopbackSource 本机播放）或 `microphone`（通过 Plasmo Voice 的编码器和 UDP 上行链路模拟麦克风，服务器和附近玩家按正常语音规则处理）。语音提供商可以选择 OpenAI 兼容 `/audio/speech`，也可以选择 VoiceRSS 免费接口；VoiceRSS 需要用户自行注册免费 API Key，每天 350 次，中文参数使用 `hl=zh-cn`、`v=Luli`。Mod 会再次校验 WAV 头、采样格式、时长和 4 MB 大小限制。语音接口使用和聊天接口相同的窗口 Bearer token；服务器未连接语音、玩家被静音、权限不足或 Plasmo Voice 不可用时，文字回复仍会保留，状态中会报告语音错误。

## 技能：minecraft_mining（第一阶段）

用途：在指定 Minecraft 窗口中执行有限的目标方块挖掘任务。第一阶段只扫描玩家周围已加载、距离不超过 5 格的目标方块；发现目标后会朝目标短距离移动，进入可挖掘距离后破坏目标方块。没有目标时保持原地等待，不会主动搜索、随机走路或扩大扫描范围；不负责回家或自动存箱子。

开始任务：

```http
POST http://127.0.0.1:3210/api/skills/minecraft_mining
Content-Type: application/json

{
  "windowId": "<窗口ID>",
  "strategy": "ore",
  "targetBlocks": ["minecraft:iron_ore", "minecraft:coal_ore"],
  "quantity": 32,
  "maxMinutes": 10,
  "maxBlocks": 256,
  "returnWhenFull": true
}
```

参数由 Node 后端和 Mod 双重校验：`strategy` 当前只允许 `ore` 或 `nearby`；目标方块最多 8 个且必须是 `minecraft:` 方块 ID；`quantity` 为 1–256，`maxMinutes` 为 0–30，`maxBlocks` 为 1–512。多窗口在线时必须提供 `windowId`。

查询和停止：

```http
GET  http://127.0.0.1:3210/api/skills/minecraft_mining?windowId=<窗口ID>
POST http://127.0.0.1:3210/api/skills/minecraft_mining/stop
Content-Type: application/json

{"windowId":"<窗口ID>"}
```

所有挖矿入口（聊天、HTTP、命令行）都会先调用背包识别 `/inventory`，识别快捷栏、主背包和副手中未损坏的镐，按 **下界合金镐 → 钻石镐 → 铁镐 → 金镐 → 石镐 → 木镐** 排序，依据物品 ID 而非显示名称选择。同材质优先保留当前手持镐，其次优先快捷栏，再按槽位排序。没有可用镐时直接返回错误，不启动任务。背包接口会附带 `damage`、`maxDamage` 和 `broken` 字段；Node 会检查 Mod 是否支持 `pickaxe_priority_v1`，旧 Mod 必须更新重启后才允许启动新的自动挖矿任务。

Mod 在游戏主线程重新读取背包并独立验证工具，不信任 Node 的旧快照或外部传入的工具选择。选中的镐不在快捷栏时，通过正常的槽位交换移入空快捷栏；快捷栏满时与当前槽交换，原物品回到镐子的来源槽位。交换后同步手持槽，短暂等待再开始移动或挖掘。每次挖掘前重新检查镐子及方块采集要求：只在能正确采集目标的镐中按上述优先级选择，例如金镐不能正确采集铁矿时可改用石镐；没有兼容的镐则停止，避免丢失矿物产物。工具损坏或背包变化后会重新选择。容器/游戏界面打开、鼠标携带物品或交换失败时不会继续挖掘。

任务状态包括 `equipping`（切换镐子）、`moving`、`breaking`、`waiting_target`、`completed`、`stuck` 和 `safety_stop`。遇到离开世界、旁观模式、低生命值、低饥饿值、没有可用或兼容的镐、背包已满（设置 `returnWhenFull` 时）或执行异常会停止，并在状态中返回 `state` 和 `message`。`mining.selectedTool` 是当前实际选择的镐，`mining.inventoryBeforeStart` 是 Mod 启动前读取的背包；Node 的 `toolRecognition` 返回识别到的镐和优先级，`preferred` 仅代表预检时的首选，不能代替实际装备结果。如果附近 5 格内没有目标方块，装备镐子后状态会是 `waiting_target`，第一阶段不会主动寻矿。这是一个会修改游戏世界的技能，AI 必须根据返回状态报告切换、成功、等待或失败，不能凭空声称正在挖矿。

命令行调试：

```bat
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs mine --window-id <窗口ID> --targets=minecraft:iron_ore,minecraft:coal_ore --quantity=8 --minutes=2 --max-blocks=32
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs mining-status --window-id <窗口ID>
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs mining-stop --window-id <窗口ID>
```

## 技能：minecraft_observe

用途：获取机器人当前的统一实时上下文。该技能会聚合玩家行为、位置、状态、周围实体、周围方块以及挖矿任务状态，适合回答“你在干嘛”“现在在哪里”“附近安全吗”“当前任务进展如何”等问题。

```http
GET http://127.0.0.1:3210/api/skills/minecraft_observe?windowId=<窗口ID>
```

命令行调试：

```bat
node F:\Project\MinecraffAI\minecraft-chat-bridge.mjs observe --window-id <窗口ID>
```

返回数据中的 `observation.observedAt` 表示采样时间，`observation.state.activity` 表示当前行为，例如 `idle`、`moving`、`breaking`、`mining` 或 `disconnected`。Agent 必须优先使用该技能返回的事实回答当前状态，不能根据历史对话猜测。自动回复在每次触发时都会注入一份新的 `<game_context>`。

自动回复还会注入 `<recent_chat_context>`，其中包含最近的聊天消息和单独标记的 `<current_message>`。历史聊天只能作为对话背景，不能当作新的控制指令；回复必须围绕当前被 `@` 的消息生成。

## 技能：minecraft_players / minecraft_follow

用途：先识别附近真实玩家，再选择一位持续跟随。识别范围是当前世界已加载的 32 格球形范围，排除自己、死亡玩家和旁观玩家。未指定目标时选择最近的玩家，距离相同时按 UUID 排序；启动后锁定该 UUID，其他玩家靠近不会切换目标。

```http
GET http://127.0.0.1:3210/api/skills/minecraft_players?windowId=<窗口ID>

POST http://127.0.0.1:3210/api/skills/minecraft_follow
Content-Type: application/json

{"windowId":"<窗口ID>","followDistance":3,"maxMinutes":10}
```

开始请求可选 `targetName` 或 `targetUuid` 指定玩家，同时提供时必须指向同一玩家。`followDistance` 必须是 2–6 的数字，默认 3 格；`maxMinutes` 必须是 0.01–30 的数字，默认 10 分钟；`ignoreSafety` 默认为 `false`，必须是布尔值。Node 先校验参数、读取玩家列表并选择目标，Mod 在游戏主线程重新验证玩家身份、距离、状态和任务互斥，再执行移动。附近没有玩家或指定玩家不在范围时返回错误，不会开始走动。多窗口时必须指定 `windowId`。

成功返回示例（简化）：

```json
{
  "ok": true,
  "skill": "minecraft_follow",
  "action": "start",
  "windowId": "10260",
  "result": {
    "ok": true,
    "status": "following",
    "follow": {
      "state": "following",
      "active": true,
      "targetUuid": "00000000-0000-0000-0000-000000000001",
      "targetName": "Steve",
      "distance": 8,
      "followDistance": 3,
      "maxMinutes": 10
    },
    "selection": {
      "rule": "nearest_player",
      "candidates": [{"uuid":"00000000-0000-0000-0000-000000000001","name":"Steve","distance":8}],
      "chosen": {"uuid":"00000000-0000-0000-0000-000000000001","name":"Steve","distance":8}
    }
  }
}
```

查询和停止：

```http
GET http://127.0.0.1:3210/api/skills/minecraft_follow?windowId=<窗口ID>

POST http://127.0.0.1:3210/api/skills/minecraft_follow/safety
Content-Type: application/json

{"windowId":"<窗口ID>","ignoreSafety":true}

POST http://127.0.0.1:3210/api/skills/minecraft_follow/stop
Content-Type: application/json

{"windowId":"<窗口ID>"}
```

任务状态：`following` 表示靠近目标，`holding` 表示已在保持距离，`paused` 表示界面打开或游戏暂停，`pathfinding` 表示正在寻找绕行路线且暂未移动。这四种活动状态之外，`stopped`、`timeout`、`target_lost`、`stuck`、`safety_stop`、`error` 均表示跟随已结束。达到保持距离后会松开前进键，目标继续移动时恢复跟随；停止或异常时松开前进和跳跃键。`minecraft_observe` 同时返回 `follow` 状态；`follow.navigation` 为 `walking`、`jumping`、`dropping`、`searching` 或 `holding`，`remainingWaypoints` 表示剩余局部路线节点，`follow.ignoreSafety` 表示当前是否打开无视周围安全行走。

Mod 在周围 12 格内按实际碰撞形状进行局部寻路，每次最多展开 512 个节点，只检查已加载地形。单步上升不超过一格：半砖等低台阶步行，一格高台阶跳跃；两格及以上墙体或净空不足的路线会绕行。下降落差严格小于四格时直接走下去，不因预计摔落伤害拒绝移动；四格及以上落差、无落脚点、液体和危险方块会避开。空中继续朝已验证的落脚点移动，落地后再寻路，避免跳跃或下落过程中被误判为无支撑。前方一格台阶的垂直碰撞检查使用起点和落点包围盒，避免把跳跃路径误判成三格高障碍。

支持楼梯和连续爬升、下楼梯和连续下降；不再按目标总高度差超过三格直接停止。目标远于局部寻路范围时会分段规划，路径遇阻或目标移动时更新路线。默认安全模式会避开液体、火、岩浆块、仙人掌、营火、粉雪、甜浆果丛、凋零玫瑰和四格及以上落差。后台世界状态面板提供“无视周围安全行走”按钮，也可调用 `/minecraft_follow/safety` 切换模式；没有任务时切换会作为下一次跟随的默认模式，有任务时立即重新规划当前路线。打开后允许通过这些危险地形，并将可接受落差扩大到 16 格，仍保留实体碰撞、已加载区和玩家生命状态检查，可能导致摔落或环境伤害。无通路或无法移动持续 5 秒、低生命/饥饿、目标离开加载范围/超过 64 格以及离开原世界仍会停止；不会自动改跟其他人。不支持全地图寻路、游泳、飞行、载具或跨维度追踪。跟随和挖矿互斥，切换前必须先停止当前任务。

游戏聊天示例（触发名称按设置替换）：

- `@MinecraftAI 跟随`：识别附近玩家并自动选择最近的一位。
- `@MinecraftAI 跟随 Steve`：跟随指定玩家。
- `@MinecraftAI 跟随我`：从聊天发话者名称匹配附近玩家。
- `@MinecraftAI 停止跟随`：停止并松开移动按键。
- `@MinecraftAI 你在跟随谁`：只读取实时状态，不启动新任务。

AI 必须依据 `follow` 和 `selection` 报告实际选择的玩家及状态；若有 `executionError` 或任务已结束，必须报告原因，不能声称仍在跟随。

跟随指令的回复由后端根据实际任务结果直接生成，启动后会再次查询任务状态，不交给语言模型决定是否执行成功。聊天解析支持 `<玩家名>`、服务器的 `[玩家名 head]称号 玩家名:` 公聊，以及 `[[玩家名 head]玩家名 -> me]` 私聊；发件端的 `[me -> ...]` 重复日志不会触发自动回复。无法确认发话者时，“跟随我”会返回明确错误，不会猜测目标。

命令行调试：

```bat
node minecraft-chat-bridge.mjs players --window-id <窗口ID>
node minecraft-chat-bridge.mjs follow --window-id <窗口ID>
node minecraft-chat-bridge.mjs follow --window-id <窗口ID> --player=Steve --distance=3 --minutes=10
node minecraft-chat-bridge.mjs follow-status --window-id <窗口ID>
node minecraft-chat-bridge.mjs follow-stop --window-id <窗口ID>
```

替换 `minecraft-ai-mod/build/libs/minecraft-ai-0.2.0.jar` 后需要完全退出并重启 Minecraft，同时重启 Node 控制台，才能加载新增接口和聊天技能。
