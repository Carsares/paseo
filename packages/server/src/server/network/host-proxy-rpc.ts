import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { proxySlots } from "./proxy-settings.js";
import {
  ProxyRetestRequiredError,
  ProxyRevisionConflictError,
  type HostProxyRuntime,
} from "./proxy-runtime.js";

type Request = Extract<SessionInboundMessage, { type: `daemon.network.${string}.request` }>;

export function isHostProxyRequest(message: SessionInboundMessage): message is Request {
  return (
    message.type === "daemon.network.get_proxy.request" ||
    message.type === "daemon.network.test_proxy.request" ||
    message.type === "daemon.network.set_proxy.request"
  );
}

function snapshot(
  runtime: HostProxyRuntime,
  editable: boolean,
  supportsCredentialReplacement: boolean,
) {
  const { revision, settings, credentialConfigured } = runtime.read();
  const { controlPlane: _controlPlane, ...outbound } = settings;
  return {
    access: editable ? ("edit" as const) : ("read-only" as const),
    revision,
    settings: outbound,
    credentialSlots: proxySlots.filter((slot) => credentialConfigured[slot]),
    supportsBypass: true,
    supportsCredentialReplacement,
  };
}

export async function handleHostProxyRequest(options: {
  request: Request;
  runtime?: HostProxyRuntime;
  source: object;
  signal: AbortSignal;
  authorized: boolean;
  allowCredentialReplacement: boolean;
  canManage: () => boolean;
}): Promise<SessionOutboundMessage> {
  const { request, runtime, source, signal, authorized, allowCredentialReplacement, canManage } =
    options;
  const { requestId } = request;
  let failure: "denied" | "unavailable" | undefined;
  if (!authorized) failure = "denied";
  else if (!runtime?.available) failure = "unavailable";
  switch (request.type) {
    case "daemon.network.get_proxy.request":
      return {
        type: "daemon.network.get_proxy.response",
        payload: {
          requestId,
          result: failure
            ? { status: failure }
            : {
                status: "loaded",
                snapshot: snapshot(runtime!, canManage(), allowCredentialReplacement),
              },
        },
      };
    case "daemon.network.test_proxy.request": {
      const type = "daemon.network.test_proxy.response";
      if (failure) return { type, payload: { requestId, result: { status: failure } } };
      if (
        !allowCredentialReplacement &&
        proxySlots.some((slot) => request.credentials?.[slot]?.action === "replace")
      ) {
        return { type, payload: { requestId, result: { status: "denied" } } };
      }
      try {
        const { validationId, revision, expiresInMs } = await runtime!.validate(
          request.expectedRevision,
          request.settings,
          request.credentials,
          source,
          signal,
        );
        if (!canManage()) return { type, payload: { requestId, result: { status: "denied" } } };
        return {
          type,
          payload: {
            requestId,
            result: {
              status: "passed",
              receipt: { verificationId: validationId, revision, expiresInMs },
            },
          },
        };
      } catch (error) {
        const status = error instanceof ProxyRevisionConflictError ? "revision-conflict" : "failed";
        return { type, payload: { requestId, result: { status } } };
      }
    }
    case "daemon.network.set_proxy.request": {
      const type = "daemon.network.set_proxy.response";
      if (failure) return { type, payload: { requestId, result: { status: failure } } };
      try {
        await runtime!.apply(
          request.revision,
          request.verificationId,
          source,
          () => !signal.aborted && canManage(),
        );
        return {
          type,
          payload: {
            requestId,
            result: {
              status: "saved",
              snapshot: snapshot(runtime!, canManage(), allowCredentialReplacement),
            },
          },
        };
      } catch (error) {
        if (!runtime!.available)
          return { type, payload: { requestId, result: { status: "unavailable" } } };
        if (!canManage()) return { type, payload: { requestId, result: { status: "denied" } } };
        if (error instanceof ProxyRevisionConflictError)
          return { type, payload: { requestId, result: { status: "revision-conflict" } } };
        const status = error instanceof ProxyRetestRequiredError ? "retest-required" : "failed";
        return { type, payload: { requestId, result: { status } } };
      }
    }
  }
}
