---
"@lue-labs/pi-coding-agent": patch
"@lue-labs/pi-tui": patch
---

editor: let extensions highlight ranges of the text input

`Editor.setHighlighter()` takes a function that maps the current input text to
`{ start, end, style }` ranges, and the layout pass renders those runs through
`style`. Ranges are applied after `onLayoutLines`, so editor subclasses that
override the layout hook keep working, and the grapheme under the cursor is
carved out of any span so the cursor stays visible.

`LayoutLine` now carries `startIndex`, the absolute offset of the line in the
document, including word-wrapped continuation chunks — highlighters work in
document coordinates and no longer have to reconstruct that themselves.

Extensions reach this through the new `ui.addInputHighlighter()` in the
interactive mode's UI context; several extensions can contribute ranges to the
same input, and each highlighter is isolated so one throwing does not break
rendering. RPC and headless modes accept the call and ignore it.
