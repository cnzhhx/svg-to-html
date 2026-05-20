import type { ModelProviderConfig } from "../../config/model-provider.js";
import type {
  AgentInput,
  AgentRuntime,
  AgentRunStreamedResult,
  AgentThread,
  AgentTurn,
  ThreadOptions,
} from "./types.js";

type CodexLike = {
  startThread(options?: ThreadOptions): AgentThread;
};

const loadCodex = async (modelConfig: ModelProviderConfig) => {
  const imported = (await import("@openai/codex-sdk")) as {
    Codex: new (options: unknown) => CodexLike;
  };
  return new imported.Codex({
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseURL,
    config: {
      disable_response_storage: true,
      model: modelConfig.model,
      model_provider: modelConfig.provider,
      model_providers: {
        [modelConfig.provider]: {
          base_url: modelConfig.baseURL,
          name: modelConfig.provider,
          requires_openai_auth: modelConfig.requiresOpenaiAuth,
          wire_api: modelConfig.wireApi,
        },
      },
      model_reasoning_effort: modelConfig.reasoningEffort,
    },
  });
};

class LazyCodexThread implements AgentThread {
  private innerThread: AgentThread | null = null;

  constructor(
    private readonly modelConfig: ModelProviderConfig,
    private readonly options?: ThreadOptions,
  ) {}

  get id() {
    return this.innerThread?.id ?? null;
  }

  async run(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentTurn> {
    const thread = await this.getInnerThread();
    return thread.run(input, turnOptions);
  }

  async runStreamed(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentRunStreamedResult> {
    const thread = await this.getInnerThread();
    return thread.runStreamed(input, turnOptions);
  }

  private async getInnerThread() {
    if (this.innerThread) return this.innerThread;
    const codex = await loadCodex(this.modelConfig);
    this.innerThread = codex.startThread(this.options);
    return this.innerThread;
  }
}

const createCodexRuntime = (modelConfig: ModelProviderConfig): AgentRuntime => {
  return {
    startThread(options?: ThreadOptions) {
      return new LazyCodexThread(modelConfig, options);
    },
  };
};

export { createCodexRuntime };
