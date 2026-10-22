"""Shared, pinned TLC command. Importing this module performs no I/O."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

JAR_SHA = "5bd7b64db99ae4c6c35f290de5e809c0ee41af43f8699cf696099ffb6452b1e2"
JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(out):
    cache = Path(os.environ.get("PRONTO_PROTOCOL_CACHE", Path.home() / ".cache/pronto-protocol"))
    cache.mkdir(parents=True, exist_ok=True)
    jar = cache / "tla2tools-1.8.0.jar"
    if not jar.exists():
        with tempfile.TemporaryDirectory(dir=cache) as directory:
            download = Path(directory) / "download.jar"
            urllib.request.urlretrieve(JAR_URL, download)
            require(sha(download) == JAR_SHA, "Official TLC download integrity failure")
            download.replace(jar)
    require(sha(jar) == JAR_SHA, f"TLC cache integrity failure: {jar}")
    java = os.environ.get("PRONTO_PROTOCOL_JAVA") or (
        str(Path(os.environ["JAVA_HOME"]) / "bin/java") if os.environ.get("JAVA_HOME") else "java")
    probe = subprocess.run([java, "-version"], text=True, capture_output=True, timeout=15)
    require(probe.returncode == 0, "No usable Java runtime. Set PRONTO_PROTOCOL_JAVA; see protocol/README.md")
    version = probe.stdout + probe.stderr
    require(re.search(r'version "(?:17|18|19|2\d)(?:\.|\")', version), "Use Java 17 through 29")
    (out / "toolchain.json").write_text(json.dumps({"java": version, "jar": JAR_URL, "sha256": JAR_SHA}, indent=2))
    return [java, "-XX:+UseParallelGC", "-Xmx2g", "-cp", str(jar), "tlc2.TLC",
            "-workers", "1", "-fp", "0", "-noGenerateSpecTE"]
