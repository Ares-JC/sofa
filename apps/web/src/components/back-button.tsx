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
      variant="ghost"
      size="sm"
      onClick={() => {
        if (canGoBack) router.history.back();
        else void router.navigate({ to: "/dashboard" });
      }}
      className={cn(
        "bg-background/60 hover:bg-background/80 rounded-full ps-2.5 pe-3.5 backdrop-blur-md",
        className,
      )}
    >
      <IconArrowLeft aria-hidden={true} className="size-4" />
      {t`Back`}
    </Button>
  );
}
