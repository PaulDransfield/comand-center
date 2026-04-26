"""
Known-good reference values for regression testing.

Update with care — these are the source of truth for what the extractor
should produce. If you change them, document why.
"""

# Format A: Resultatrapport_2025_12_mån__1_.pdf
# These match the BERÄKNAT RESULTAT row in the original PDF.
YEARLY_BERAKNAT = {
    "2501": -245.0, "2502":  -22.6, "2503": -176.3,
    "2504": -385.8, "2505": -440.6, "2506": -414.6,
    "2507": -326.9, "2508": -396.8, "2509": -434.1,
    "2510":  -58.0, "2511":  484.8, "2512": 2416.2,
    "Ack":    -0.4,
}

# Sum of categorized revenue should match Summa nettoomsättning.
YEARLY_NETTO_BY_MONTH = {
    "2501":   883.7, "2502":   913.7, "2503":  1101.5,
    "2504":   625.0, "2505":   532.5, "2506":   406.3,
    "2507":   439.7, "2508":   687.0, "2509":   772.8,
    "2510":  1315.5, "2511":  1623.9, "2512":  2195.2,
    "Ack":  11497.0,
}

# Format B: Resultatrapport_2602.pdf (Feb 2026)
MONTHLY_NETTO = {
    "period":       1644159.94,
    "ackumulerat":  3461258.70,
    "period_fg_år":  913611.87,
}

# Cross-format consistency: Format-A column 2502 ≈ Format-B period_fg_år
# within rounding (Format A is in tkr, so up to ~0.5 tkr per row error).
# This pair is provided so a future agent can verify cross-format integrity.
