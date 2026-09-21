import type { SizingTokens } from "../theme.js";

/** Token bag needed to resolve action.button's variant color scheme. */
export interface ActionButtonTokens {
  primary: string;
  border: string;
  danger: string;
  text: string;
  onPrimary: string;
}

/**
 * Full inline style for action.button (renderer-react's ActionButton / renderer-wc's
 * actionButton — the framework-free source of truth), merging the base layout style with
 * the variant color scheme and the disabled state.
 */
export function actionButtonStyle(
  variant: string,
  tokens: ActionButtonTokens,
  options: { disabled: boolean },
  sizing: SizingTokens,
) {
  const { disabled } = options;
  const colors = actionButtonVariantColors(variant, tokens);
  return {
    alignSelf: "flex-start",
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space4}`,
    fontSize: sizing.fontMd,
    fontWeight: 600,
    cursor: disabled ? ("not-allowed" as const) : ("pointer" as const),
    opacity: disabled ? 0.5 : 1,
    ...colors,
  } as const;
}

/** variant → color scheme. primary=filled primary color / secondary=outline only / danger=filled danger color. */
function actionButtonVariantColors(
  variant: string,
  tokens: ActionButtonTokens,
): { background: string; color: string; border: string } {
  switch (variant) {
    case "secondary":
      return { background: "transparent", color: tokens.text, border: `1px solid ${tokens.border}` };
    case "danger":
      return { background: tokens.danger, color: tokens.onPrimary, border: "none" };
    default:
      return { background: tokens.primary, color: tokens.onPrimary, border: "none" };
  }
}
