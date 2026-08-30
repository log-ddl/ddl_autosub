import { getVersion } from "@tauri-apps/api/app"

import { useSettingsStore } from "@/stores/settings-store"
import { normalizeUiLanguage } from "@/i18n"
import { languages } from "@/lib/languages"
import { models, getFirstRecommendedModelForLanguage } from "@/lib/models"

/**
 * The setup a brand-new install needs, done silently.
 *
 * This used to be a welcome overlay that asked for a language before letting
 * anyone in. Everything it asked for is already known by the time it ran — the
 * store picks up the system language on first run and i18n is initialised from
 * it — so the questions are answered here instead of being put to the user, and
 * anything they disagree with is a dropdown away in the toolbar.
 *
 * Safe to call more than once: it is gated on `onboardingCompleted`, and the
 * last thing it does is set that flag.
 */
export async function completeFirstRun(): Promise<void> {
  const { updateSetting, uiLanguage } = useSettingsStore.getState()

  // Transcribe in the language the app is being used in, when that is one of
  // the supported transcription languages. Otherwise the default ("auto")
  // stands, which is the right answer for a language we can't infer.
  const guess = normalizeUiLanguage(uiLanguage)
  if (languages.some((lang) => lang.value === guess)) {
    updateSetting("language", guess)

    const recommended = getFirstRecommendedModelForLanguage(guess)
    if (recommended) {
      const index = models.findIndex((m) => m.value === recommended.value)
      if (index !== -1) updateSetting("model", index)
    }
  }

  // Mark this version as seen so a brand-new user isn't greeted by a "What's
  // New" popup about changes they have never not had.
  try {
    const version = await getVersion()
    if (version) updateSetting("lastSeenVersion", version)
  } catch {
    /* a missing version only costs one changelog popup */
  }

  updateSetting("onboardingCompleted", true)
}
