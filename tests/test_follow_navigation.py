"""Compile/run the production pathfinder with terrain fixtures, without launching Minecraft."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
JAVA_BIN = Path(r"C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin")
SOURCES = [
    ROOT / "minecraft-ai-mod/src/main/java/com/minecraffai/mod/FollowPathfinder.java",
    ROOT / "tests/java/FollowPathfinderTest.java",
]

with tempfile.TemporaryDirectory(prefix="minecraft-follow-navigation-") as output:
    subprocess.run([str(JAVA_BIN / "javac.exe"), "-encoding", "UTF-8", "-d", output, *map(str, SOURCES)], check=True)
    subprocess.run([str(JAVA_BIN / "java.exe"), "-cp", output, "com.minecraffai.mod.FollowPathfinderTest"], check=True)
