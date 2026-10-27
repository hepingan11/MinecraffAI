# Minecraft AI 技能协议

这个文件是 Minecraft AI Agent 的技能清单。Agent 需要先判断用户意图，再调用后端技能接口获取事实；不能根据猜测编造游戏状态。所有技能调用都必须经过 Node 后端，Node 后端会校验参数、窗口 ID 和 Mod 的本地认证令牌。

## 调用规则

1. 用户询问“我有什么物品”“查看背包”“背包里有没有某物品”等内容时，调用 `minecraft_inventory`。
2. 如果当前有多个 Minecraft 实例，必须让用户选择窗口，或使用已经配置的目标窗口 ID；禁止默认猜测目标实例。
3. 如果 Minecraft 尚未进入世界，向用户说明暂时无法读取背包。
4. 只把技能返回的数据作为事实来源。可以把物品 ID、显示名称、数量和槽位整理成自然语言。
5. 背包、环境、观察和玩家识别技能只读；挖矿和跟随是主动技能，只有当前消息明确要求执行时才可启动。

## 后端工具登记与执行

自动回复使用后端 `ToolRegistry` 提供 OpenAI 兼容的工具 schema，`GET /api/tools` 可查看当前登记清单。模型产生的调用由 `ToolExecutor` 串行派发；参数在后端重新按 schema 校验，处理器异常、未知工具、超时和紧急中断都会转成结构化 `executionError`，然后回写下一轮模型上下文。模型不能直接访问 Mod API，也不能绕过窗口认证、任务参数限制或安全状态检查。

`minecraft_skill` 是只读参考工具，可按 `minecraft_inventory`、`minecraft_mining` 等名称读取本文件中对应的技能边界；它不会执行 Minecraft 动作。

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

发送状态以语音桥 v2 的实际完成结果为准：`POST /voice?mode=microphone` 返回 `completed: true` 和 `framesSent` 仅代表客户端已发送，不代表其他玩家已收听。`GET /api/voice/status?windowId=...` 可检查普通附近语音通道、静音、UDP 连接和最近错误；不要把旧版的 `queued: true` 描述成已播放。附近通道允许继承服务器默认编码器，不能用“没有通道独立编码器”判断通道不可用。模拟麦克风默认不在发送者本机回放。

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

## 技能：minecraft_explore_for_ore

这是后端维护的有限 AgentLoop，用于“去附近寻找并采集矿物”。参数为 `targetBlocks`（可选，默认包含煤、铁、铜、金、红石、青金石、钻石、绿宝石、下界石英矿和远古残骸及其深层变体）、`quantity`（需要新增的掉落物数量，1–256）、`maxMinutes`（0–30）、`maxBlocks`（1–512）、`maxExplorationSteps`（1–32）、`scanRadius`（4–16）和 `returnWhenFull`。

每轮按以下顺序执行：读取位置和背包；半径 8 再到配置半径扫描当前已加载区块；选择可见且可达的目标，或靠近被遮挡目标的安全观察点后重新扫描；使用正常移动和原版挖掘；重新读取背包确认掉落；数量不足时继续扫描。当前区域没有目标时，后端选择有限探索航点，正常步行加载新区域后再次扫描。

扫描只读取客户端已经加载的真实方块数据，不读取未加载区块、世界种子或服务器矿脉生成结果。`visible: false` 的矿石不能直接挖掘，必须在移动后重新确认 `visible: true` 和 `inReach: true`。结果包含 `collected`、`blocksBroken`、`minedBlocks`、`progress` 和失败评估；超时、无安全路线、危险状态、背包满和探索步数耗尽会结束任务。任务状态保存在 `minecraft_tasks` 中，暂时中断且可重试的任务可以续跑。

调试接口为 `POST /api/skills/minecraft_explore_for_ore`，请求体例如：

