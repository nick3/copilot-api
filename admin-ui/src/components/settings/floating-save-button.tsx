import { useTranslation } from "react-i18next"

import { RainbowButton } from "@/components/ui/rainbow-button"
import { cn } from "@/lib/utils"

export type FloatingSaveButtonProps = {
  saving: boolean
  canSave: boolean
  onSave: () => void
  className?: string
}

/**
 * Fixed position save button in the bottom right corner.
 * Uses RainbowButton for visual emphasis.
 */
export function FloatingSaveButton({
  saving,
  canSave,
  onSave,
  className,
}: FloatingSaveButtonProps) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        "fixed bottom-6 right-6 z-50 relative",
        "rounded-sm shadow-[0_22px_45px_-30px_rgba(0,0,0,0.7)]",
        "before:absolute before:-inset-1 before:border before:border-accent/40 before:content-['']",
        className
      )}
    >
      <RainbowButton
        type="button"
        size="lg"
        onClick={onSave}
        disabled={!canSave}
        className="min-w-[200px]"
      >
        {saving
          ? t("settingsPage.saveButton.saving")
          : t("settingsPage.saveButton.saveChanges")}
      </RainbowButton>
    </div>
  )
}
