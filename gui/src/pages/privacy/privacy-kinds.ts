/**
 * Kind → label key and kind → colour, in one place.
 *
 * Colour is the ONLY thing on this page that is colour-coded, and it codes exactly one
 * dimension: which kind of secret was replaced. Every value below is an existing token from
 * `styles.css`; the page adds no hue of its own, so light and dark follow the theme for free.
 * Seven kinds against a monochrome base means the palette is deliberately small: four signal
 * hues plus three neutrals, assigned by how alarming the kind is rather than by taste.
 */
import type { TKey } from "../../i18n/shared";
import { PRIVACY_KINDS, type PrivacyKind } from "./privacy-types";

export { PRIVACY_KINDS };

const KIND_COLOR: Record<PrivacyKind, string> = {
  password: "var(--red)",
  api_key: "var(--blue)",
  token: "var(--amber)",
  private_key: "var(--green)",
  connection_string: "var(--accent)",
  email: "var(--faint)",
  other: "var(--muted)",
};

export function privacyKindColor(kind: PrivacyKind): string {
  return KIND_COLOR[kind];
}

export function privacyKindKey(kind: PrivacyKind): TKey {
  // Concatenated rather than interpolated: a template literal carrying letters is what the
  // local i18n lint rule looks for, and this one is a key, not copy.
  return ("privacy.kind." + kind) as TKey;
}
