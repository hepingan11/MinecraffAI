$classes = 'F:\Project\MinecraffAI\minecraft-ai-mod\build-manual\classes'
$resource = Get-Content -LiteralPath 'F:\Project\MinecraffAI\minecraft-ai-mod\src\main\resources\fabric.mod.json' -Raw
$resource = $resource.Replace('${version}', '0.2.0')
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $classes 'fabric.mod.json'), $resource, $utf8)
Copy-Item -LiteralPath 'F:\Project\MinecraffAI\minecraft-ai-mod\LICENSE' -Destination (Join-Path $classes 'LICENSE_minecraft-ai') -Force
$jar = 'C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin\jar.exe'
$out = 'F:\Project\MinecraffAI\minecraft-ai-mod\build\libs\minecraft-ai-0.2.0.jar'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
& $jar cf $out -C $classes .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $jar tf $out
