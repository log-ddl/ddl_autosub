import { Mars, UserRound, Venus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TtsProvider } from "./types";
import type { TtsController } from "./use-tts-controller";

export const TTS_PROVIDERS: [TtsProvider, string][] = [
  ["omnivoice", "OmniVoice"],
  ["capcut", "CapCut"],
  ["vieneu", "VieNeu"],
  ["elevenlabs", "ElevenLabs"],
  ["sonicvoice", "SonicVoice"],
];

export function GenderIcon({ gender }: { gender?: string }) {
  const { t } = useTranslation();
  const Icon =
    gender === "male" ? Mars : gender === "female" ? Venus : UserRound;
  const label = t(
    `tts.provider.${gender === "male" || gender === "female" ? gender : "unknownGender"}`,
  );
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-4" />
    </span>
  );
}

export function ProviderSelector({
  controller: c,
}: {
  controller: TtsController;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <Label>{t("tts.provider.title")}</Label>
      <Select
        value={c.provider}
        disabled={c.busy}
        onValueChange={(v) => c.setProvider(v as TtsProvider)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TTS_PROVIDERS.map(([id, name]) => (
            <SelectItem key={id} value={id}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
