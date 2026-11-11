import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

const BAR_COUNT = 96;
const waveformCache = new Map<
  string,
  Promise<{ duration: number; peaks: number[] }>
>();

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function decodeWaveform(source: string) {
  const existing = waveformCache.get(source);
  if (existing) return existing;

  const pending = (async () => {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Audio request failed (${response.status})`);
    }
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(
        await response.arrayBuffer(),
      );
      const channel = buffer.getChannelData(0);
      const blockSize = Math.max(1, Math.floor(channel.length / BAR_COUNT));
      const rawPeaks = Array.from({ length: BAR_COUNT }, (_, index) => {
        const start = index * blockSize;
        const end = Math.min(channel.length, start + blockSize);
        let peak = 0;
        for (let sample = start; sample < end; sample += 1) {
          peak = Math.max(peak, Math.abs(channel[sample]));
        }
        return peak;
      });
      const maximum = Math.max(...rawPeaks, 0.001);
      return {
        duration: buffer.duration,
        peaks: rawPeaks.map((peak) => Math.max(0.08, peak / maximum)),
      };
    } finally {
      void context.close();
    }
  })().catch((err) => {
    waveformCache.delete(source);
    throw err;
  });

  waveformCache.set(source, pending);
  return pending;
}

export function AudioWaveformPlayer({ source }: { source: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [peaks, setPeaks] = useState<number[]>(() =>
    Array(BAR_COUNT).fill(0.08),
  );
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  const updateDuration = (value: number) => {
    if (Number.isFinite(value) && value > 0) setDuration(value);
  };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    void decodeWaveform(source)
      .then((waveform) => {
        if (!active) return;
        setPeaks(waveform.peaks);
        updateDuration(waveform.duration);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [shouldLoad, source]);

  const progress = duration > 0 ? currentTime / duration : 0;
  const viewBoxWidth = useMemo(() => peaks.length * 2, [peaks.length]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  };

  const seekToPosition = (clientX: number, timeline: SVGSVGElement) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const bounds = timeline.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - bounds.left) / bounds.width),
    );
    const targetTime = ratio * duration;
    setCurrentTime(targetTime);

    const applySeek = () => {
      audio.currentTime = targetTime;
    };
    if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
      audio.load();
    } else {
      applySeek();
    }
  };

  return (
    <div
      ref={containerRef}
      className="flex items-center gap-3 rounded-xl bg-muted/35 px-3 py-2"
    >
      <audio
        ref={audioRef}
        src={source}
        preload="metadata"
        muted={muted}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onLoadedMetadata={(event) =>
          updateDuration(event.currentTarget.duration)
        }
        onDurationChange={(event) =>
          updateDuration(event.currentTarget.duration)
        }
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void togglePlayback()}
        title={playing ? t("tts.history.pause") : t("tts.history.play")}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <svg
        role="slider"
        aria-label={t("tts.history.seek")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        viewBox={`0 0 ${viewBoxWidth} 32`}
        preserveAspectRatio="none"
        className="h-9 min-w-0 flex-1 cursor-pointer"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekToPosition(event.clientX, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            seekToPosition(event.clientX, event.currentTarget);
          }
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      >
        {peaks.map((peak, index) => {
          const height = Math.max(2, peak * 28);
          const played = index / peaks.length <= progress;
          return (
            <rect
              key={index}
              x={index * 2}
              y={(32 - height) / 2}
              width="1.25"
              height={height}
              rx="0.6"
              className={
                played ? "fill-primary" : "fill-muted-foreground/35"
              }
            />
          );
        })}
      </svg>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMuted((value) => !value)}
        title={muted ? t("tts.history.unmute") : t("tts.history.mute")}
      >
        {muted ? <VolumeX /> : <Volume2 />}
      </Button>
    </div>
  );
}

