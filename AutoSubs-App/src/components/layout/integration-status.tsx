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
  const activeProject =
    activeIntegration.connected &&
    activeIntegration.projectName &&
    activeIntegration.projectName !== activeIntegration.timelineName
      ? activeIntegration.projectName
      : null;

  return (
    <div className="flex items-center gap-1 select-none z-20 min-w-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="flex items-center gap-2 h-8 rounded-xl border border-border/60 bg-card/70 hover:bg-accent/80 text-xs px-2.5 min-w-0 shadow-2xs !outline-none !ring-0 focus:!outline-none focus:!ring-0 focus-visible:!outline-none focus-visible:!ring-0"
          >
            <span className="relative shrink-0">
              <img
                src={activeIntegration.logo}
                alt={activeIntegration.productName}
                className="size-4 rounded-[4px]"
              />
              <span
                aria-hidden="true"
                className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card ${
                  activeIntegration.connected
                    ? "bg-emerald-500"
                    : "bg-muted-foreground/50"
                }`}
              />
            </span>
            <span
              className={`truncate max-w-[200px] min-w-0 ${
                !activeIntegration.connected ? "text-muted-foreground" : "text-foreground"
              }`}
              title={activeProject ? `${activeProject} · ${activeLabel}` : activeLabel}
            >
              {activeProject && (
                <>
                  <span className="font-semibold">{activeProject}</span>
                  <span className="text-muted-foreground"> · </span>
                </>
              )}
              <span className={activeProject ? "text-muted-foreground font-medium" : "font-medium"}>
                {activeLabel}
              </span>
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground/70 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 z-50">
          <div className="px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <img
                  src={activeIntegration.logo}
                  alt={activeIntegration.productName}
                  className="size-5 rounded-[5px]"
                />
                <h3 className="text-sm font-semibold">
                  {activeIntegration.productName}
                </h3>
              </div>
              <Badge
                variant="outline"
                className={
                  activeIntegration.connected
                    ? "font-medium border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "font-medium border-border bg-muted/60 text-muted-foreground"
                }
              >
                {activeIntegration.connected
                  ? activeIntegration.connectedText
                  : activeIntegration.disconnectedText}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {activeIntegration.helperText}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              void activeIntegration.refresh();
            }}
            className="cursor-pointer font-medium"
          >
            <RotateCcw className="size-4 text-muted-foreground" />
            <span>{t("common.refresh", "Refresh connection")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
