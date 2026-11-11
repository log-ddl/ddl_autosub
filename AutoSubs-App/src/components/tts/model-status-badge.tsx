import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { TtsModelStatus } from "./types";

export function ModelStatusBadge({ status }: { status?: TtsModelStatus }) {
  const { t } = useTranslation();

  if (status?.status === "ready") {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
        {t("tts.status.ready")}
      </Badge>
    );
  }
  if (status?.status === "downloading") {
    return (
      <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-600 hover:bg-sky-500/15 dark:text-sky-400">
        {t("tts.status.downloading")}
      </Badge>
    );
  }
  if (status?.status === "error" || status?.status === "incompatible") {
    return <Badge variant="destructive">{t("tts.status.error")}</Badge>;
  }
  return <Badge variant="outline">{t("tts.status.notInstalled")}</Badge>;
}

