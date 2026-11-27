import { useLingui } from "@lingui/react/macro";
import { IconX } from "@tabler/icons-react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useIsMobile } from "@/hooks/use-mobile";
import { mountPageSnapshot } from "@/lib/page-snapshot";

/**
 * On phones, show a page as an iOS-style sheet: it slides up from the bottom with rounded top
 * corners and a round close button, can be pulled down to close, and slides back down when
 * closed (like the mobile app). On larger screens the page renders normally.
 */
export function MobileSheet({
  children,
  style,
  resetKey,
}: {
  children: ReactNode;
  style?: CSSProperties;
  /** When this changes (another title opened inside the sheet), scroll back to the top. */
  resetKey?: string;
}) {
  const isMobile = useIsMobile();
  if (!isMobile) return <>{children}</>;
  return createPortal(
    <Sheet style={style} resetKey={resetKey}>
      {children}
    </Sheet>,
    document.body,
  );
}

const CLOSE_DISTANCE = 140;
const CLOSE_SPEED = 900;

function Sheet({
  children,
  style,
  resetKey,
}: {
  children: ReactNode;
  style?: CSSProperties;
  resetKey?: string;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const reduceMotion = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const dragRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const behindRef = useRef<HTMLDivElement>(null);

  // Show the page you came from behind the sheet (a still copy; the real one returns on close)
  useEffect(() => {
    if (behindRef.current) mountPageSnapshot(behindRef.current);
  }, []);

  // The page behind the sheet shouldn't scroll while it's open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const leave = useCallback(() => {
    if (canGoBack) router.history.back();
    else void router.navigate({ to: "/dashboard" });
  }, [canGoBack, router]);

  const close = useCallback(() => {
    if (reduceMotion) leave();
    else setClosing(true);
  }, [reduceMotion, leave]);

  // Safety net: if the closing animation never finishes, still leave.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(leave, 600);
    return () => clearTimeout(timer);
  }, [closing, leave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]:not([data-mobile-sheet])")) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Pull down from the top of the sheet to close it (like iOS). Moves a wrapper with plain
  // transforms so it never fights the slide-up animation.
  useEffect(() => {
    const el = scrollRef.current;
    const wrapper = dragRef.current;
    if (!el || !wrapper) return;
    let startY = 0;
    let startTime = 0;
    let distance = 0;
    let dragging = false;

    const setOffset = (px: number, animated: boolean) => {
      wrapper.style.transition = animated ? "transform 0.3s cubic-bezier(0.32,0.72,0,1)" : "";
      wrapper.style.transform = px ? `translateY(${px}px)` : "";
      if (backdropRef.current) {
        backdropRef.current.style.opacity = String(Math.max(0, 1 - px / window.innerHeight));
      }
    };

    const onStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
      startTime = performance.now();
      distance = 0;
      dragging = false;
    };
    const onMove = (e: TouchEvent) => {
      const dy = (e.touches[0]?.clientY ?? 0) - startY;
      if (!dragging) {
        if (el.scrollTop > 0 || dy <= 6) return;
        dragging = true;
      }
      e.preventDefault();
      distance = Math.max(0, dy);
      setOffset(distance, false);
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      const speed = (distance / Math.max(1, performance.now() - startTime)) * 1000;
      if (distance > CLOSE_DISTANCE || speed > CLOSE_SPEED) close();
      else setOffset(0, true);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [close]);

  return (
    <div className={`fixed inset-0 z-50 ${closing ? "pointer-events-none" : ""}`} style={style}>
      <div ref={behindRef} aria-hidden={true} className="absolute inset-0 overflow-hidden" />
      <div ref={backdropRef} className="absolute inset-0">
        <motion.div
          aria-hidden={true}
          className="absolute inset-0 bg-black/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: closing ? 0 : 1 }}
          transition={{ duration: 0.25 }}
          onClick={close}
        />
      </div>
      <div
        ref={dragRef}
        className="absolute inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] bottom-0"
      >
        <motion.div
          ref={scrollRef}
          role="dialog"
          aria-modal={true}
          data-mobile-sheet=""
          className="bg-background h-full overflow-y-auto overscroll-contain rounded-t-[28px] shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
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
          {/* Grab handle + close button float over the content while scrolling */}
          <div className="pointer-events-none sticky top-0 z-30 h-0">
            <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-white/40" />
            <div className="absolute end-3 top-3">
              <button
                type="button"
                onClick={close}
                aria-label={t`Close`}
                className="pointer-events-auto flex size-11 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white shadow-lg backdrop-blur-md transition-transform active:scale-90"
              >
                <IconX aria-hidden={true} className="size-5" />
              </button>
            </div>
          </div>
          <div className="relative px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
            {children}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
