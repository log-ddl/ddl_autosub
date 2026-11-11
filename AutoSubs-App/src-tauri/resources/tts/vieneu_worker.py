"""Isolated VieNeu v3 Turbo CPU worker. One JSON request on stdin."""
import contextlib
import json
import sys
import wave


def main():
    request = json.load(sys.stdin)
    # Model/library logs must not corrupt the result protocol.
    with contextlib.redirect_stdout(sys.stderr):
        from vieneu import Vieneu
        engine = Vieneu(mode="v3turbo", backend="onnx")
        if request.get("install"):
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
