# Litematic 蓝图建造

后端蓝图目录由 `MC_AI_BLUEPRINT_DIR` 指定，未设置时为项目目录下的 `data/blueprints`。也可以用 `MC_AI_BLUEPRINT_DIRS` 配置多个目录，Windows 用分号分隔、Linux/macOS 用冒号分隔。后端会先通过 `minecraft_blueprints` 列出实际可用文件名，再使用文件名建造；只接受目录直属的 `.litematic` 文件，不接受任意路径。

```powershell
$env:MC_AI_BLUEPRINT_DIR = 'F:\Minecraft\schematics'
node minecraft-dashboard.mjs
```

如果蓝图放在 Minecraft 的 schematics 目录，可以直接指向该目录，不需要复制到项目中：

```powershell
$env:MC_AI_BLUEPRINT_DIR = 'G:\Game\你的实例\.minecraft\schematics'
node minecraft-dashboard.mjs
```

聊天中可以说“在我这里建这栋房子”，模型会先读取观察结果，再调用 `minecraft_build_blueprint`。也可以直接调用后端接口：

```http
POST http://127.0.0.1:3210/api/skills/minecraft_build_blueprint
Content-Type: application/json

{
  "windowId": "<Minecraft 窗口 ID>",
  "name": "japanese_cottage.litematic",
  "origin": {"x": 100, "y": 64, "z": -20},
  "rotation": 0,
  "dimension": "minecraft:overworld"
}
```

蓝图施工会读取材料、比较目标位置、低层优先放置并在每个目标前重新检查世界。目标已经有不可替换方块时默认停止；只有明确传 `allowBreaking: true` 才会清除障碍。材料不足默认在施工前拒绝，`allowPartial: true` 才允许先按现有材料施工，耗尽时保留进度并返回可续跑失败。

查询和停止使用 `minecraft_build_status`、`minecraft_build_stop`，或通用的 `POST /api/tasks`。任务中断后可以通过 `minecraft_tasks` 的 `resume` 重新加载蓝图并跳过已经完成的方块。

施工计划现在一次发送到 Mod，由 Mod 内部 tick 队列执行，避免逐方块 HTTP 往返。每个放置目标携带完整 `blockState`，Mod 会按目标朝向调整玩家视角，并在放置后逐属性读回；无法由原版玩家交互精确还原的特殊状态会失败并保留任务进度。真实施工前请先在备份世界用小型 `.litematic` 验证材料和朝向。
