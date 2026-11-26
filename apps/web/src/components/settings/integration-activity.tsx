import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronDown } from "@tabler/icons-react";
import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { formatRelativeTime } from "@sofa/i18n/format";

import type { IntegrationConnection } from "./integration-card";

type Account = { id: string; name: string };

/**
 * Pick which media server accounts get logged. Accounts come from received events, so the list
 * fills itself as people play things; nothing picked means everyone on the server is logged.
 */
export function AccountFilter({
  label,
  connection,
  saving,
  onChange,
}: {
  label: string;
  connection: IntegrationConnection;
  saving: boolean;
  onChange: (accounts: Account[] | null) => void;
}) {
  const allowed = connection.allowedAccounts ?? [];
  const allowedIds = new Set(allowed.map((a) => a.id));

  // Seen accounts first (most recent), then any picked account that hasn't played lately.
  const accounts: Account[] = [
    ...connection.seenAccounts.map((a) => ({
      id: a.id,
      name: allowed.find((p) => p.id === a.id)?.name ?? a.name,
    })),
    ...allowed.filter((a) => !connection.seenAccounts.some((s) => s.id === a.id)),
  ];

  function toggle(account: Account, checked: boolean) {
    const next = checked ? [...allowed, account] : allowed.filter((a) => a.id !== account.id);
    onChange(next.length > 0 ? next : null);
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-muted-foreground mb-1 text-sm font-medium">
        <Trans>Whose watches to log</Trans>
      </legend>

      {accounts.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          <Trans>
            Finish watching something on {label} and its accounts will show up here to choose
            from.
          </Trans>
        </p>
      ) : (
        <ul className="space-y-1.5">
          {accounts.map((account) => {
            const id = `${connection.provider}-account-${account.id}`;
            return (
              <li key={account.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={allowedIds.has(account.id)}
                  disabled={saving}
                  onCheckedChange={(checked) => toggle(account, checked === true)}
                />
                <Label htmlFor={id} className="text-sm font-normal">
                  {account.name}
                </Label>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-muted-foreground text-xs">
        {allowed.length > 0 ? (
          <Trans>Only the checked accounts are logged. Uncheck all to log everyone.</Trans>
        ) : connection.serverUsername ? (
          <Trans>
            Only logging the user named “{connection.serverUsername}”. It switches to their account
            automatically the next time they finish something.
          </Trans>
        ) : (
          <Trans>Logging everyone on the server. Check accounts to only log theirs.</Trans>
        )}
      </p>
    </fieldset>
  );
}

const STATUS_STYLES: Record<IntegrationConnection["recentEvents"][number]["status"], string> = {
  success: "bg-green-500",
  ignored: "bg-amber-400",
  error: "bg-red-500",
};

/** The last events received from the media server, with why each was ignored or failed. */
export function RecentActivity({ connection }: { connection: IntegrationConnection }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const events = connection.recentEvents;

  function statusLabel(status: IntegrationConnection["recentEvents"][number]["status"]) {
    if (status === "success") return t`Logged`;
    if (status === "ignored") return t`Ignored`;
    return t`Error`;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md py-1 text-xs transition-colors">
        <IconChevronDown
          aria-hidden={true}
          className={`size-3 transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
        />
        <Trans>Recent activity</Trans>
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        {events.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            <Trans>Nothing received yet.</Trans>
          </p>
        ) : (
          <ul className="border-border/50 bg-muted/30 divide-border/40 mt-2 divide-y rounded-lg border text-xs">
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-2.5 px-3 py-2">
                <span
                  aria-hidden={true}
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${STATUS_STYLES[event.status]}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate">
                    {event.mediaTitle ?? (
                      <span className="text-muted-foreground italic">
                        <Trans>Hidden (another user)</Trans>
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    {statusLabel(event.status)}
                    {event.errorMessage ? ` · ${event.errorMessage}` : ""}
                    {event.accountName ? ` · ${event.accountName}` : ""}
                  </p>
                </div>
                <time
                  dateTime={event.receivedAt}
                  className="text-muted-foreground shrink-0 tabular-nums"
                >
                  {formatRelativeTime(event.receivedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
