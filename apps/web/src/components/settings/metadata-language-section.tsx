import { Trans, useLingui } from "@lingui/react/macro";
import { IconWorld } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { orpc } from "@/lib/orpc/client";

type MetadataLanguage = "en-US" | "es-ES" | "es-MX";

/** Server-wide language for titles, overviews and episode names fetched from TMDB. */
export function MetadataLanguageSection() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const { data, isPending: isLoading } = useQuery(orpc.admin.settings.get.queryOptions());
  const { mutate, isPending } = useMutation(
    orpc.admin.settings.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.admin.settings.get.key() });
        toast.success(t`Metadata language saved`, {
          description: t`Your library is updating in the background; other titles update when opened.`,
        });
      },
      onError: () => toast.error(t`Failed to save the metadata language`),
    }),
  );

  if (isLoading) {
    return (
      <CardContent>
        <Skeleton className="h-12 w-full" />
      </CardContent>
    );
  }

  const current = data?.metadata.language ?? "en-US";
  const options: { value: MetadataLanguage; label: string }[] = [
    { value: "en-US", label: "English" },
    { value: "es-ES", label: t`Spanish (Spain)` },
    { value: "es-MX", label: t`Spanish (Latin America)` },
  ];

  return (
    <CardContent className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <IconWorld aria-hidden={true} className="text-primary size-4" />
        </div>
        <div>
          <CardTitle>
            <Trans>Metadata language</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>
              Language for titles, synopses and episode names. When a translation is missing, the
              closest one is used, then English. Applies to every user.
            </Trans>
          </CardDescription>
        </div>
      </div>
      <ToggleGroup
        value={[current]}
        onValueChange={(values) => {
          const next = values.find((v) => v !== current) as MetadataLanguage | undefined;
          if (next && !isPending) mutate({ metadata: { language: next } });
        }}
        variant="outline"
        size="sm"
        disabled={isPending}
        className="flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </CardContent>
  );
}
