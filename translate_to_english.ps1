# translate_to_english.ps1
# Run: PowerShell -ExecutionPolicy Bypass -File .\translate_to_english.ps1

$pages = @(
  "app\vat\page.tsx",
  "app\covers\page.tsx",
  "app\settings\page.tsx",
  "app\budget\page.tsx",
  "app\revenue-split\page.tsx",
  "app\alerts\page.tsx",
  "app\invoices\page.tsx",
  "app\dashboard\page.tsx",
  "app\notebook\page.tsx"
)

foreach ($page in $pages) {
  if (Test-Path $page) {
    $path = (Resolve-Path $page).Path
    $content = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $original = $content

    # VAT page
    $content = $content -replace 'Momsredovisning', 'VAT Breakdown'
    $content = $content -replace 'Utg[^\w]*ende moms.*?f[^\w]*rs[^\w]*ljning[^\w]*\)', 'Output VAT (on sales)'
    $content = $content -replace 'Ing[^\w]*ende moms.*?avdragsgill[^\w]*\)', 'Input VAT (deductible)'
    $content = $content -replace 'Moms att betala till Skatteverket', 'VAT payable to Tax Authority'
    $content = $content -replace 'Utgående moms', 'Output VAT'
    $content = $content -replace 'Ingående moms', 'Input VAT'
    $content = $content -replace 'på försäljning', 'on sales'
    $content = $content -replace 'avdragsgill', 'deductible'
    $content = $content -replace 'Moms att betala', 'VAT payable'
    $content = $content -replace 'Netto \(ex moms\)', 'Net (ex VAT)'
    $content = $content -replace 'Brutto \(ink moms\)', 'Gross (inc VAT)'
    $content = $content -replace 'Totalt utgående moms', 'Total output VAT'
    $content = $content -replace 'Totalt ingående moms', 'Total input VAT'
    $content = $content -replace 'Momsats', 'VAT rate'
    $content = $content -replace 'alkohol & varor', 'alcohol & goods'
    $content = $content -replace 'mat & dryck', 'food & drinks'

    # Covers page
    $content = $content -replace 'Frukost', 'Breakfast'
    $content = $content -replace 'Middag', 'Dinner'
    $content = $content -replace 'Daglig gästräkning', 'Daily guest count'
    $content = $content -replace 'Antal gäster', 'Guest count'
    $content = $content -replace 'Genomsnittsnota', 'Revenue per cover'
    $content = $content -replace 'Synka POS', 'Sync POS'
    $content = $content -replace 'Lägg till', 'Add entry'
    $content = $content -replace 'Laddar', 'Loading'
    $content = $content -replace 'Sparar', 'Saving'
    $content = $content -replace 'Avbryt', 'Cancel'
    $content = $content -replace "'Spara'", "'Save'"
    $content = $content -replace 'senaste 30 dagarna', 'last 30 days'
    $content = $content -replace 'gäster/dag', 'guests/day'
    $content = $content -replace 'per kuvert', 'per cover'
    $content = $content -replace 'Total omsättning', 'Total revenue'
    $content = $content -replace 'Ingen data ännu', 'No data yet'
    $content = $content -replace 'Datum', 'Date'
    $content = $content -replace 'Totalt', 'Total'
    $content = $content -replace 'Omsättning', 'Revenue'
    $content = $content -replace 'Snittbord', 'Rev/cover'

    # Settings page
    $content = $content -replace 'Supplier Mapping', 'Supplier Mapping'
    $content = $content -replace 'Aktiva regler', 'Active rules'
    $content = $content -replace 'Om leverantörsnamnet innehåller', 'If vendor name contains'
    $content = $content -replace 'Lägg till regel', 'Add rule'
    $content = $content -replace 'Testa en leverantör', 'Test a vendor'
    $content = $content -replace 'Ingen matchning', 'No match found'
    $content = $content -replace 'Matchad', 'Matched'
    $content = $content -replace 'Ta bort', 'Delete'
    $content = $content -replace 'Prioritet', 'Priority'
    $content = $content -replace 'Reglerna tillämpas i prioritetsordning', 'Rules are applied in priority order'
    $content = $content -replace 'Inga regler ännu', 'No rules yet'
    $content = $content -replace 'T.ex.', 'e.g.'

    # Budget page
    $content = $content -replace 'Budget vs Utfall', 'Budget vs Actual'
    $content = $content -replace 'Månadsdetaljer', 'Monthly Details'
    $content = $content -replace 'Årsöversikt', 'Annual Overview'
    $content = $content -replace 'Månader med data', 'Months with data'
    $content = $content -replace 'Budget uppfylld', 'Budget achieved'
    $content = $content -replace 'Budgeterad omsättning', 'Budgeted revenue'
    $content = $content -replace 'Budgeterat resultat', 'Budgeted profit'
    $content = $content -replace 'Helår', 'Full year'
    $content = $content -replace 'Avvikelse', 'Variance'
    $content = $content -replace 'Fg år', 'Prev year'
    $content = $content -replace 'Utfall', 'Actual'
    $content = $content -replace 'Sätt budget', 'Set budget'
    $content = $content -replace "'Ändra'", "'Edit'"
    $content = $content -replace 'Jämför budget mot faktiska siffror', 'Compare budget against actual figures'
    $content = $content -replace 'med förra årets data som referens', 'with last year as reference'
    $content = $content -replace 'Matkostnad', 'Food cost'
    $content = $content -replace 'Personalkostnad', 'Staff cost'
    $content = $content -replace 'Resultat', 'Profit'
    $content = $content -replace 'Antal gäster', 'Covers'
    $content = $content -replace 'Fg år:', 'Prev year:'
    $content = $content -replace 'Spara budget', 'Save budget'
    $content = $content -replace 'Inget budget', 'No budget'

    # Month names
    $content = $content -replace 'Januari', 'January'
    $content = $content -replace 'Februari', 'February'
    $content = $content -replace 'Mars', 'March'
    $content = $content -replace "'Maj'", "'May'"
    $content = $content -replace 'Juni', 'June'
    $content = $content -replace 'Juli', 'July'
    $content = $content -replace 'Augusti', 'August'
    $content = $content -replace 'Oktober', 'October'

    # Day abbreviations
    $content = $content -replace "'Mån'", "'Mon'"
    $content = $content -replace "'Tis'", "'Tue'"
    $content = $content -replace "'Ons'", "'Wed'"
    $content = $content -replace "'Tor'", "'Thu'"
    $content = $content -replace "'Fre'", "'Fri'"
    $content = $content -replace "'Lör'", "'Sat'"
    $content = $content -replace "'Sön'", "'Sun'"

    # Revenue split
    $content = $content -replace 'Food vs Beverage Split', 'Food vs Beverage Split'
    $content = $content -replace 'Livsmedel', 'Food'
    $content = $content -replace 'månader', 'months'

    if ($content -ne $original) {
      [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
      Write-Host "Translated: $page"
    } else {
      Write-Host "No changes: $page"
    }
  } else {
    Write-Host "Not found: $page"
  }
}

Write-Host ""
Write-Host "Done! Now run:"
Write-Host "  git add ."
Write-Host "  git commit -m 'Translate all pages to English'"
Write-Host "  vercel --prod"
