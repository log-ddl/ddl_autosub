import argparse
import json
import os
import sys
import time
import traceback


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def download(repository, output):
    from huggingface_hub import snapshot_download

    os.makedirs(output, exist_ok=True)
    emit({"type": "progress", "stage": "download", "percent": 55, "message": "Đang tải model OmniVoice..."})
    snapshot_download(repo_id=repository, local_dir=output)
    emit({"type": "progress", "stage": "verify", "percent": 95, "message": "Đang kiểm tra model..."})


class OmniVoiceService:
    def __init__(self):
        self.model = None
        self.model_path = None
        self.backend = None

    def progress(self, job_id, stage, percent, message):
        emit({
            "type": "progress",
            "jobId": job_id,
            "stage": stage,
            "percent": percent,
            "message": message,
        })

    def load_model(self, model_path, job_id):
        if self.model is not None and self.model_path == model_path:
            return

        import torch
        from omnivoice import OmniVoice

        if torch.cuda.is_available():
            self.backend = "cuda"
            device = "cuda:0"
            dtype = torch.float16
        elif hasattr(torch, "xpu") and torch.xpu.is_available():
            self.backend = "xpu"
            device = "xpu"
            dtype = torch.float16
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            self.backend = "mps"
            device = "mps"
            dtype = torch.float16
        else:
            self.backend = "cpu"
            device = "cpu"
            dtype = torch.float32

        self.progress(job_id, "loading", 8, f"Đang nạp OmniVoice bằng {self.backend.upper()}...")
        self.model = OmniVoice.from_pretrained(
            model_path,
            device_map=device,
            dtype=dtype,
            load_asr=False,
        )
        self.model_path = model_path
        self.progress(job_id, "loading", 22, "Model đã được nạp và sẽ được giữ trong bộ nhớ.")

    def get_clone_prompt(self, request, job_id):
        from omnivoice import VoiceClonePrompt

        prompt_path = request.get("promptPath")
        if prompt_path and os.path.isfile(prompt_path):
            self.progress(job_id, "voice-prompt", 26, "Đang dùng hồ sơ giọng đã tối ưu...")
            return VoiceClonePrompt.load(prompt_path)

        self.progress(job_id, "voice-prompt", 25, "Đang phân tích audio tham chiếu...")
        prompt = self.model.create_voice_clone_prompt(
            ref_audio=request["referenceAudioPath"],
            ref_text=request["referenceText"],
        )
        if prompt_path:
            os.makedirs(os.path.dirname(prompt_path), exist_ok=True)
            prompt.save(prompt_path)
        return prompt

    def generate(self, request):
        import numpy as np
        import soundfile as sf

        job_id = request["jobId"]
        self.load_model(request["modelPath"], job_id)
        mode = request.get("mode", "clone")
        advanced = request.get("advancedSettings") or {}
        kwargs = {
            "text": request["text"],
            "language": request.get("language"),
            "speed": float(request.get("speed", 1.0)),
            "num_step": int(request.get("numStep", 24)),
            # English/Chinese normalization requires the much heavier optional
            # WeTextProcessing stack. Vietnamese can use the lightweight
            # num2words fallback bundled in our runtime.
            "normalize_text": request.get("language") not in (None, "en", "zh"),
            "audio_chunk_duration": float(advanced.get("audioChunkDuration", 30.0)),
            "audio_chunk_threshold": float(advanced.get("audioChunkThreshold", 35.0)),
            "guidance_scale": float(advanced.get("guidanceScale", 2.0)),
            "t_shift": float(advanced.get("tShift", 0.1)),
            "position_temperature": float(advanced.get("positionTemperature", 5.0)),
            "class_temperature": float(advanced.get("classTemperature", 0.0)),
            "layer_penalty_factor": float(advanced.get("layerPenaltyFactor", 5.0)),
            "denoise": bool(advanced.get("denoise", True)),
            "preprocess_prompt": bool(advanced.get("preprocessPrompt", True)),
            "postprocess_output": bool(advanced.get("postprocessOutput", True)),
            "pad_duration": float(advanced.get("padDuration", 0.1)),
            "fade_duration": float(advanced.get("fadeDuration", 0.1)),
        }

        if mode == "clone":
            kwargs["voice_clone_prompt"] = self.get_clone_prompt(request, job_id)
        elif mode == "design":
            kwargs["instruct"] = request["instruction"]

        self.progress(job_id, "generating", 32, "Đang tổng hợp giọng nói...")
        started = time.time()
        audios = self.model.generate(**kwargs)
        if not audios:
            raise RuntimeError("OmniVoice không trả về audio")

        audio = np.asarray(audios[0], dtype=np.float32)
        sample_rate = int(self.model.sampling_rate or 24000)
        self.progress(job_id, "saving", 92, "Đang lưu WAV...")
        sf.write(request["outputPath"], audio, sample_rate)
        emit({
            "type": "result",
            "jobId": job_id,
            "success": True,
            "outputPath": request["outputPath"],
            "sampleRate": sample_rate,
            "durationSec": float(len(audio) / sample_rate),
            "elapsedSec": time.time() - started,
            "backend": self.backend,
        })

    def handle(self, request):
        job_id = str(request.get("jobId", "unknown"))
        try:
            command = request.get("command")
            if command == "generate":
                self.generate(request)
            elif command == "unload":
                self.model = None
                self.model_path = None
                emit({"type": "result", "jobId": job_id, "success": True})
            else:
                raise ValueError(f"Lệnh worker không hợp lệ: {command}")
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({
                "type": "result",
                "jobId": job_id,
                "success": False,
                "error": str(error),
            })


def serve():
    service = OmniVoiceService()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            emit({"type": "result", "jobId": "unknown", "success": False, "error": str(error)})
            continue
        service.handle(request)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    download_parser = sub.add_parser("download")
    download_parser.add_argument("--repository", required=True)
    download_parser.add_argument("--output", required=True)
    sub.add_parser("serve")
    args = parser.parse_args()
    if args.command == "download":
        download(args.repository, args.output)
    else:
        serve()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "result", "success": False, "error": str(error)})
        raise
