#!/usr/bin/env python3
# translate_to_english.py
# Run: python translate_to_english.py
# Translates all Swedish UI text to English across all page files

import os

TRANSLATIONS = {
    # VAT page
    'Momsredovisning': 'VAT Breakdown',
    'Utg\u00e5ende moms': 'Output VAT',
    'Ing\u00e5ende moms': 'Input VAT',
    'Moms att betala till Skatteverket': 'VAT payable to Tax Authority',
    'Moms att betala': 'VAT payable',
    'p\u00e5 f\u00f6rs\u00e4ljning': 'on sales',
    'avdragsgill': 'deductible',
    'Netto (ex moms)': 'Net (ex VAT)',
    'Brutto (ink moms)': 'Gross (inc VAT)',
    'Totalt utg\u00e5ende moms': 'Total output VAT',
    'Totalt ing\u00e5ende moms': 'Total input VAT',
    'Momsats': 'VAT rate',
    'alkohol & varor': 'alcohol & goods',
    'mat & dryck': 'food & drinks',
    # Covers page
    'Frukost': 'Breakfast',
    'Middag': 'Dinner',
    'Daglig g\u00e4str\u00e4kning': 'Daily guest count',
    'Antal g\u00e4ster': 'Guest count',
    'Genomsnittsnota': 'Revenue per cover',
    'Synka POS': 'Sync POS',
    'L\u00e4gg till': 'Add',
    'Laddar\u2026': 'Loading...',
    'Laddar': 'Loading',
    'Sparar\u2026': 'Saving...',
    'Sparar': 'Saving',
    'Avbryt': 'Cancel',
    'senaste 30 dagarna': 'last 30 days',
    'g\u00e4ster/dag': 'guests/day',
    'per kuvert': 'per cover',
    'Total oms\u00e4ttning': 'Total revenue',
    'Ingen data \u00e4nnu': 'No data yet',
    'Datum': 'Date',
    'Snittbord': 'Rev/cover',
    'F\u00f6rdelning per period': 'Breakdown by period',
    'Alla perioder': 'All periods',
    # Settings page
    'Aktiva regler': 'Active rules',
    'Om leverant\u00f6rsnamnet inneh\u00e5ller': 'If vendor name contains',
    'L\u00e4gg till regel': 'Add rule',
    'Testa en leverant\u00f6r': 'Test a vendor',
    'Ingen matchning': 'No match found',
    'Matchad': 'Matched',
    'Ta bort': 'Delete',
    'Prioritet': 'Priority',
    'Reglerna till\u00e4mpas i prioritetsordning': 'Rules applied in priority order',
    'Inga regler \u00e4nnu': 'No rules yet',
    'T.ex.': 'e.g.',
    'Sparar\u2026': 'Saving...',
    # Budget page
    'Budget vs Utfall': 'Budget vs Actual',
    'M\u00e5nadsdetaljer': 'Monthly Details',
    '\u00c5rs\u00f6versikt': 'Annual Overview',
    'M\u00e5nader med data': 'Months with data',
    'Budget uppfylld': 'Budget achieved',
    'Budgeterad oms\u00e4ttning': 'Budgeted revenue',
    'Budgeterat resultat': 'Budgeted profit',
    'Hel\u00e5r': 'Full year',
    'Avvikelse': 'Variance',
    'Fg \u00e5r': 'Prev year',
    'Fg \u00e5r:': 'Prev year:',
    'S\u00e4tt budget': 'Set budget',
    'J\u00e4mf\u00f6r budget mot faktiska siffror': 'Compare budget against actual figures',
    'med f\u00f6rra \u00e5rets data som referens': 'with last year as reference',
    'Spara budget': 'Save budget',
    'Matkostnad': 'Food cost',
    'Personalkostnad': 'Staff cost',
    'Antal g\u00e4ster': 'Covers',
    # Revenue split
    'm\u00e5nader': 'months',
    'Livsmedel': 'Food',
    # Month names
    'Januari': 'January',
    'Februari': 'February',
    'Mars': 'March',
    'Juni': 'June',
    'Juli': 'July',
    'Augusti': 'August',
    'Oktober': 'October',
    # Day abbreviations in arrays
    "'M\u00e5n'": "'Mon'",
    "'Tis'": "'Tue'",
    "'Ons'": "'Wed'",
    "'Tor'": "'Thu'",
    "'Fre'": "'Fri'",
    "'L\u00f6r'": "'Sat'",
    "'S\u00f6n'": "'Sun'",
    # Common
    'Omsättning': 'Revenue',
    'Omsattning': 'Revenue',
    'Restaurang': 'Restaurant',
    'Stad': 'City',
    'Inga': 'No',
}

PAGES = [
    'app/vat/page.tsx',
    'app/covers/page.tsx',
    'app/settings/page.tsx',
    'app/budget/page.tsx',
    'app/revenue-split/page.tsx',
    'app/alerts/page.tsx',
    'app/invoices/page.tsx',
    'app/dashboard/page.tsx',
    'app/notebook/page.tsx',
]

for page in PAGES:
    if not os.path.exists(page):
        print(f'Not found: {page}')
        continue

    with open(page, encoding='utf-8') as f:
        content = f.read()

    original = content
    for sv, en in TRANSLATIONS.items():
        content = content.replace(sv, en)

    if content != original:
        with open(page, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'Translated: {page}')
    else:
        print(f'No changes: {page}')

print('\nDone! Now run:')
print('  git add .')
print('  git commit -m "Translate all pages to English"')
print('  vercel --prod')
