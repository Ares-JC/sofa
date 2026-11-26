import { useLingui } from "@lingui/react/macro";
import { IconListNumbers, IconLoader } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/auth/client";
import { orpc } from "@/lib/orpc/client";

import { useTitleContext } from "./title-context";

const TMDB_ORDER = "tmdb";

/**
 * Choose how a show's seasons are arranged: TMDB's own seasons or one of TMDB's alternative
 * orderings (episode groups), e.g. split as on streaming services. Admin-only, since titles are
 * shared by every user; display only, so watches are kept.
 */
export function SeasonOrderMenu() {
  const { t } = useLingui();
  const { titleId, setSeasons } = useTitleContext();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const isAdmin = session?.user.role === "admin";
  const { data, isPending } = useQuery({
    ...orpc.titles.episodeOrders.queryOptions({ input: { id: titleId } }),
    enabled: isAdmin && open,
    staleTime: 5 * 60_000,
  });

  const { mutate, isPending: saving } = useMutation(
    orpc.titles.setEpisodeOrder.mutationOptions({
      onSuccess: async () => {
        const detailOptions = orpc.titles.get.queryOptions({ input: { id: titleId } });
        await queryClient.invalidateQueries({ queryKey: detailOptions.queryKey });
        const detail = await queryClient.fetchQuery(detailOptions);
        setSeasons(detail.seasons);
        await queryClient.invalidateQueries({
          queryKey: orpc.titles.episodeOrders.queryKey({ input: { id: titleId } }),
        });
        toast.success(t`Season order updated`);
      },
      onError: () => toast.error(t`Failed to change the season order`),
    }),
  );

  if (!isAdmin) return null;

  const current = data?.current?.id ?? TMDB_ORDER;
  const typeLabels: Record<number, string> = {
    1: t`Original air date`,
    2: t`Absolute`,
    3: t`DVD`,
    4: t`Digital`,
    5: t`Story arc`,
    6: t`Production`,
    7: t`TV`,
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground tracking-wider uppercase"
            disabled={saving}
          >
            {saving ? (
              <IconLoader aria-hidden={true} className="size-3.5 animate-spin" />
            ) : (
              <IconListNumbers aria-hidden={true} className="size-3.5" />
            )}
            {t`Season order`}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-w-80">
        <DropdownMenuLabel>{t`Arrange seasons as`}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs">
            <IconLoader aria-hidden={true} className="size-3.5 animate-spin" />
            {t`Loading…`}
          </div>
        ) : (
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(value) => {
              if (value === current) return;
              mutate({ id: titleId, groupId: value === TMDB_ORDER ? null : String(value) });
            }}
          >
            <DropdownMenuRadioItem value={TMDB_ORDER}>
              {t`TMDB seasons (default)`}
            </DropdownMenuRadioItem>
            {(data?.groups ?? []).map((group) => {
              const seasons = group.seasonCount;
              const episodes = group.episodeCount;
              const kind = typeLabels[group.type] ?? "";
              return (
                <DropdownMenuRadioItem key={group.id} value={group.id}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{group.name}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {kind ? `${kind} · ` : ""}
                      {t`${seasons} seasons · ${episodes} episodes`}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
            {data && data.groups.length === 0 && (
              <p className="text-muted-foreground px-2 py-1.5 text-xs">
                {t`TMDB has no other orderings for this show.`}
              </p>
            )}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
