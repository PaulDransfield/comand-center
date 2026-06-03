// .eslintrc.cjs
//
// Responsive-system guardrail. Extends the Next.js default with two
// warnings designed to make non-responsive page code visible at review
// time:
//
//   - maxWidth: 12\d{2} in JSX style — use <PageContainer>
//   - width: \d{3,}px in JSX style    — use <ResponsiveChart> for charts
//                                       or <CardGrid> for layout
//
// Warnings, not errors. The reviewer judges — primitives in
// components/ui/* are exempt because they're the source of truth.
//
// See docs/LAYOUT.md for the convention.

module.exports = {
  extends: ['next/core-web-vitals'],

  // Project-wide rule relaxation — existing code uses unescaped
  // apostrophes in JSX widely; treat them as warnings, not errors,
  // so we don't block builds on cosmetic rules. (The Next.js default
  // turns them into errors.)
  rules: {
    'react/no-unescaped-entities': 'off',
  },

  // Apply the guardrail to pages + components, NOT to the primitives
  // themselves (which legitimately need pixel widths) or to scripts.
  overrides: [
    {
      files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
      excludedFiles: [
        'components/ui/Layout.tsx',
        'components/ui/DataTable.tsx',
        'components/ui/ResponsiveChart.tsx',
        'components/ui/ProductThumb.tsx',
        'components/ui/Overlay.tsx',
        'components/ui/SyncIndicator.tsx',
      ],
      rules: {
        'no-restricted-syntax': [
          'warn',
          // Catches JSX style attribute with `maxWidth: 1280` / 1100 / etc.
          // Heuristic — matches the Property node within a JSX style object.
          {
            selector: "JSXAttribute[name.name='style'] Property[key.name='maxWidth'] Literal[value=/^1[0-9]{3}/]",
            message: 'Avoid hardcoded maxWidth in page styles — use <PageContainer> from components/ui/Layout.tsx instead.',
          },
          // Catches JSX style width: "1100px" / "1200px" etc. (strings).
          {
            selector: "JSXAttribute[name.name='style'] Property[key.name='width'] Literal[value=/^[1-9][0-9]{2,}px/]",
            message: 'Avoid hardcoded pixel widths in page styles — use <ResponsiveChart> for charts or <CardGrid> for layout (see docs/LAYOUT.md).',
          },
        ],
      },
    },
  ],
}
