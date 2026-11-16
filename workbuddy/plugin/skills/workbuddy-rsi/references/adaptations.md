# Writing an evidence-backed adaptation

Adaptations use DSHRSI's unchanged sandbox API. One file calls `define`:

```javascript
define({
  title: 'Avoid repeating a missing executable',
  description: 'Explain the observed failure and refuse the same failing command after two attempts.',
  capabilities: ['annotate', 'deny'],
  setup(h) {
    let failures = 0
    h.onToolResult({ command: /^example-missing(?:\s|$)/ }, (call, result) => {
      if (result.ok || !result.text.includes('command not found')) return
      failures += 1
      return h.annotate('example-missing was not found. Check the installed equivalent before retrying.')
    })
    h.beforeTool({ command: /^example-missing(?:\s|$)/ }, () =>
      failures >= 2 ? h.deny('This command failed twice; use an installed equivalent.') : undefined)
  },
})
```

This is an illustrative template, not a finding about this computer. Use the actual observed executable and supported syntax. Do not deny `Get-Command`, `where.exe`, `command -v` or other discovery calls merely because their arguments contain the missing executable name.

Supported seams:

| Registration | Allowed effects |
| --- | --- |
| `h.promptSection(text)` | Standing context injected through native hooks |
| `h.onToolResult(filter, fn)` | `h.annotate(text)` |
| `h.beforeTool(filter, fn)` | `h.deny(text)`, `h.ask(text)` |
| `h.beforeStep(fn)` | `h.note(text)` |
| `h.beforeStop(fn)` | `h.continueWith(text)`; host limits continuation to one and honors `stop_hook_active` |

Check `API_REFERENCE` in the bundled upstream [capability definitions](../../../packages/dsh-rsi/src/capabilities.js) for full API details, applying the narrower capability list above. Unsupported capabilities `block`, `rewrite`, `tool`, `exec` are rejected. No permissive `allow` decision is emitted.

`propose FILE SESSION_ID SIGNATURE` always retrieves evidence from the live helper; it does not accept caller-supplied proof. It returns validation stages and a proposed record ID. Passing the gate checks the observed cases, not every future behavior. `approve ID` enables the proposal for the next WorkBuddy task/session; its response reports `activation: next-session`. `disable ID` or `undo` takes it back. Existing adaptations survive a helper restart; in-flight observations and counters do not.
