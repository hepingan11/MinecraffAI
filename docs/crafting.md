# 自动合成技能

模型现在可以通过 `minecraft_recipes` 查询配方、通过 `minecraft_craft` 执行一个配方。依赖步骤由 ReAct 逐次判断，例如先把原木做成木板，再做木棍。普通工具、木板、工作台等没有在 Node 中写死配方表。

## 数据与执行

配方来自 Minecraft 26.2 客户端收到的 `RecipeDisplayEntry`，只使用当前玩家已解锁的普通有序/无序合成配方。材料匹配交给原生 `StackedItemContents`，支持配方中的候选物品与标签；完整请求的所有批次会一起做材料预检。

自动填料遵循原版限制，仅使用主物品栏中适合自动合成的材料；自定义命名、损坏或附魔物品不会被当作普通原料消耗。候选材料之间的重叠由原生分配器解决，不能把同一块木板同时算给两个合成格。

`quantity` 表示希望本次新增的物品数，范围 1–64。实际数量向配方完整批次取整，例如木棍每批 4 根，请求 3 根得到 4 根。已有背包物品不抵扣这个目标。`recipeId` 是服务器会话中的显示编号，重新连接后需重新查询。

```text
模型查询配方和材料
  → Mod 再次检查请求、材料、容量和当前世界
  → 使用背包合成格，或打开交互距离内可见工作台
  → handlePlaceRecipe（一次一批）
  → 等待服务器填料并确认预期结果槽
  → handleContainerInput / QUICK_MOVE 取出
  → 等待背包数量变化
  → 下一批或回收余料
  → 结果回到模型
```

Mod 在主线程执行，使用真实服务器配方放置和玩家槽位交互，不直接增减物品栈。背包 2×2 和工作台 3×3 都支持；自动打开工作台前检查视线、4.5 格距离和潜行状态。对于用户已打开的工作台，保留原界面；对于本任务打开的工作台，仅在余料已安全回收后关闭。

执行前拒绝已有手动合成内容、其他容器/界面、光标携物、不安全玩家状态、错误维度、材料不足、背包产物空间不足或与其他动作冲突的请求。运行期间重新检查容器、材料和产物；每个任务最多 60 秒，失败保留实际部分产物，不自动补做或重放。

## 接口

| 工具 | Node HTTP | Mod HTTP |
| --- | --- | --- |
| `minecraft_recipes` | `POST /api/skills/minecraft_recipes` | `POST /craft/recipes` |
| `minecraft_craft` | `POST /api/skills/minecraft_craft` | `POST /craft/start`、`GET /craft/status` |
| 取消合成任务 | `POST /api/tasks`，`action: cancel` | `POST /craft/stop`，携带操作 UUID |

查询示例：

```json
{"windowId":"<实例 ID>","itemId":"minecraft:stick","quantity":3}
```

合成示例，`dimension` 使用刚查询/观察到的维度：

```json
{"windowId":"<实例 ID>","itemId":"minecraft:stick","quantity":3,"dimension":"minecraft:overworld"}
```

模型自动选择配方时可以省略 `recipeId`；指定时必须匹配当前服务器已知配方和请求的产物。没有可见工作台时返回失败，模型可以先移动，或用既有放置工具放下背包中的工作台后再合成。

结果中的 `craft` 包含操作 UUID、`state`、`active`、`requestedQuantity`、`expectedOutput`、`produced`、`batches`、`inventoryBefore/inventoryAfter` 和 `recoveryRequired`。统一任务中的 `taskId` 与 Mod 操作 UUID 是两个不同的 ID；前者用于 `/api/tasks`，后者由后端用于取消物理操作。

`verification: client_snapshot` 表示对客户端背包的稳定读回。服务器填料结果与客户端预测后的背包读回是不同阶段，本实现不把客户端预测描述成服务端审计回执。

## 取消与失败

取消会按操作 UUID 停止继续合成，并等待在途填料与清理。未确认的填料不能被当作空格安全结束；收不到响应时返回失败和人工检查提示。已有物品不会撤销，剩余材料只尝试用普通槽位移动回背包，不使用丢弃操作。

发生断线、世界/容器切换或安全状态变化时停止自动交互。材料可能保留在合成格中；`recoveryRequired: true` 时先人工检查。操作的 `resumePolicy` 为 `never`，模型必须观察实际部分产物后决定新的目标，不能直接重放失败请求。

当前不支持未解锁配方、熔炼、锻造、特殊合成、产物同时也是输入的配方，或单配方内部自动递归获取/合成原料。不同服务器可能还有额外限制，由真实结果决定能否继续。

## 验证

`tests/crafting.test.mjs` 使用真实本地 HTTP 服务模拟 Mod，并使用生产工具登记、任务状态和 ReAct 实现。覆盖参数拒绝、配方元数据、批次数量取整、完成等待、失败不重试、取消传递、清理失败与部分产物、事件关联以及实际启动的控制台接口。

ReAct 示例通过模拟模型依次执行：查询木板 → 合成 4 块木板 → 查询木棍 → 合成 4 根木棍 → 读取背包，最终验证剩余 2 块木板。该测试验证后端编排，不等于真实游戏内验收。

验证命令为 `npm test` 和 `python minecraft-ai-mod/compile-manual.py`。构建通过后使用 `minecraft-ai-mod/package-manual.ps1` 生成 `minecraft-ai-mod/build/libs/minecraft-ai-0.2.0.jar`。真实游戏中的服务器填料、工作台界面和延迟场景需加载新 Mod 后验收。

另有 `python tests/test_crafting_materials.py`：在不创建世界的 JVM 中运行生产 `CraftingMaterials` 和真实 Minecraft 分配器，验证 9 项材料分配边界，包括混合木材、重叠候选、重复占用、完整批次不足、64 批次、空物品以及命名物品保护。测试为普通木材绑定通用物品组件，不代替完整世界数据包加载或游戏内合成验收。
