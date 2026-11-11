import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createTtsJobId, ttsClient } from "./tts-client";
import type { TtsBatchItem, TtsGenerateResult } from "./types";

const MAX_CONSECUTIVE_FAILURES = 3;

interface UseTtsBatchOptions {
  validate: () => string | null;
  runGeneration: (jobId: string, text: string) => Promise<TtsGenerateResult>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function useTtsBatch({ validate, runGeneration }: UseTtsBatchOptions) {
  const { t } = useTranslation();
  const [folderPath, setFolderPath] = useState<string>();
  const [items, setItems] = useState<TtsBatchItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const counts = useMemo(
    () => ({
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      done: items.filter((item) => item.status === "done").length,
      error: items.filter((item) => item.status === "error").length,
    }),
    [items],
  );

  const updateItem = useCallback(
    (path: string, updates: Partial<TtsBatchItem>) => {
      setItems((current) =>
        current.map((item) =>
          item.path === path ? { ...item, ...updates } : item,
        ),
      );
    },
    [],
  );

  const scanFolder = useCallback(
    async (target: string) => {
      setScanning(true);
      try {
        const result = await ttsClient.scanBatchFolder(target);
        if (!result.success) {
          toast.error(result.error || t("tts.batch.scanFailed"));
          setItems([]);
          setTruncated(false);
          return;
        }
        setTruncated(result.truncated);
        setItems(
          result.files.map((file) => ({
            path: file.path,
            name: file.name,
            chars: file.chars,
            status: file.existingAudioPath ? "skipped" : "pending",
            outputPath: file.existingAudioPath,
          })),
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("tts.batch.scanFailed"),
        );
      } finally {
        setScanning(false);
      }
    },
    [t],
  );

  const pickFolder = useCallback(async () => {
    try {
      const picked = await ttsClient.pickBatchFolder(
        t("tts.batch.pickFolderTitle"),
      );
      if (!picked.path) return;
      setFolderPath(picked.path);
      await scanFolder(picked.path);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("tts.batch.scanFailed"),
      );
    }
  }, [scanFolder, t]);

  const rescan = useCallback(async () => {
    if (!folderPath || running) return;
    await scanFolder(folderPath);
  }, [folderPath, running, scanFolder]);

  const clearFolder = useCallback(() => {
    if (running) return;
    setFolderPath(undefined);
    setItems([]);
    setTruncated(false);
  }, [running]);

  const openFolder = useCallback(async () => {
    if (!folderPath) return;
    try {
      const result = await ttsClient.openBatchFolder(folderPath);
      if (!result.success) {
        toast.error(result.error || t("tts.batch.scanFailed"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("tts.batch.scanFailed"),
      );
    }
  }, [folderPath, t]);

  const requestStop = useCallback(() => {
    stopRef.current = true;
  }, []);

  const start = useCallback(async () => {
    if (running) return;
    const invalid = validate();
    if (invalid) {
      toast.error(invalid);
      return;
    }
    const queue = items.filter(
      (item) => item.status === "pending" || item.status === "error",
    );
    if (!queue.length) {
      toast.info(t("tts.batch.nothingToDo"));
      return;
    }

    stopRef.current = false;
    setRunning(true);
    let done = 0;
    let failed = 0;
    let consecutiveFailures = 0;

    const fail = (path: string, message: string) => {
      updateItem(path, { status: "error", error: message });
      failed += 1;
      consecutiveFailures += 1;
    };

    try {
      for (const entry of queue) {
        if (stopRef.current) break;
        updateItem(entry.path, { status: "running", error: undefined });

        const file = await ttsClient.readBatchText(entry.path);
        if (!file.text?.trim()) {
          updateItem(entry.path, {
            status: "error",
            error: file.error || t("tts.batch.emptyFile"),
          });
          failed += 1;
          continue;
        }

        const jobId = createTtsJobId("generate");
        let result: TtsGenerateResult;
        try {
          result = await runGeneration(jobId, file.text.trim());
        } catch (error) {
          result = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        if (result.canceled || (stopRef.current && !result.success)) {
          updateItem(entry.path, { status: "pending", error: undefined });
          stopRef.current = true;
          break;
        }
        if (!result.success || !result.outputPath) {
          fail(entry.path, result.error || t("tts.toast.generateFailed"));
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          continue;
        }

        const saved = await ttsClient.saveBatchOutput(
          result.outputPath,
          entry.path,
        );
        if (!saved.success) {
          fail(entry.path, saved.error || t("tts.batch.saveFailed"));
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          continue;
        }

        updateItem(entry.path, {
          status: "done",
          outputPath: saved.outputPath,
          error: undefined,
        });
        done += 1;
        consecutiveFailures = 0;
        if (!stopRef.current) await delay(300);
      }
    } finally {
      setRunning(false);
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      toast.error(t("tts.batch.stoppedAfterErrors", { done, failed }));
    } else if (stopRef.current) {
      toast.info(t("tts.batch.stopped", { done, failed }));
    } else if (failed > 0) {
      toast.warning(t("tts.batch.finished", { done, failed }));
    } else {
      toast.success(t("tts.batch.finished", { done, failed }));
    }
    stopRef.current = false;
  }, [items, running, runGeneration, t, updateItem, validate]);

  return {
    folderPath,
    items,
    counts,
    truncated,
    scanning,
    running,
    pickFolder,
    rescan,
    clearFolder,
    openFolder,
    start,
    requestStop,
  };
}

export type TtsBatchController = ReturnType<typeof useTtsBatch>;

