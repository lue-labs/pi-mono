---
"@valkyriweb/pi-agent-core": patch
---

Stop executing the trailing tool call of a `length`-stopped assistant message. When the provider cuts a response at the output-token limit mid tool call, lenient partial-JSON parsing yields incomplete arguments — previously the agent loop executed the call anyway, producing either a misleading schema-validation error ("missing required property", with no hint the call was truncated) or, worse, a silently truncated payload that still validated (e.g. a `write` whose `content` string was cut short). The loop now skips executing that trailing call and synthesizes an error tool result telling the model the call was cut off by the output-token limit and to retry in smaller chunks instead of verbatim. Earlier complete tool calls in the same message, `length` stops ending in text, and all other stop reasons behave unchanged.
