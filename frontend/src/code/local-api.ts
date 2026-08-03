const API_BASE = (import.meta.env.VITE_VISIONOWL_API_URL || "").replace(/\/$/, "");
const LOCAL_TOKEN_STORAGE_KEY = "visionowl.local-api-token";
let desktopToken: Promise<string> | undefined;

function tokenFromUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("localToken") || "";
  if (!token) return "";
  window.sessionStorage.setItem(LOCAL_TOKEN_STORAGE_KEY, token);
  url.searchParams.delete("localToken");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}

async function localApiToken() {
  const fromUrl = tokenFromUrl();
  if (fromUrl) return fromUrl;
  const configured = import.meta.env.VITE_VISIONOWL_LOCAL_TOKEN || "";
  if (configured) return configured;
  const stored =
    typeof window === "undefined"
      ? ""
      : window.sessionStorage.getItem(LOCAL_TOKEN_STORAGE_KEY) || "";
  if (stored) return stored;
  if (window.visionOwlDesktop) {
    desktopToken ||= window.visionOwlDesktop.localApiToken();
    const token = await desktopToken;
    window.sessionStorage.setItem(LOCAL_TOKEN_STORAGE_KEY, token);
    return token;
  }
  throw new Error(
    "VisionOwl Local API token is unavailable. Restart VisionOwl from the desktop app or npm run dev.",
  );
}

async function localHeaders(headers?: HeadersInit) {
  return {
    "X-VisionOwl-Local-Token": await localApiToken(),
    ...Object.fromEntries(new Headers(headers).entries()),
  };
}

export async function localApiFetch(path: string, options?: RequestInit) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: await localHeaders(options?.headers),
  });
}

export async function localApiEventSource(path: string) {
  const token = encodeURIComponent(await localApiToken());
  const separator = path.includes("?") ? "&" : "?";
  return new EventSource(`${API_BASE}${path}${separator}local_token=${token}`);
}
