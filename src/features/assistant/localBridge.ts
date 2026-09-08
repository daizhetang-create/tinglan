export const LOCAL_BRIDGE_MESSAGE = '此操作需要本机完整版。在线页面不会发送你的音频、图片或文字，请使用 http://127.0.0.1:4318/ 并启动本机 Codex 服务。';

export function isLocalBridgeLocation(value: { protocol: string; hostname: string }): boolean {
  return value.protocol === 'http:' && (value.hostname === 'localhost' || value.hostname === '127.0.0.1');
}

/** Fail before serializing or uploading private data; never redirect hosted requests to localhost. */
export function requireLocalBridge(): void {
  if (typeof window === 'undefined' || !isLocalBridgeLocation(window.location)) throw new Error(LOCAL_BRIDGE_MESSAGE);
}
