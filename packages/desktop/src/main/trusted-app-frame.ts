import type { IpcMainInvokeEvent, WebContents } from "electron";

export function trustedAppFrame(
  event: IpcMainInvokeEvent,
  appWindows: Pick<WeakSet<WebContents>, "has">,
  trusted: URL,
) {
  const { sender, senderFrame } = event;
  if (!appWindows.has(sender) || sender.isDestroyed() || !senderFrame) return null;
  if (senderFrame !== sender.mainFrame || senderFrame.detached) return null;
  const url = URL.parse(senderFrame.url);
  // Node's URL.origin is null for Electron's custom app scheme.
  if (!url || url.protocol !== trusted.protocol || url.host !== trusted.host) return null;
  return url.username || url.password ? null : senderFrame;
}
