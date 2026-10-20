import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listLoginSites, signInToSite, type SiteLogin } from "@/api/media-download-api"

/**
 * Corner menu to sign in to a site before downloading from it. Instagram and
 * Vimeo want an account for almost everything; the others mostly work as a
 * visitor, and a failed download offers the same sign-in from its error.
 */
export function DownloadAccountsMenu() {
  const { t } = useTranslation()
  const [sites, setSites] = React.useState<SiteLogin[]>([])

  React.useEffect(() => {
    void listLoginSites().then(setSites).catch(() => setSites([]))
  }, [])

  if (sites.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label={t("download.accounts.title", "Accounts")}
        >
          <UserRound className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("download.accounts.hint", "Sign in for posts that need an account.")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sites.map((site) => (
          <DropdownMenuItem
            key={site.key}
            onSelect={() =>
              void signInToSite(site.key).catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            {t("download.signIn", "Sign in to {{site}}", { site: site.name })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
