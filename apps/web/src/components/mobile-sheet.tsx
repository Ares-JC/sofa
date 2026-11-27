import { useLingui } from "@lingui/react/macro";
import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { TitleDetailContent } from "@/components/titles/title-detail-content";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { orpc } from "@/lib/orpc/client";
import { getTitleSheetId, setTitleSheetId, subscribeTitleSheet } from "@/lib/title-sheet";

/** Renders the phone title sheet while one is open. Mount once in the layout. */
export function TitleSheetHost() {
  const isMobile = useIsMobile();
  const id = useSyncExternalStore(subscribeTitleSheet, getTitleSheetId, () => null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Leaving the page (a link inside the sheet, the browser's back gesture…) closes it
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current !== pathname) {
      lastPathname.current = pathname;
      setTitleSheetId(null);
    }
  }, [pathname]);

  if (!isMobile || !id) return null;
  return createPortal(
    <SheetErrorBoundary id={id}>
      <TitleSheet id={id} />
    </SheetErrorBoundary>,
    document.body,
  );
}

const OPEN_SPRING = { type: "spring", damping: 34, stiffness: 320, mass: 0.9 } as const;
const CLOSE_TWEEN = { duration: 0.28, ease: [0.32, 0.72, 0, 1] } as const;

function TitleSheet({ id }: { id: string }) {
  const { t } = useLingui();
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  const offscreen = typeof window === "undefined" ? 900 : window.innerHeight;
  const y = useMotionValue(reduceMotion ? 0 : offscreen);
  // The page behind shows through more as the sheet is pulled down
  const backdropOpacity = useTransform(y, [0, offscreen], [1, 0]);

  const { data, isError } = useQuery(orpc.titles.get.queryOptions({ input: { id } }));

  useEffect(() => {
    if (!reduceMotion) void animate(y, 0, OPEN_SPRING);
  }, [y, reduceMotion]);

  // Another title opened from inside the sheet: start at its top
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [id]);

  // Keep the page behind from scrolling while the sheet is open
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const leave = useCallback(() => setTitleSheetId(null), []);

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    if (reduceMotion) leave();
    else void animate(y, offscreen, CLOSE_TWEEN).then(leave);
  }, [closing, reduceMotion, leave, y, offscreen]);

  // Pull down from the top of the sheet to close it (like iOS)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startY = 0;
    let startTime = 0;
    let distance = 0;
    let dragging = false;

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
      y.set(distance);
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      const speed = (distance / Math.max(1, performance.now() - startTime)) * 1000;
      if (distance > 140 || speed > 900) close();
      else void animate(y, 0, { type: "spring", damping: 30, stiffness: 380 });
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
  }, [y, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]:not([data-title-sheet])")) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    // While closing, let taps reach the page behind right away
    <div className={`fixed inset-0 z-50 ${closing ? "pointer-events-none" : ""}`}>
      <motion.div
        aria-hidden={true}
        className="absolute inset-0 bg-black/55"
        style={{ opacity: backdropOpacity }}
        onClick={close}
      />
      <motion.div
        ref={scrollRef}
        role="dialog"
        aria-modal={true}
        data-title-sheet=""
        style={{ y }}
        className="bg-background absolute inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] bottom-0 overflow-y-auto overscroll-contain rounded-t-[28px] shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
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
        <SheetBody>
          {data ? (
            <TitleDetailContent data={data} shortcuts={false} />
          ) : isError ? (
            <p className="text-muted-foreground py-24 text-center text-sm">
              {t`Something went wrong while loading this title. Please try again.`}
            </p>
          ) : (
            <SheetSkeleton />
          )}
        </SheetBody>
      </motion.div>
    </div>
  );
}

function SheetBody({ children }: { children: ReactNode }) {
  return (
    <div className="relative px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
}

function SheetSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="-mt-6 mr-[calc(-50vw+50%)] ml-[calc(-50vw+50%)] h-80 rounded-none" />
      <div className="-mt-36 flex items-end gap-4 px-0">
        <Skeleton className="aspect-[2/3] w-[112px] shrink-0 rounded-xl" />
        <div className="flex-1 space-y-2 pb-1">
          <Skeleton className="h-7 w-4/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-10 w-32 rounded-lg" />
        <Skeleton className="h-10 w-40 rounded-lg" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

/** If the sheet ever fails to render, open the regular title page instead of breaking the app. */
class SheetErrorBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    const { id } = this.props;
    setTitleSheetId(null);
    window.location.assign(`/titles/${encodeURIComponent(id)}`);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
