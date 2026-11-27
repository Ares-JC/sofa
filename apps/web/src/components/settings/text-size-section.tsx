import { Trans, useLingui } from "@lingui/react/macro";
import { IconTextSize } from "@tabler/icons-react";
import { useState } from "react";

import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { getTextSize, setTextSize, TEXT_SIZES, type TextSize } from "@/lib/text-size";

/** Per-browser text size: scales the whole interface like a zoom, keeping its proportions. */
export function TextSizeSection() {
  const { t } = useLingui();
  const [current, setCurrent] = useState<TextSize>(getTextSize);

  const options: { value: TextSize; label: string }[] = [
    { value: "small", label: t`Small` },
    { value: "normal", label: t`Normal` },
    { value: "large", label: t`Large` },
    { value: "xlarge", label: t`Extra large` },
  ];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
            <IconTextSize aria-hidden={true} className="text-primary size-4" />
          </div>
          <div>
            <CardTitle>
              <Trans>Text size</Trans>
            </CardTitle>
            <CardDescription>
              <Trans>Makes everything bigger or smaller in this browser only.</Trans>
            </CardDescription>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
          {options.map((option) => {
            const selected = current === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setTextSize(option.value);
                  setCurrent(option.value);
                }}
                className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-colors ${
                  selected
                    ? "border-primary bg-primary/10 text-foreground shadow-primary/20 shadow-[0_0_16px_-6px]"
                    : "border-border hover:border-primary/40 hover:bg-primary/5 text-muted-foreground"
                }`}
              >
                <span
                  aria-hidden={true}
                  className="font-display leading-none"
                  // Preview the size in real pixels so it doesn't change with the setting itself
                  style={{ fontSize: `${TEXT_SIZES[option.value] * 1.35}px` }}
                >
                  Aa
                </span>
                <span className="text-sm font-medium">{option.label}</span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
