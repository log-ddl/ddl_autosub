import * as React from "react"
import {
  BookOpen,
  Library,
  Plug,
  Upload,
} from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useTranslation } from "react-i18next"
import { BuiltinScriptsTab } from "@/components/autoedit/builtin-scripts-tab"
import { MyScriptsTab } from "@/components/autoedit/my-scripts-tab"
import { useScriptRunner } from "@/components/autoedit/use-script-runner"

function PlaceholderTab({
  icon,
  title,
  description,
  empty,
}: {
  icon: React.ReactNode
  title: string
  description: string
  empty: string
}) {
  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-xl border border-dashed bg-muted/30 p-10 flex flex-col items-center justify-center gap-3 text-center">
        <div className="size-12 rounded-lg bg-background flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    </div>
  )
}

// The "Scripts" workspace tab: the Python/Lua script tooling that used to live
// under AutoEdit. Rendered inside the shared WorkspaceShell (which owns the
// top window chrome), so this component provides only the inner sub-tabs.
export function ScriptsPanel() {
  const { t } = useTranslation()
  // Single shared runner: only one script can execute at a time regardless of
  // which tab launched it, so tab switches don't drop the log stream.
  const runner = useScriptRunner()

  return (
    <TooltipProvider>
      <Tabs defaultValue="mine" className="h-full flex flex-col">
        <div className="flex justify-center px-4 pt-4">
          <TabsList>
            <TabsTrigger value="mine" className="gap-1.5">
              <Upload className="size-4" />
              {t("modePicker.autoedit.tabs.mine", "My scripts")}
            </TabsTrigger>
            <TabsTrigger value="builtin" className="gap-1.5">
              <Library className="size-4" />
              {t("modePicker.autoedit.tabs.builtin")}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="gap-1.5">
              <Plug className="size-4" />
              {t("modePicker.autoedit.tabs.mcp")}
            </TabsTrigger>
            <TabsTrigger value="tutorial" className="gap-1.5">
              <BookOpen className="size-4" />
              {t("modePicker.autoedit.tabs.tutorial")}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-6 py-8">
          <TabsContent value="mine" className="mt-0">
            <MyScriptsTab runner={runner} />
          </TabsContent>
          <TabsContent value="builtin" className="mt-0">
            <BuiltinScriptsTab runner={runner} />
          </TabsContent>
          <TabsContent value="mcp" className="mt-0">
            <PlaceholderTab
              icon={<Plug className="size-6" />}
              title={t("modePicker.autoedit.mcp.title")}
              description={t("modePicker.autoedit.mcp.description")}
              empty={t("modePicker.autoedit.mcp.empty")}
            />
          </TabsContent>
          <TabsContent value="tutorial" className="mt-0">
            <PlaceholderTab
              icon={<BookOpen className="size-6" />}
              title={t("modePicker.autoedit.tutorial.title")}
              description={t("modePicker.autoedit.tutorial.description")}
              empty={t("modePicker.autoedit.tutorial.empty")}
            />
          </TabsContent>
        </div>
      </Tabs>
    </TooltipProvider>
  )
}
