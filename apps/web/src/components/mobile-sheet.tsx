import { useLingui } from "@lingui/react/macro";
import { IconX } from "@tabler/icons-react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useIsMobile } from "@/hooks/use-mobile";

/**
 * On phones, show a page as an iOS-style sheet: it slides up from the bottom with rounded top
 * corners and a round close button, and slides back down when closed (like the mobile app).
 * On larger screens the page renders normally.
 */
export function MobileSheet({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const isMobile = useIsMobile();
  if (!isMobile) return <>{children}</>;
  return createPortal(<Sheet style={style}>{children}</Sheet>, document.body);
}

function Sheet({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const { t } = useLingui();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const reduceMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);

  // The page behind the sheet shouldn't scroll while it's open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  function leave() {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/dashboard" });
  }

  function close() {
    if (reduceMotion) leave();
    else setClosing(true);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]:not([data-mobile-sheet])")) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 z-50" style={style}>
      <motion.div
        aria-hidden={true}
        className="absolute inset-0 bg-black/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: closing ? 0 : 1 }}
        transition={{ duration: 0.25 }}
        onClick={close}
      />
      <motion.div
        role="dialog"
        aria-modal={true}
        data-mobile-sheet=""
        className="bg-background absolute inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] bottom-0 overflow-y-auto overscroll-contain rounded-t-[28px] shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
        initial={reduceMotion ? false : { y: "100%" }}
        animate={{ y: closing ? "100%" : 0 }}
        transition={
          closing
            ? { duration: 0.28, ease: [0.32, 0.72, 0, 1] }
            : { type: "spring", damping: 34, stiffness: 320, mass: 0.9 }
        }
        onAnimationComplete={() => {
          if (closing) leave();
        }}
      >
        {/* Close button floats over the content while scrolling */}
        <div className="pointer-events-none sticky top-3 z-30 flex h-0 justify-end px-3">
          <button
            type="button"
            onClick={close}
            aria-label={t`Close`}
            className="pointer-events-auto flex size-11 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white shadow-lg backdrop-blur-md transition-transform active:scale-90"
          >
            <IconX aria-hidden={true} className="size-5" />
          </button>
        </div>
        <div className="relative px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
          {children}
        </div>
      </motion.div>
    </div>
  );
}
