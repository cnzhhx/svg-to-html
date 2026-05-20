import { MODEL_CONFIG } from "../../config/model-provider.js";
import { createCodexRuntime } from "./codex-runtime.js";
import { createKimiCliRuntime } from "./kimi-cli-runtime.js";
import type { AgentRuntime } from "./types.js";

const createAgentRuntime = (): AgentRuntime => {
  switch (MODEL_CONFIG.runtime) {
    case "codex":
      return createCodexRuntime(MODEL_CONFIG);
    case "kimi-cli":
      return createKimiCliRuntime(MODEL_CONFIG);
  }
};

const agentRuntime = createAgentRuntime();

export { agentRuntime, createAgentRuntime };
export type {
  AgentInput,
  AgentRuntime,
  AgentRunStreamedResult,
  AgentThread,
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurn,
  ThreadOptions,
  Usage,
} from "./types.js";
