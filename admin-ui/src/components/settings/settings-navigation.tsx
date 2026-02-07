import { useTranslation } from "react-i18next"

import type { SettingsSection } from "@/hooks/use-active-section"
import { cn } from "@/lib/utils"

export type SettingsNavigationProps = {
  sections: Array<SettingsSection>
  activeSection: string
  onSectionClick: (id: string) => void
  className?: string
}

/**
 * Sticky sidebar navigation for settings page.
 */
export function SettingsNavigation({
  sections,
  activeSection,
  onSectionClick,
  className,
}: SettingsNavigationProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <nav
      className={cn(
        "sticky top-6 space-y-2 rounded-sm border border-border/70 bg-card/75 p-3 shadow-[0_18px_40px_-32px_rgba(0,0,0,0.6)] backdrop-blur-sm",
        className,
      )}
      aria-label={t("settingsPage.navigation.ariaLabel")}
    >
      <div className="font-display px-2 py-2 text-[0.65rem] uppercase tracking-[0.24em] text-muted-foreground">
        {t("nav.settings")}
      </div>
      {sections.map((section) => {
        const isActive = activeSection === section.id
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSectionClick(section.id)}
            className={cn(
              "relative w-full text-left px-3 py-2 rounded-sm text-[0.72rem] font-semibold uppercase tracking-[0.2em] transition-colors border border-transparent",
              "hover:bg-accent/10 hover:border-border/60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              isActive &&
                "bg-accent/18 border-accent/70 text-foreground shadow-[0_0_0_1px_var(--accent)] before:absolute before:inset-y-1 before:left-1 before:w-1 before:bg-accent before:content-['']",
            )}
            aria-current={isActive ? "page" : undefined}
            aria-controls={section.id}
          >
            <span className={isActive ? "text-foreground" : "text-muted-foreground"}>
              {section.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
