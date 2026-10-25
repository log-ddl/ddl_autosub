import { ChevronDown, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAdobe } from "@/contexts/AdobeContext";

export function IntegrationStatus() {
  const { t } = useTranslation();
  const { timelineInfo, isConnected, refresh } = useAdobe();

  const activeIntegration = {
    productName: t("titlebar.premiere.productName"),
    logo: "/premiere-logo.png",
    connected: isConnected,
    timelineName: timelineInfo?.name,
    projectName: timelineInfo?.projectName,
    connectedText: t("titlebar.premiere.tooltip.connected"),
    disconnectedText: t("titlebar.premiere.tooltip.disconnected"),
    helperText: isConnected
      ? t("titlebar.premiere.tooltip.canGetAudio")
      : t("titlebar.premiere.tooltip.openPremiere"),
    refresh,
  };

  const activeLabel = activeIntegration.connected
    ? activeIntegration.timelineName || activeIntegration.connectedText
    : t("titlebar.status.disconnected");
  // Project first, then the sequence inside it: two projects can both have a
  // "Sequence 01".
  const activeProject =
    activeIntegration.connected &&
    activeIntegration.projectName &&
    activeIntegration.projectName !== activeIntegration.timelineName
      ? activeIntegration.projectName
      : null;

  return (
    <div
      className="flex items-center gap-1 select-none z-20 min-w-0"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={`flex items-center gap-1.5 h-7 text-xs px-1.5 min-w-0 !outline-none !ring-0 focus:!outline-none focus:!ring-0 focus-visible:!outline-none focus-visible:!ring-0 ${
              activeIntegration.connected
                ? "hover:bg-green-100 hover:text-green-700 dark:hover:bg-green-900 dark:hover:text-green-300"
                : "hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            }`}
          >
            <span className="relative shrink-0">
              <img
                src={activeIntegration.logo}
                alt={activeIntegration.productName}
                className="size-5 rounded-sm"
              />
              <span
                aria-hidden="true"
                className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background ${
                  activeIntegration.connected ? "bg-green-500" : "bg-red-500"
                }`}
              />
            </span>
            <span
              className={`truncate min-w-0 ${!activeIntegration.connected ? "text-gray-600 dark:text-gray-400" : ""}`}
              title={activeProject ? `${activeProject} · ${activeLabel}` : activeLabel}
            >
              {activeProject && (
                <>
                  <span className="font-medium">{activeProject}</span>
                  <span className="text-muted-foreground"> · </span>
                </>
              )}
              <span className={activeProject ? "text-muted-foreground" : ""}>
                {activeLabel}
              </span>
            </span>
            <ChevronDown className="size-3 opacity-50 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 z-50">
          <div className="px-2.5 py-2">
            <div>
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold">
                  {activeIntegration.productName}
                </h3>
                <Badge
                  variant="outline"
                  className={
                    activeIntegration.connected
                      ? "font-normal border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
                      : "font-normal border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                  }
                >
                  {activeIntegration.connected
                    ? activeIntegration.connectedText
                    : activeIntegration.disconnectedText}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {activeIntegration.helperText}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              void activeIntegration.refresh();
            }}
            className="cursor-pointer"
          >
            <RotateCcw className="size-4" />
            <span>{t("common.refresh", "Refresh connection")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
