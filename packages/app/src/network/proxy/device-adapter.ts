import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type {
  ProxyLoadResult,
  ProxySaveResult,
  ProxySettingsAdapter,
  ProxyTestInput,
  ProxyTestResult,
  ProxyValidationReceipt,
} from "./settings";

interface DeviceCommands {
  get_device_proxy: { args: Record<string, never>; result: ProxyLoadResult };
  test_device_proxy: { args: ProxyTestInput; result: ProxyTestResult };
  set_device_proxy: {
    args: Pick<ProxyValidationReceipt, "validationId" | "revision">;
    result: ProxySaveResult;
  };
}

function invoke<Command extends keyof DeviceCommands>(
  command: Command,
  args: DeviceCommands[Command]["args"],
): Promise<DeviceCommands[Command]["result"]> {
  return invokeDesktopCommand(command, { ...args });
}

export function createDeviceProxyAdapter(): ProxySettingsAdapter {
  return {
    async load(target, signal) {
      if (target.kind !== "device" || signal.aborted) return { status: "unavailable" };
      return invoke("get_device_proxy", {});
    },
    async test(target, { change, expectedRevision }, signal) {
      if (target.kind !== "device" || signal.aborted) return { status: "unavailable" };
      return invoke("test_device_proxy", { change, expectedRevision });
    },
    async save(target, { validationId, revision }, signal) {
      if (target.kind !== "device" || signal.aborted) return { status: "unavailable" };
      return invoke("set_device_proxy", { validationId, revision });
    },
  };
}
