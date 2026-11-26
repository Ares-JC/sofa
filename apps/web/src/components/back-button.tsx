import { useLingui } from "@lingui/react/macro";
import { IconArrowLeft } from "@tabler/icons-react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Go back to wherever the user came from (search, a list, another title). When the page was
 * opened directly (a link or a new tab), there is nothing to go back to, so go home instead.
 */
export function BackButton({ className }: { className?: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  return (
    <Button
      variant="outline"
      size="lg"
      onClick={() => {
        if (canGoBack) router.history.back();
        else void router.navigate({ to: "/dashboard" });
      }}
      className={cn(
        "border-border/60 bg-background/60 hover:border-primary/50 hover:bg-primary/15 hover:text-primary h-9 rounded-lg ps-3 pe-4 text-sm backdrop-blur-md transition-colors hover:shadow-[0_0_14px_-4px] hover:shadow-primary/50",
        className,
      )}
    >
      <IconArrowLeft aria-hidden={true} className="size-4" />
      {t`Back`}
    </Button>
  );
}
