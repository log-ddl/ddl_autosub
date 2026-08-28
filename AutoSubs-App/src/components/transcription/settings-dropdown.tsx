import * as React from "react";
import {
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Shapes,
  Sun,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/animated-tabs";
import { useTheme } from "@/components/providers/theme-provider";
import { SettingsDialog } from "@/components/dialogs/settings-dialog";
import { ManageModelsDialog } from "@/components/settings/model-manager";
import { useModels } from "@/contexts/ModelsContext";
import { alignerModel, diarizeModel } from "@/lib/models";
import type { Model } from "@/types";

export function SettingsDropdown() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { modelsState, downloadedModelValues, handleDeleteModel } = useModels();
  const [manageModelsOpen, setManageModelsOpen] = React.useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = React.useState(false);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const suppressTooltipUntilRef = React.useRef(0);

  const managerModels: Model[] = [
    ...modelsState,
    ...(downloadedModelValues.includes(diarizeModel.value)
      ? [{ ...diarizeModel, isDownloaded: true }]
      : []),
    ...(downloadedModelValues.includes(alignerModel.value)
      ? [{ ...alignerModel, isDownloaded: true }]
      : []),
  ];

  const handleThemeChange = (themeValue: string) => {
    setTheme(themeValue as "dark" | "light" | "system");
  };

  const suppressTooltip = React.useCallback(() => {
    suppressTooltipUntilRef.current = Date.now() + 700;
    setTooltipOpen(false);
  }, []);

  const handleDropdownOpenChange = (nextOpen: boolean) => {
    setDropdownOpen(nextOpen);
    suppressTooltip();
  };

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={handleDropdownOpenChange}>
        <Tooltip
          open={tooltipOpen}
          onOpenChange={(nextOpen) => {
            setTooltipOpen(
              nextOpen &&
                !dropdownOpen &&
                Date.now() > suppressTooltipUntilRef.current,
            );
          }}
        >
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("settings.title", "Settings")}
              >
                <SettingsIcon />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("settings.title", "Settings")}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          className="w-48 rounded-lg"
          side="bottom"
          align="end"
          sideOffset={4}
          onPointerDown={suppressTooltip}
          onClick={suppressTooltip}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => setSettingsDialogOpen(true)}
              className="cursor-pointer"
            >
              <SettingsIcon />
              <span>{t("settings.title", "Settings")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setManageModelsOpen(true)}
              className="cursor-pointer"
            >
              <Shapes />
              <span>{t("models.manage.title", "Manage Models")}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <div className="p-1">
            <Tabs value={theme} onValueChange={handleThemeChange}>
              <TabsList className="w-full">
                <TabsTrigger value="light">
                  <Sun />
                </TabsTrigger>
                <TabsTrigger value="dark">
                  <Moon />
                </TabsTrigger>
                <TabsTrigger value="system">
                  <Monitor />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <ManageModelsDialog
        open={manageModelsOpen}
        onOpenChange={setManageModelsOpen}
        models={managerModels}
        onDeleteModel={(modelValue) => void handleDeleteModel(modelValue)}
      />

      <SettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
      />

    </>
  );
}
