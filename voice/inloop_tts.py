# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx>=0.4.9", "soundfile>=0.12"]
# ///
"""inloop's local voice: Kokoro-82M (Apache-2.0) through kokoro-onnx, offline.

  uv run --script inloop_tts.py setup             download the model once (~200 MB)
  uv run --script inloop_tts.py status            {"ready": true|false}
  uv run --script inloop_tts.py synth VOICE SPEED  texts as a JSON list on stdin;
                                                   prints one WAV path per text, in order, as each is ready

Nothing leaves the machine after setup. Files live in ~/.cache/inloop/.
"""

import json
import os
import sys
import time
import urllib.request

try:
    import fcntl
except ImportError:  # Windows: no file locks; a lone session sets up fine without one.
    fcntl = None

CACHE = os.path.join(os.path.expanduser("~"), ".cache", "inloop")
MODEL_DIR = os.path.join(CACHE, "kokoro")
AUDIO_DIR = os.path.join(CACHE, "tts")
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {"kokoro-v1.0.fp16.onnx": 150_000_000, "voices-v1.0.bin": 20_000_000}


def paths():
    return [os.path.join(MODEL_DIR, name) for name in FILES]


def is_ready():
    return all(os.path.exists(p) and os.path.getsize(p) >= FILES[os.path.basename(p)] for p in paths())


def setup():
    os.makedirs(MODEL_DIR, exist_ok=True)
    # Sessions starting together each try to set up: one downloads, the rest wait for it.
    with open(os.path.join(MODEL_DIR, ".lock"), "w") as lock:
        if fcntl is not None:
            fcntl.flock(lock, fcntl.LOCK_EX)
        download()
    load()
    print("ready", flush=True)


def download():
    for name, least in FILES.items():
        target = os.path.join(MODEL_DIR, name)
        if os.path.exists(target) and os.path.getsize(target) >= least:
            print(f"have {name}", flush=True)
            continue
        print(f"downloading {name}…", flush=True)
        partial = target + ".part"
        urllib.request.urlretrieve(RELEASE + name, partial)
        if os.path.getsize(partial) < least:
            raise SystemExit(f"{name}: download incomplete")
        os.replace(partial, target)


def load():
    from kokoro_onnx import Kokoro

    model, voices = paths()
    return Kokoro(model, voices)


def tidy():
    """Keeps the audio folder from growing: clips older than an hour go."""
    os.makedirs(AUDIO_DIR, exist_ok=True)
    cutoff = time.time() - 3600
    for name in os.listdir(AUDIO_DIR):
        full = os.path.join(AUDIO_DIR, name)
        try:
            if os.path.getmtime(full) < cutoff:
                os.remove(full)
        except OSError:
            pass


def synth(voice, speed):
    import soundfile

    texts = json.loads(sys.stdin.read() or "[]")
    tidy()
    kokoro = load()
    stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
    for i, text in enumerate(texts):
        samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        out = os.path.join(AUDIO_DIR, f"{stamp}-{i}.wav")
        soundfile.write(out, samples, rate)
        print(out, flush=True)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "setup":
        setup()
    elif command == "status":
        print(json.dumps({"ready": is_ready()}), flush=True)
    elif command == "synth":
        if not is_ready():
            raise SystemExit("not set up: run setup first")
        voice = sys.argv[2] if len(sys.argv) > 2 else "af_heart"
        speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
        synth(voice, speed)
    else:
        raise SystemExit(f"unknown command {command}")


if __name__ == "__main__":
    main()
