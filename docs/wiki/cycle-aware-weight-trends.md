---
title: Cycle-Aware Weight Trends
slug: cycle-aware-weight-trends
summary: Cycle data is sourced exclusively from HealthKit (HKCategoryTypeIdentifierMenstrualFlow) with no manual input
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-06
updated: 2026-05-06
verified: 2026-05-06
compiled-from: conversation
sources:
  - session:c6a12a66-56f2-49b4-9910-b669544fe250
---

# Cycle-Aware Weight Trends

## Data Source & Privacy

Cycle data is sourced exclusively from HealthKit (HKCategoryTypeIdentifierMenstrualFlow) with no manual input. Cycle data is stored locally only and never leaves the device (not synced to iCloud or Nostr). [^c6a12-6]


## Feature Visibility & Language

Cycle-adjusted trends is an entirely opt-in feature, invisible by default, and surfaces only when HealthKit cycle data is detected. The cycle feature uses neutral, non-gendered language such as 'Fluctuation Patterns' or 'Cycle-adjusted trends', never 'cycle tracking' or gendered terms. [^c6a12-7]

## Data Integrity & Adjustment Model

Raw weight data is never mutated by cycle adjustments — cycle awareness is purely a display and projection layer. [^c6a12-8]

## Cut Rate Calculation

Cut rate calculation anchors to follicular-only weight readings (days 6–12) — the scientifically cleanest window — excluding luteal and menstrual days. [^c6a12-9]

## Projection & Averaging

The cut projection engine uses a 28–35 day EWMA instead of a 7-day moving average to avoid aliasing into cycle noise. When cycle variance exceeds 7 days across 3 cycles, the app falls back gracefully to a longer moving average. [^c6a12-10]

## Chart Display

The weight chart renders subtle background bands on high-retention (luteal + menstrual) days, with muted data point colors and a tap action showing 'Likely water retention'. [^c6a12-11]
## See Also

