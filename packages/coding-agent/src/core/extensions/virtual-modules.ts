import * as bundledPiAgentCore from "@lue-labs/pi-agent-core";
import * as bundledPiAiCompat from "@lue-labs/pi-ai/compat";
import * as bundledPiAiOauth from "@lue-labs/pi-ai/oauth";
import * as bundledPiAiProviders from "@lue-labs/pi-ai/providers/all";
import * as bundledPiTui from "@lue-labs/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @earendil-works/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@lue-labs/pi-agent-core": bundledPiAgentCore,
	"@lue-labs/pi-tui": bundledPiTui,
	"@lue-labs/pi-ai": bundledPiAiCompat,
	"@lue-labs/pi-ai/compat": bundledPiAiCompat,
	"@lue-labs/pi-ai/oauth": bundledPiAiOauth,
	"@lue-labs/pi-ai/providers/all": bundledPiAiProviders,
	"@lue-labs/pi-coding-agent": bundledPiCodingAgent,
	"@valkyriweb/pi-agent-core": bundledPiAgentCore,
	"@valkyriweb/pi-tui": bundledPiTui,
	"@valkyriweb/pi-ai": bundledPiAiCompat,
	"@valkyriweb/pi-ai/compat": bundledPiAiCompat,
	"@valkyriweb/pi-ai/oauth": bundledPiAiOauth,
	"@valkyriweb/pi-ai/providers/all": bundledPiAiProviders,
	"@valkyriweb/pi-coding-agent": bundledPiCodingAgent,
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	"@earendil-works/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@earendil-works/pi-ai": bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
