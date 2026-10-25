"""Verify the production Mod selection policy without launching Minecraft."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
JAVA_BIN = Path(r"C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin")
SOURCES = [
    ROOT / "minecraft-ai-mod/src/main/java/com/minecraffai/mod/MiningToolSelector.java",
    ROOT / "tests/java/MiningToolSelectorTest.java",
]

with tempfile.TemporaryDirectory(prefix="minecraft-mining-tools-") as output:
    subprocess.run([str(JAVA_BIN / "javac.exe"), "-encoding", "UTF-8", "-d", output, *map(str, SOURCES)], check=True)
    subprocess.run([str(JAVA_BIN / "java.exe"), "-cp", output, "com.minecraffai.mod.MiningToolSelectorTest"], check=True)
