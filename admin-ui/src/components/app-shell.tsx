import { NavLink, Outlet } from "react-router-dom"
import { MenuIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnimatedGradientText } from "@/components/ui/animated-gradient-text"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { LocaleToggle } from "@/components/locale-toggle"
import { MotionToggle } from "@/components/motion-toggle"
import { ThemeToggle } from "@/components/theme-toggle"
import { TokenDialog } from "@/components/token-dialog"
import { cn } from "@/lib/utils"

function NavItem({
  to,
  label,
}: {
  to: string
  label: string
}): React.JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "font-display relative text-[0.7rem] uppercase tracking-[0.22em] transition-colors",
          isActive
            ? "text-foreground after:absolute after:-bottom-2 after:left-0 after:h-[2px] after:w-full after:bg-accent after:shadow-[0_0_12px_var(--accent)] after:content-['']"
            : "text-muted-foreground hover:text-foreground"
        )
      }
    >
      {label}
    </NavLink>
  )
}

const NAV_ITEMS = [
  { to: "/accounts", labelKey: "nav.accounts" },
  { to: "/requests", labelKey: "nav.requests" },
  { to: "/models", labelKey: "nav.models" },
  { to: "/settings", labelKey: "nav.settings" },
] as const

function NavList(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <>
      {NAV_ITEMS.map((item) => (
        <NavItem key={item.to} to={item.to} label={t(item.labelKey)} />
      ))}
    </>
  )
}

export function AppShell(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="bg-background/80 sticky top-0 z-50 border-b border-border/70 backdrop-blur relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />
        <div className="flex w-full items-center gap-3 px-4 py-3 lg:px-6">
          <div className="md:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("nav.openNavigation")}>
                  <MenuIcon className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>
                    <AnimatedGradientText className="font-display text-sm uppercase tracking-[0.32em]">
                      {t("app.title")}
                    </AnimatedGradientText>
                  </SheetTitle>
                </SheetHeader>
                <nav className="mt-4 flex flex-col gap-3">
                  <NavList />
                </nav>
              </SheetContent>
            </Sheet>
          </div>

          <div className="min-w-0">
            <AnimatedGradientText className="font-display text-sm uppercase tracking-[0.32em]">
              {t("app.title")}
            </AnimatedGradientText>
          </div>

          <nav className="hidden items-center gap-5 md:flex">
            <NavList />
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <LocaleToggle />
            <MotionToggle />
            <ThemeToggle />
            <TokenDialog />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 lg:px-6 lg:py-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
        <Outlet />
      </main>
    </div>
  )
}
