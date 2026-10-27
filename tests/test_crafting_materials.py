"""Run the production material allocator against real Minecraft classes, without a world."""
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
JAVA_BIN = Path(r"C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin")
GAME_ROOT = Path(r"G:\Game")
candidates = []
for launcher in GAME_ROOT.iterdir():
    versions = launcher / ".minecraft" / "versions"
    if versions.is_dir():
        candidates.extend(p for p in versions.glob("*/*.jar") if p.stat().st_size > 30_000_000)
game_jar = next((p for p in candidates if "26.2" in p.parent.name), None)
if game_jar is None:
    raise SystemExit("Minecraft 26.2 jar not found")
libraries = list((game_jar.parent.parent.parent / "libraries").rglob("*.jar"))
classpath = ";".join(map(str, [game_jar, *libraries]))

def quote(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'

with tempfile.TemporaryDirectory(prefix="minecraft-craft-native-") as directory:
    output = Path(directory)
    sources = [ROOT / "minecraft-ai-mod/src/main/java/com/minecraffai/mod/CraftingMaterials.java", ROOT / "tests/java/CraftingMaterialsTest.java"]
    compile_args = output / "compile.args"
    compile_args.write_text("-encoding\nUTF-8\n-cp\n" + quote(classpath) + "\n-d\n" + quote(output) + "\n" + "\n".join(map(quote, sources)), encoding="utf-8")
    subprocess.run([str(JAVA_BIN / "javac.exe"), f"@{compile_args}"], check=True)
    # A manifest avoids Windows command-length and native argfile-encoding limits
    # when the launcher/game directory contains Chinese characters.
    manifest_value = "Class-Path: " + " ".join(p.as_uri() for p in [game_jar, *libraries])
    wrapped = "\r\n ".join(manifest_value[i:i + 68] for i in range(0, len(manifest_value), 68))
    runtime_jar = output / "classpath.jar"
    with zipfile.ZipFile(runtime_jar, "w") as archive:
        archive.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n" + wrapped + "\r\n\r\n")
    subprocess.run([str(JAVA_BIN / "java.exe"), "-cp", str(output) + ";" + str(runtime_jar), "com.minecraffai.mod.CraftingMaterialsTest"], check=True, cwd=output)
