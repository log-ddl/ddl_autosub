import * as React from "react"
import { load, type Store } from "@tauri-apps/plugin-store"

// Persisted list of user-imported AutoEdit scripts, so a script picked once can
// be re-run later without browsing for the file again. Stored via the Tauri
// store plugin (same mechanism as caption presets).
export interface SavedScript {
  id: string
  name: string
  path: string
  addedAt: number
}

const STORE_FILE = "autoedit-scripts.json"
const STORE_KEY = "scripts"

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function useSavedScripts() {
  const [store, setStore] = React.useState<Store | null>(null)
  const [scripts, setScripts] = React.useState<SavedScript[]>([])
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await load(STORE_FILE, { autoSave: false })
        if (cancelled) return
        setStore(s)
        const existing = (await s.get<SavedScript[]>(STORE_KEY)) ?? []
        if (!cancelled) setScripts(existing)
      } catch (err) {
        console.error("Failed to load saved scripts:", err)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = React.useCallback(
    async (next: SavedScript[]) => {
      setScripts(next)
      if (!store) return
      await store.set(STORE_KEY, next)
      await store.save()
    },
    [store],
  )

  const addScript = React.useCallback(
    async (path: string, name?: string) => {
      // De-dupe by path: re-importing the same file just bumps it to the top.
      const filtered = scripts.filter((s) => s.path !== path)
      const entry: SavedScript = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name?.trim() || fileName(path),
        path,
        addedAt: Date.now(),
      }
      await persist([entry, ...filtered])
      return entry
    },
    [scripts, persist],
  )

  const removeScript = React.useCallback(
    async (id: string) => {
      await persist(scripts.filter((s) => s.id !== id))
    },
    [scripts, persist],
  )

  return { scripts, loaded, addScript, removeScript }
}
