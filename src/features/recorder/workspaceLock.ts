/** Only one editable app per browser origin. Browser releases this lock after a crash. */
export async function acquireWorkspaceLock(name = 'tinglan-workspace'): Promise<(() => void) | null> {
  if (!navigator.locks) throw new Error('此浏览器不支持安全录音锁，请使用最新版 Edge 或 Chrome。');
  return new Promise((resolve, reject) => {
    void navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { resolve(null); return; }
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
