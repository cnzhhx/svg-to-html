import { CoreServiceError, requestCoreJson } from './client.js';
import { GatewayError } from '../settings/gateway-store.js';

export type QueueSettings = { revision: number; maxConcurrentJobs: number };
export async function requestQueueSettings(value?: unknown): Promise<QueueSettings> {
  try {
    const result = await requestCoreJson<QueueSettings>('/api/queue/settings', {
      signal: AbortSignal.timeout(5000),
      ...(value === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
    });
    if (!Number.isSafeInteger(result.revision) || result.revision < 1 || !Number.isSafeInteger(result.maxConcurrentJobs) || result.maxConcurrentJobs < 1) {
      throw new GatewayError(502, '转换服务返回的并发设置无效');
    }
    return result;
  } catch (error) {
    if (error instanceof CoreServiceError) {
      if (error.status === 404) throw new GatewayError(501, '当前 Core 尚不支持在线并发设置，请先升级 Core');
      if (error.status === 409) throw new GatewayError(409, '并发设置已更新，请重新加载后再保存');
      if (error.status === 400) throw new GatewayError(400, '同时执行的 session 数必须是 1–32 的整数');
    }
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(503, '无法确认 Core 的并发设置，请稍后重新加载确认');
  }
}
