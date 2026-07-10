---
"@valkyriweb/pi-coding-agent": patch
---

Repaint dynamic registered footer pills reliably: pill output joins the footer render memo key (any `registerFooter` consumer repaints on the next render pass), and `FooterComponent.invalidate()` actually evicts memoized lines for core task subscriptions.
