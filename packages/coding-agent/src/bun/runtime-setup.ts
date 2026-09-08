import { bedrockProviderModule } from "@lue-labs/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@lue-labs/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@lue-labs/pi-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
