import { BackButton } from "@/components/back-button";
import { getThemeCssProperties } from "@/lib/theme";
import type { AvailabilityOffer, CastMember, ResolvedTitle, Season } from "@sofa/api/schemas";

import { TitleActions } from "./title-actions";
import { TitleAvailability } from "./title-availability";
import { TitleCast } from "./title-cast";
import { TitleHero } from "./title-hero";
import { TitleKeyboardShortcuts } from "./title-keyboard-shortcuts";
import { TitleProvider } from "./title-provider";
import { TitleRecommendations } from "./title-recommendations";
import { TitleSeasons } from "./title-seasons";
import { TitleTheme } from "./title-theme";

export interface TitleDetailData {
  title: ResolvedTitle;
  seasons: Season[];
  availability: AvailabilityOffer[];
  cast: CastMember[];
}

/** A title's page body; used by the /titles/$id route and by the phone sheet. */
export function TitleDetailContent({
  data,
  showBackButton = false,
  shortcuts = true,
}: {
  data: TitleDetailData;
  showBackButton?: boolean;
  /** Keyboard shortcuts (Escape goes back etc.); off inside the sheet, which handles its own. */
  shortcuts?: boolean;
}) {
  const { title, seasons, availability, cast } = data;
  const themeStyle = getThemeCssProperties(title.colorPalette);

  return (
    <div className="relative space-y-6" style={themeStyle}>
      <TitleTheme style={themeStyle as Record<string, string>} />
      {showBackButton && <BackButton className="absolute start-0 top-0 z-20" />}
      <TitleProvider
        key={title.id}
        titleId={title.id}
        titleType={title.type}
        titleName={title.title}
        seasons={seasons}
      >
        <TitleHero title={title} trailerVideoKey={title.trailerVideoKey} actions={<TitleActions />}>
          <TitleAvailability availability={availability} />
        </TitleHero>

        {title.type === "tv" && seasons.length > 0 && <TitleSeasons />}

        <TitleCast cast={cast} titleType={title.type} />

        {shortcuts && <TitleKeyboardShortcuts />}
      </TitleProvider>

      <TitleRecommendations titleId={title.id} />
    </div>
  );
}
