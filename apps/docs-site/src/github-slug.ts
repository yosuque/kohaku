/**
 * Reproduces GitHub's own Markdown heading-anchor slug rule: the rule GitHub.com applies when it
 * renders a `.md` file and assigns each heading an `id`, and therefore the rule every anchor link in
 * this repository was written against — because the Markdown here is read on GitHub as much as (or
 * more than) it is read through this generated site. VitePress's own default `slugify` (see
 * `apps/docs-site/.vitepress/config.ts`, which overrides it with this module) disagrees with GitHub on
 * two points and was silently breaking every in-repo anchor link that hit either one: it prefixes an
 * id that would start with a digit with `_` (GitHub does not), and it keeps non-ASCII punctuation such
 * as an em dash or an arrow literally instead of stripping it (GitHub strips it, which is what turns
 * the surrounding single spaces into a double hyphen).
 *
 * The rule below — lowercase; strip every character that is not a Unicode letter, digit, combining
 * mark, space, hyphen, or underscore; then replace each remaining single space with a single hyphen,
 * without collapsing runs of hyphens and without trimming — was derived from, and is cross-checked
 * against, the real headings and real cross-file links already in this repository (numbered sections,
 * an em dash, an arrow, a slash, parenthesized asides, and Japanese headings). See
 * `apps/docs-site/test/github-slug.test.ts` for that corpus and for the site-wide check that every
 * mirrored page's own anchor links resolve against it.
 *
 * This is deliberately narrower than the `github-slugger` npm package's full punctuation-stripping
 * regex (which enumerates many more Unicode punctuation/symbol blocks): it was not needed to match any
 * example this repository's Markdown actually produces, and a narrow, auditable rule is easier to
 * trust than a large one copied from elsewhere. If a future heading needs a punctuation class this
 * does not strip, `github-slug.test.ts`'s site-wide link-consistency check will fail on it before a
 * reader ever hits a dead link — extend the regex then, against that real counter-example.
 */

/** Everything GitHub's slugger drops: any character that is not a letter, digit, mark, space, hyphen, or underscore. */
const NON_SLUG_CHARS = /[^\p{L}\p{N}\p{M}\s_-]/gu;

export function githubHeadingSlug(headingText: string): string {
  return headingText.toLowerCase().replace(NON_SLUG_CHARS, "").replace(/ /g, "-");
}
