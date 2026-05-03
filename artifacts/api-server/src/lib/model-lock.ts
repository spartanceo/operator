/**
 * Process-wide model serializer mutex.
 *
 * Used by every adapter that issues a real model request (Ollama, llama.cpp,
 * etc.) so that concurrent task runs only ever block each other on the
 * model call itself — non-model work (file writes, knowledge-base
 * retrieval, planning) overlaps freely.
 *
 * tier-review: bounded — single Promise reference; replaced atomically per release.
 */
let modelLock: Promise<void> = Promise.resolve();

export async function withModelLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = modelLock;
  let release!: () => void;
  modelLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

export function __resetModelLockForTests(): void {
  modelLock = Promise.resolve();
}
