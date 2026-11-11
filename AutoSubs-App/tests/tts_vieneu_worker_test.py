"""Check VieNeu worker protocol without downloading model weights."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

worker_path = Path(__file__).resolve().parents[1] / 'src-tauri/resources/tts/vieneu_worker.py'
spec = importlib.util.spec_from_file_location('vieneu_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerProtocol(unittest.TestCase):
    def run_request(self, request):
        calls = []
        class Engine:
            def __init__(self, **kwargs):
                calls.append(('init', kwargs))
            def infer(self, text, **kwargs):
                calls.append(('infer', text, kwargs))
                print('library logging')
                return b'\0\0' * 480
            def save(self, audio, path):
                with wave.open(path, 'wb') as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(48000)
                    output.writeframes(audio)
        stdout = io.StringIO()
        with patch.dict(sys.modules, {'vieneu': types.SimpleNamespace(Vieneu=Engine)}), patch.object(sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(sys, 'stdout', stdout), patch.object(sys, 'stderr', io.StringIO()):
            worker.main()
        return json.loads(stdout.getvalue()), calls

    def test_preset_and_clone_route(self):
        with tempfile.TemporaryDirectory() as directory:
            for extra, expected in [({'voiceId': 'Mai Anh'}, {'voice': 'Mai Anh'}), ({'referenceAudioPath': '/reference.wav'}, {'ref_audio': '/reference.wav'})]:
                result, calls = self.run_request({'text': 'Xin chào', 'outputPath': str(Path(directory) / 'out.wav'), **extra})
                self.assertTrue(result['success'])
                self.assertEqual(result['sampleRate'], 48000)
                self.assertEqual(calls[0][1], {'mode': 'v3turbo', 'backend': 'onnx'})
                self.assertEqual(calls[1][2], expected)
    def test_install_initializes_model(self):
        result, calls = self.run_request({'install': True})
        self.assertEqual(result, {'success': True})
        self.assertEqual(len(calls), 1)

if __name__ == '__main__':
    unittest.main()
