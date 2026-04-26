# Fortnox Fixtures

Drop real Fortnox **Resultatrapport** PDFs in this folder so the parser is
developed against actual data and the golden tests catch regressions.

## What to add

Two PDFs are enough to start:

1. **`monthly-2025-XX.pdf`** — a single-month Resultatrapport (e.g. October
   or November 2025). One column per cost category.
2. **`annual-2025.pdf`** — the 12-month Resultatrapport for 2025. 12 monthly
   columns plus an "Ack." (year-total) column. This is the format that
   currently breaks November.

If the filenames you have are different, rename to match — the test harness
discovers files by filename.

## Privacy

These PDFs contain real Vero / Rosali financial data. They are **gitignored**
(see `.gitignore` in this folder) and never committed. Each developer who
runs the parser locally must drop their own copies in.

## How to test the parser

After dropping in a PDF, run:

```bash
node scripts/test-fortnox-parser.mjs tests/fortnox-fixtures/annual-2025.pdf
```

Output is the structured extraction JSON — same shape as what
`/api/fortnox/extract-worker` produces, but generated deterministically by
parsing the PDF tables directly. Compare against what you see in the source
PDF to spot misreads.

## Golden tests

Once the parser output matches a known-good PDF, freeze the expected values
in `expected.json` (one entry per fixture). The test runner asserts every
field. Future code changes that drift from the frozen values fail loudly.

`expected.json` is committed (it has no PII — just numbers); the source PDFs
are not.
