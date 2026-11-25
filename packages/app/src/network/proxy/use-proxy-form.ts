import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openProxyForm } from "./form-model";
import type { ProxySettingsAdapter, ProxyTarget, ProxyTestResult } from "./settings";

interface AdapterSession {
  adapter: ProxySettingsAdapter;
  signal: AbortSignal;
}

export function useProxyForm(target: ProxyTarget, adapter: ProxySettingsAdapter) {
  const [bound] = useState(() => {
    const scope = { ...target };
    return { scope, model: openProxyForm(scope) };
  });
  const { scope, model } = bound;
  const session = useRef<AdapterSession | null>(null);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const reload = useCallback(async () => {
    const active = session.current;
    if (!active || active.adapter !== adapter) return;
    const ticket = model.beginLoad();
    try {
      const result = await adapter.load(scope, active.signal);
      if (!active.signal.aborted) model.completeLoad(ticket, result);
    } catch {
      // Transport failures may contain secrets. Only the typed outcome reaches the form.
      if (!active.signal.aborted) model.completeLoad(ticket, { status: "failed" });
    }
  }, [adapter, model, scope]);

  useEffect(() => {
    const controller = new AbortController();
    session.current = { adapter, signal: controller.signal };
    void reload();
    return () => {
      session.current = null;
      controller.abort();
      model.close();
    };
  }, [adapter, model, reload]);

  function test() {
    const active = session.current;
    if (!active || active.adapter !== adapter) return;
    const request = model.beginTest();
    if (!request) return;
    const { ticket, input } = request;
    function complete(result: ProxyTestResult) {
      if (active && !active.signal.aborted) model.completeTest(ticket, result);
    }
    try {
      void adapter
        .test(scope, input, active.signal)
        .then(complete)
        .catch(() => complete({ status: "failed" }));
    } catch {
      complete({ status: "failed" });
    }
  }

  async function save() {
    const active = session.current;
    if (!active || active.adapter !== adapter) return;
    const request = model.beginSave();
    if (!request) return;
    const { ticket, receipt } = request;
    try {
      const result = await adapter.save(scope, receipt, active.signal);
      if (!active.signal.aborted) model.completeSave(ticket, result);
    } catch {
      if (!active.signal.aborted) model.completeSave(ticket, { status: "failed" });
    }
  }

  return { model, state, reload, test, save };
}