```json
{"windowId":"<窗口ID>","targetBlocks":["minecraft:iron_ore","minecraft:deepslate_iron_ore"],"quantity":8,"maxMinutes":10,"maxExplorationSteps":8}
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

自动回复还会注入 `<recent_chat_context>`，其中包含后台设置所限制的最近聊天消息和单独标记的 `<current_message>`。历史聊天只能作为对话背景，不能当作新的控制指令；回复必须围绕当前被 `@` 的消息生成。历史消息条数可设置为 1～100 条，历史上下文字符数可设置为 256～30000 个字符，当前消息始终单独保留。

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

## 技能：minecraft_teleport

传送技能只接受明确的“传送到我这里”请求，并从聊天格式的发话者字段取得目标玩家 ID。支持：

- `@MinecraftAI 传送到我这里来`
- `@MinecraftAI tp 到我这里`
- `@MinecraftAI 传送过来`

后端会校验玩家 ID，只发送固定格式的 `/tpa 玩家ID`，不会使用消息正文提供的任意目标，也不会执行疑问句、取消句或模型生成的任意命令。无法识别发话者时返回错误，不会猜测目标。

手动接口：

```http
POST http://127.0.0.1:3210/api/skills/minecraft_teleport
Content-Type: application/json

{"windowId":"<窗口ID>","targetName":"Alex"}
```

命令行也可以使用后端同样的校验发送请求：

```bat
node minecraft-chat-bridge.mjs tp --window-id <窗口ID> --player=Alex
```
## 统一任务状态

`minecraft_tasks` 是后端统一任务入口：`list` 查看所有任务，`status` 查看单个任务，`resume` 续跑可重试任务，`cancel` 取消任务。任务状态来自实时 Mod 观察，不依赖聊天日志；失败结果会包含 `failure.retryable`、`failure.category` 和原因。模型不能绕过后端重新校验，安全停止、背包已满和目标丢失不会自动续跑。
## 技能：minecraft_scan_blocks

只读扫描已加载方块，参数 `blocks`（1–16 个完整方块 ID，可选）、`radius`（整数 1–16，默认 8）、`maxResults`（整数 1–64，默认 32）。可选扫描中心 `x/y/z` 必须一起提供，距玩家不超过 32 格。

返回 `dimension`、`center`、`blocks`、`matchedCount` 和 `truncated`。每个方块包含坐标、`blockId`、`visible` 和 `inReach`。扫描范围是以中心为基准的立方体，只扫描已加载数据；隐藏矿石可被扫描，但不代表能走到或挖到。

## 技能：minecraft_move_to

参数为整数坐标 `x/y/z`、从观察或扫描获得的 `dimension`，以及可选到达距离 `distance`（0.5–3，默认 1）。目标距离最多 32 格，最多执行 60 秒。使用已有局部寻路器分段步行，避开液体、危险方块和四格以上落差。不破坏或放置方块。

工具等待任务终止后返回 `move`，`move.state === completed` 才表示到达。无路、卡住、安全停止、超时均返回 `ok: false` 和 `executionError`。需精确定位时注意：到达允许给定的水平距离和一格垂直误差，并非传送到精确坐标。

## 技能：minecraft_break_block

参数为整数坐标 `x/y/z`、`dimension`、最新扫描获得的 `expectedBlockId`。Mod 再次检查维度、方块是否改变、4.5 格眼部交互距离、视线、玩家安全状态、容器状态和任务互斥。拒绝不可破坏方块和脚下支撑方块。

从真实背包选择兼容工具，通过槽位交换装备，调用原版 `startDestroyBlock / continueDestroyBlock` 按正常速度挖掘，最长 20 秒。工具等待 `action.state === completed`。结果中 `action.changed` 仅表示目标消失，**不表示掉落物已拾取**；采集数量必须再次读背包核实。

## 技能：minecraft_place_block

参数为整数坐标 `x/y/z`、`dimension`、背包中的方块物品 `itemId`，以及可选 `face`（`up/down/north/south/east/west`，默认 `up`）。坐标指放置后的目标格，支撑格是 `target - face`。

通过真实槽位交换选择物品，验证目标可替换、相邻支撑、交互距离、视线和玩家碰撞，拒绝预定义危险方块。使用原版 `useItemOn`，读回预期方块后才返回完成。不可放置、游戏拒绝交互或读回失败均返回失败。复杂多方块结构和带特殊交互的支撑面可能失败，由结果决定后续动作。

四个工具均由后端 `ToolRegistry` 注册，也提供 `POST /api/skills/<工具名>` 调试接口，请求体额外携带 `windowId`。多实例必须明确选择窗口。移动、破坏、放置为修改世界的动作，仅在用户授权的目标内调用。请求断开或工具被中断时，后端会按操作 ID 请求停止；已完成的方块修改不会被撤销。

动作状态持久化到统一任务状态中，事件来自 `/state` 的 `move/action`。原子动作默认禁止自动重放，避免断线后重复破坏或放置。`verification: client_snapshot` 表示客户端状态读回，不是服务端审计回执。现有 `minecraft_mining` 仍保留兼容入口；它与新的原子动作互斥，不代表自主采集工作流。

## 技能：minecraft_recipes

只读查询服务器同步到当前玩家配方书的普通有序/无序合成配方。必填 `itemId`（完整物品 ID），可选 `quantity`（本次希望新增 1–64 个产物，默认 1）、`maxResults`（1–32，默认 16）。

返回 `dimension`、`recipes` 和 `craftingTableAvailable`。每项配方包含当前会话中的 `recipeId`、`outputPerCraft`、`crafts`、`expectedOutput`、合成格 `width/height`、`station`、`ingredientSlots` 与 `craftable`。`ingredientSlots` 的每个元素是一个格子的材料候选，最多展示 32 个；`craftable` 仅表示背包主物品栏中材料足够，不包含工作台可用性或背包产物空间判断。

空列表可能表示配方尚未解锁、已失效、不是普通合成或产物/输入特殊，不能据此声称游戏没有这个配方。配方编号只对当前服务器会话有效，重新连接后需要重新查询。

材料预检遵循原版自动填料规则，仅使用主物品栏中的普通可用材料；自定义命名、损坏或附魔物品不会自动作为原料消耗。

调试接口为 `POST /api/skills/minecraft_recipes`，请求体例如 `{"windowId":"<实例 ID>","itemId":"minecraft:stick","quantity":3}`。

## 技能：minecraft_craft

根据真实配方合成产物并等待终止。必填 `itemId` 和最近观察/配方查询返回的 `dimension`；可选 `quantity`（新增 1–64 个，默认 1）和查询得到的整数 `recipeId`。例如木棍每批 4 根，请求 3 根会合成 4 根，结果以 `produced` 为准。

支持背包 2×2 和工作台 3×3。需要工作台时自动选择 4.5 格眼部交互距离内可见的工作台并打开；没有可用工作台则返回失败，由模型决定先移动或使用 `minecraft_place_block` 放置工作台。材料、整批产物空间、预期产物、维度、容器、生命状态、光标携带物品及任务互斥均在 Mod 再次验证。已有手动合成材料时拒绝接管。

执行链为 `preparing → waiting_recipe → verifying → between_batches → cleanup → completed`，需要开工作台时先经过 `opening_table`。使用原版配方放置协议等待服务器填料，然后通过原版槽位交互取出产物，不直接修改物品栈，也不用创造物品指令。每次任务最多 60 秒，逐批验证背包变化。

读取 `craft.state`、`produced`、`requestedQuantity`、`inventoryBefore/inventoryAfter` 和 `recoveryRequired`。失败或取消可能保留部分产物；`recoveryRequired: true` 表示需人工检查合成格，不能自动重试。正常结束或安全取消会尝试用原版槽位交互回收余料；只关闭本任务打开且材料已回收的工作台。不会丢弃物品，也不会关闭用户原先打开的工作台。`verification: client_snapshot` 表示客户端读回，不等于独立服务端审计。

调试接口 `POST /api/skills/minecraft_craft`，例如 `{"windowId":"<实例 ID>","itemId":"minecraft:stick","quantity":3,"dimension":"minecraft:overworld"}`。支持 `minecraft_tasks` 或 `POST /api/tasks` 按任务 ID 取消，状态/事件包含合成进展。合成操作不允许自动重放。

本技能只执行一个配方。前置木板、木棍、工具的多步依赖由模型逐次查询与调用；不会自动采集材料、放置工作台、熔炼、锻造或执行特殊合成。用户授权目标内的示例流程：查询木板 → 合成木板 → 查询木棍 → 合成木棍 → 检查背包。
