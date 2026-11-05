$gameJar = Get-ChildItem -LiteralPath 'G:\Game' -Directory | ForEach-Object {
    $versions = Join-Path $_.FullName '.minecraft\versions'
    if (Test-Path -LiteralPath $versions) { Get-ChildItem -LiteralPath $versions -Filter '*.jar' -Recurse -File }
} | Where-Object { $_.Length -gt 30000000 } | Select-Object -First 1
if (-not $gameJar) { throw '26.2 game jar not found' }
$game = Join-Path $gameJar.Directory.FullName 'mods'
$oldJars = @(Get-ChildItem -LiteralPath $game -Filter 'minecraft-ai-*.jar')
foreach ($oldJar in $oldJars) {
    try { Remove-Item -LiteralPath $oldJar.FullName -Force -ErrorAction Stop }
    catch { throw "Minecraft client is running; close all Minecraft clients and run this script again." }
}
Copy-Item -LiteralPath 'F:\Project\MinecraffAI\minecraft-ai-mod\build\libs\minecraft-ai-0.2.0.jar' -Destination (Join-Path $game 'minecraft-ai-0.2.0.jar') -Force
Get-ChildItem -LiteralPath $game -Filter 'minecraft-ai-*.jar' | Select-Object FullName, Length, LastWriteTime
