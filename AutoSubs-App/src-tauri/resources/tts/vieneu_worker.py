"""Isolated VieNeu v3 Turbo CPU worker. One JSON request on stdin."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import sys
import wave


def _local_fetch(repo: str, files: list[str], subfolder: str | None = None) -> Path:
    """Download HF artifacts as real files in one directory (no sharded blob symlinks).

    huggingface_hub >= 1.x stores blobs under sharded `hub/blobs/<2-hex>/` folders
    and links them from `snapshots/`. onnxruntime >= 1.22 resolves `realpath(model.onnx)`
    as the sole allowed directory for external `.data` weights and rejects cross-shard
    symlinks with `External data path escapes model directory`. Using `local_dir` writes
    real files side-by-side (reusing any cached blobs first) and keeps offline runs
    completely network-free once materialized.
    """
    from huggingface_hub import hf_hub_download

    hf_home = Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface"))
    repo_root = hf_home / "local" / repo.replace("/", "--")
    target_dir = repo_root / subfolder if subfolder else repo_root
    target_dir.mkdir(parents=True, exist_ok=True)

    for fn in files:
        dest = target_dir / fn
        if dest.is_file() and not dest.is_symlink() and dest.stat().st_size > 0:
            continue
        if dest.is_symlink():
            dest.unlink()
        try:
            hf_hub_download(
                repo,
                fn,
                repo_type="model",
                subfolder=subfolder or None,
                local_dir=str(repo_root),
            )
        except Exception:
            if fn.endswith(".json"):
                continue
            raise
    return target_dir


def _load_engine():
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine import onnx_runtime_lite as ort_lite

    ort_lite.OnnxV3LiteEngine._fetch = staticmethod(_local_fetch)
    v3_repo = getattr(ort_lite, "_V3_REPO", "pnnbao-ump/VieNeu-TTS-v3-Turbo")
    graph_files = list(getattr(ort_lite, "_GRAPH_FILES", []))
    backbone_dir = _local_fetch(
        v3_repo,
        ["config.json", "denoiser.onnx", "speaker_encoder.onnx"],
    )
    onnx_dir = _local_fetch(v3_repo, graph_files, "onnx_update")
    return Vieneu(
        mode="v3turbo",
        backend="onnx",
        backbone_repo=str(backbone_dir),
        onnx_dir=str(onnx_dir),
    )


def main():
    request = json.load(sys.stdin)
    # Model/library logs must not corrupt the result protocol.
    with contextlib.redirect_stdout(sys.stderr):
        engine = _load_engine()
        if request.get("install"):
            hf_home = Path(os.environ.get("HF_HOME") or "")
            if hf_home.is_dir():
                shutil.rmtree(hf_home / "hub", ignore_errors=True)
                shutil.rmtree(hf_home / "xet", ignore_errors=True)
            result = {"success": True}
        else:
            kwargs = {"ref_audio": request["referenceAudioPath"]} if request.get("referenceAudioPath") else {"voice": request["voiceId"]}
            audio = engine.infer(request["text"], **kwargs)
            engine.save(audio, request["outputPath"])
            with wave.open(request["outputPath"], "rb") as wav:
                result = {"success": True, "outputPath": request["outputPath"], "sampleRate": wav.getframerate(), "durationSec": wav.getnframes() / wav.getframerate()}
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}))
        sys.exit(1)
