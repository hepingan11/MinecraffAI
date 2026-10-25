from pathlib import Path
import subprocess


PROJECT = Path(__file__).resolve().parent
GAME_ROOT = Path(r"G:\Game")
SOURCES = sorted((PROJECT / "src/main/java").rglob("*.java"))
OUTPUT = PROJECT / "build-manual/classes"
ARGS = PROJECT / "build-manual/javac.args"
JAVAC = Path(r"C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-epsilon\bin\javac.exe")


def find_game_jar() -> Path:
    candidates = []
    for launcher_dir in GAME_ROOT.iterdir():
        versions = launcher_dir / ".minecraft" / "versions"
        if not versions.is_dir():
            continue
        candidates.extend(p for p in versions.glob("*/*.jar") if p.stat().st_size > 30_000_000)
    if not candidates:
        raise SystemExit("Minecraft 26.2 game jar was not found under G:\\Game")
    return next((p for p in candidates if "26.2" in p.parent.name), candidates[0])


def quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


game_jar = find_game_jar()
libraries = list((game_jar.parent.parent.parent / "libraries").rglob("*.jar"))
classpath = ";".join(str(path) for path in [game_jar, *libraries])
OUTPUT.mkdir(parents=True, exist_ok=True)
ARGS.parent.mkdir(parents=True, exist_ok=True)
ARGS.write_text(
    "-encoding\nUTF-8\n-cp\n"
    + quote(classpath)
    + "\n-d\n"
    + quote(str(OUTPUT))
    + "\n"
    + "\n".join(quote(str(source)) for source in SOURCES)
    + "\n",
    encoding="utf-8",
)
print(f"Compiling against {game_jar}")
subprocess.run([str(JAVAC), f"@{ARGS}"], check=True)
