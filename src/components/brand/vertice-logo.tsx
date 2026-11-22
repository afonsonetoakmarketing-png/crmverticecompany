import Image from "next/image";
import { cn } from "@/lib/utils";

export const BRAND_NAME = "Vértice Company";
export const VERTICE_LOGO_FRONT =
  "/assets/aistudio/Logo_Vertice_Frente_sem_fundo__alta__0a684cf6.png";
export const VERTICE_LOGO_3D =
  "/assets/aistudio/Logo_Vertice_Azul-removebg-preview_d7125da8.png";

interface VerticeLogoProps {
  /**
   * `compact`: Front-facing transparent VC monogram for navigation & header bars.
   * `hero`: 3D angled transparent VC monogram for authentication & onboarding screens.
   */
  variant?: "compact" | "hero";
  className?: string;
  priority?: boolean;
}

/**
 * Adaptive brand mark for Vértice Company.
 *
 * The official VC monogram is deep metallic navy blue. On Light mode it sits
 * cleanly on a crisp bright badge; on Dark mode (`html[data-mode="dark"]`) a
 * subtle light pearl surface lifts the navy emblem with executive contrast
 * without relying on Tailwind's `.dark` class.
 */
export function VerticeLogo({
  variant = "compact",
  className,
  priority = false,
}: VerticeLogoProps) {
  const isHero = variant === "hero";
  const src = isHero ? VERTICE_LOGO_3D : VERTICE_LOGO_FRONT;
  const dimension = isHero ? 64 : 28;

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center border transition-colors",
        // Default (dark mode first-paint) + explicit data-mode overrides so
        // light/dark transitions are instant with zero hydration flash.
        "bg-slate-100/95 border-white/25",
        "[[data-mode=dark]_&]:bg-slate-100/95 [[data-mode=dark]_&]:border-white/25",
        "[[data-mode=light]_&]:bg-white [[data-mode=light]_&]:border-border/80",
        isHero
          ? "h-20 w-20 rounded-2xl p-2.5 shadow-sm [[data-mode=dark]_&]:shadow-[0_10px_28px_-10px_rgba(0,0,0,0.65)] [[data-mode=light]_&]:bg-slate-50/90"
          : "h-9 w-9 rounded-lg p-1.5 shadow-xs [[data-mode=dark]_&]:shadow-[0_1px_8px_rgba(0,0,0,0.35)]",
        className,
      )}
    >
      <Image
        src={src}
        alt={BRAND_NAME}
        width={dimension}
        height={dimension}
        priority={priority}
        referrerPolicy="no-referrer"
        className="h-full w-full object-contain select-none"
      />
    </div>
  );
}

interface VerticeBrandLockupProps {
  className?: string;
  showName?: boolean;
}

export function VerticeBrandLockup({
  className,
  showName = true,
}: VerticeBrandLockupProps) {
  return (
    <div className={cn("mb-2 flex flex-col items-center gap-2.5", className)}>
      <VerticeLogo variant="hero" priority />
      {showName && (
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {BRAND_NAME}
        </span>
      )}
    </div>
  );
}
