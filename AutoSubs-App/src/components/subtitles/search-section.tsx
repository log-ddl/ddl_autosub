import * as React from "react";
import {
  Repeat2,
  X,
  Search,
  CornerDownRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface SearchActionButtonProps {
  button: React.ReactNode;
  tooltip: string;
  useAddon?: boolean;
}

export function SearchActionButton({
  button,
  tooltip,
  useAddon = false,
}: SearchActionButtonProps) {
  const trigger = useAddon ? (
    <InputGroupAddon align="inline-end">{button}</InputGroupAddon>
  ) : (
    button
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export interface SearchSectionProps {
  headerClassName: string;
  t: (key: string) => string;
  searchQuery: string;
  replaceValue: string;
  searchCaseSensitive: boolean;
  searchWholeWord: boolean;
  showReplace: boolean;
  canReplace: boolean;
  searchInputRef: React.RefObject<HTMLInputElement>;
  onSearchQueryChange: (value: string) => void;
  onReplaceValueChange: (value: string) => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleReplace: () => void;
  onReplaceAll: () => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
}

export function SearchSection({
  headerClassName,
  t,
  searchQuery,
  replaceValue,
  searchCaseSensitive,
  searchWholeWord,
  showReplace,
  canReplace,
  searchInputRef,
  onSearchQueryChange,
  onReplaceValueChange,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleReplace,
  onReplaceAll,
  searchPlaceholder,
  searchAriaLabel,
}: SearchSectionProps) {
  const showClearButton = Boolean(searchQuery);
  const [isSearchFocused, setIsSearchFocused] = React.useState(false);

  // Case-sensitivity and whole-word only mean something once there is a query,
  // so they stay out of the resting state. Replace is deliberately excluded —
  // it opens find-and-replace rather than modifying the query, and this is its
  // only entry point, so hiding it would bury the feature.
  const showQueryModifiers =
    isSearchFocused || Boolean(searchQuery) || searchCaseSensitive || searchWholeWord;

  const searchActions = [
    showClearButton ? (
      <SearchActionButton
        key="clear"
        button={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => onSearchQueryChange("")}
          >
            <X className="size-4" />
          </Button>
        }
        tooltip={searchAriaLabel}
      />
    ) : null,
    showQueryModifiers ? (
    <SearchActionButton
      key="case-sensitive"
      button={
        <Button
          type="button"
          variant={searchCaseSensitive ? "default" : "ghost"}
          size="icon"
          className="size-7 text-xs rounded-full"
          onClick={onToggleCaseSensitive}
        >
          Aa
        </Button>
      }
      tooltip={t("subtitles.search.caseMatch")}
      useAddon
    />
    ) : null,
    showQueryModifiers ? (
    <SearchActionButton
      key="whole-word"
      button={
        <Button
          type="button"
          variant={searchWholeWord ? "default" : "ghost"}
          size="icon"
          className="size-7 text-xs rounded-full"
          onClick={onToggleWholeWord}
        >
          W
        </Button>
      }
      tooltip={t("subtitles.search.wholeWord")}
      useAddon
    />
    ) : null,
    <SearchActionButton
      key="replace-toggle"
      button={
        <Button
          type="button"
          variant={showReplace ? "default" : "ghost"}
          size="icon"
          className="size-7 rounded-full"
          onClick={onToggleReplace}
        >
          <Repeat2 className="size-4" />
        </Button>
      }
      tooltip={t("subtitles.search.replaceAll")}
      useAddon
    />,
  ].filter(Boolean);

  const searchInput = (
    <InputGroup
      className="rounded-xl overflow-hidden border-slate-200 dark:border-slate-800 bg-background/50"
      onFocus={() => setIsSearchFocused(true)}
      onBlur={(e) => {
        // Focus moving to one of the group's own buttons must not collapse it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsSearchFocused(false);
        }
      }}
    >
      <InputGroupAddon align="inline-start" className="text-muted-foreground pr-1">
        <Search className="size-4" />
      </InputGroupAddon>
      <InputGroupInput
        ref={searchInputRef}
        placeholder={searchPlaceholder}
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        aria-label={searchAriaLabel}
        className="text-sm px-2"
      />
      {searchActions}
    </InputGroup>
  );

  const replaceSection = (
    <div className="flex w-full items-center rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-background/50 focus-within:ring-1 focus-within:ring-ring">
      <div className="pl-3 text-muted-foreground flex items-center justify-center">
        <CornerDownRight className="size-4" />
      </div>
      <Input
        placeholder={t("subtitles.search.replaceWithPlaceholder")}
        value={replaceValue}
        onChange={(e) => onReplaceValueChange(e.target.value)}
        className="flex-1 text-sm pl-2 pr-3 border-0 bg-transparent shadow-none focus-visible:ring-0 rounded-none"
      />
      <Button
        type="button"
        variant="default"
        disabled={!canReplace}
        onClick={onReplaceAll}
        className="rounded-none px-4 bg-[#0a0a0b] hover:bg-[#0a0a0b]/90 text-white border-l border-slate-200 dark:border-slate-800"
      >
        {t("subtitles.search.replaceAll")}
      </Button>
    </div>
  );

  return (
    <div className={headerClassName}>
      <div className="flex flex-col gap-1.5">
        {searchInput}
        {showReplace && replaceSection}
      </div>
    </div>
  );
}
