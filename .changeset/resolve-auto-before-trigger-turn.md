---
"@valkyriweb/pi-coding-agent": patch
---

Resolve pending auto-model aliases before extension-triggered custom-message turns, so goal startup/continuation cannot invoke an unresolved seed model before the model:resolve router selects a concrete model.
