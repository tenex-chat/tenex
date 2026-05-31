---
title: HTML Report Client
slug: html-report-client
summary: "The HtmlReport model in the TUI client parses kind:1 events tagged #t:html-report, extracting url, title, description, conversation_id, project a-tag, and is_zi"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-03
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:390d9f35-62c6-42aa-b14d-37c918dcd55b
---

# HTML Report Client

## Data Model & Ingestion

The HtmlReport model in the TUI client parses kind:1 events tagged #t:html-report, extracting url, title, description, conversation_id, project a-tag, and is_zip (determined from the m tag, falling back to URL extension). The nostr worker subscribes globally to kinds:[1], #t:["html-report"] events. The Swift loadReport() always downloads data first and checks the actual Content-Type response header to determine if the payload is a zip, rather than relying on URL file extension. [^390d9-5]


## Chat Inline Display

A report callout card appears inline in the chat conversation when an agent publishes via html_publish or report_publish, showing title, kind label, and an Open button that opens the report. [^390d9-6]

## Report Viewing Layout

HTML reports are displayed in a split-detail pane on macOS/iPad and in a full sheet on iPhone. [^390d9-7]

## Zip Bundle Handling

Zip bundles on macOS are served through a WKURLSchemeHandler using the tenex-file:// scheme, serving files directly from the extracted directory in-process to bypass WebContent sandbox restrictions on loadFileURL. Zip bundles on iOS use ZIPFoundation's FileManager.unzipItem(at:to:) for extraction and loadFileURL for rendering. [^390d9-8]

## WebView Layout Constraints

WKWebView in NSViewRepresentable must have translatesAutoresizingMaskIntoConstraints set to false and a .frame(maxWidth: .infinity, maxHeight: .infinity) SwiftUI modifier to prevent infinite AppKit layout loops. [^390d9-9]
## See Also

