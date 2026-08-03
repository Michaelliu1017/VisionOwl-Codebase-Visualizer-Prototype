import type { CloudSession } from "@visionowl/contracts";

const WEB_SESSION_KEY = "visionowl.cloud-session";
const WEB_API_KEY = "visionowl.cloud-api-url";
let currentSession: CloudSession | null | undefined;

export async function cloudApiBase() {
  const configured = import.meta.env.VITE_VISIONOWL_CLOUD_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (window.visionOwlDesktop) {
    return (await window.visionOwlDesktop.cloudApiUrl()).replace(/\/$/, "");
  }
  return (window.localStorage.getItem(WEB_API_KEY) || "http://127.0.0.1:17800").replace(/\/$/, "");
}

export async function saveCloudApiBase(value: string) {
  const normalized = value.trim().replace(/\/$/, "");
  const url = new URL(normalized);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("云端服务必须使用 HTTPS；只有本地开发地址可以使用 HTTP。");
  }
  await clearCloudSession();
  if (window.visionOwlDesktop) return window.visionOwlDesktop.setCloudApiUrl(normalized);
  window.localStorage.setItem(WEB_API_KEY, normalized);
  return normalized;
}

export async function loadCloudSession() {
  if (currentSession !== undefined) return currentSession;
  if (window.visionOwlDesktop) {
    currentSession = await window.visionOwlDesktop.getCloudSession();
  } else {
    try {
      currentSession = JSON.parse(
        window.localStorage.getItem(WEB_SESSION_KEY) || "null",
      ) as CloudSession | null;
    } catch (_error) {
      currentSession = null;
    }
  }
  return currentSession;
}

export async function saveCloudSession(session: CloudSession) {
  currentSession = session;
  if (window.visionOwlDesktop) {
    await window.visionOwlDesktop.setCloudSession(session);
  } else {
    window.localStorage.setItem(WEB_SESSION_KEY, JSON.stringify(session));
  }
}

export async function clearCloudSession() {
  currentSession = null;
  if (window.visionOwlDesktop) {
    await window.visionOwlDesktop.clearCloudSession();
  } else {
    window.localStorage.removeItem(WEB_SESSION_KEY);
  }
}
