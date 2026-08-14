/**
 * 内存版凭证存储 —— 替代 Pi SDK 默认的 ~/.arona/auth.json。
 *
 * ARONA 的 API key 由 settings.json → setRuntimeApiKey() 在启动时注入
 * RuntimeCredentials 的内存 overrides，从不落盘。给 ModelRuntime.create()
 * 传入本存储，可让 SDK 跳过 FileAuthStorageBackend，彻底不再创建 auth.json。
 *
 * 代价：OAuth 订阅制登录（radius 网关等）的凭证无法跨会话持久化。
 * 仅 type-only 导入，运行时零依赖，不受 pi-ai 版本分裂影响。
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** 按 provider 串行化的写队列：保证 modify/delete 互斥，语义与 SDK 内存版一致。 */
export class InMemoryCredentialStore implements CredentialStore {
  private credentials = new Map<string, Credential>();
  private chains = new Map<string, Promise<unknown>>();

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(providerId, next.catch(() => undefined));
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = this.credentials.get(providerId);
      const next = await fn(current);
      // SDK 契约：fn 返回 undefined 表示"保持不变"（返回当前值），而非删除凭证
      if (next !== undefined) {
        this.credentials.set(providerId, next);
      }
      return next ?? current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      this.credentials.delete(providerId);
    });
  }
}
