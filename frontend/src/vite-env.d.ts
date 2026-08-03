/// <reference types="vite/client" />

interface Window {
  visionOwlDesktop?: {
    platform: string;
    selectDirectory: () => Promise<string | null>;
    localApiToken: () => Promise<string>;
    cloudApiUrl: () => Promise<string>;
    setCloudApiUrl: (value: string) => Promise<string>;
    getCloudSession: () => Promise<import("@visionowl/contracts").CloudSession | null>;
    setCloudSession: (value: import("@visionowl/contracts").CloudSession) => Promise<boolean>;
    clearCloudSession: () => Promise<boolean>;
    startDwsAuthentication: () => Promise<{
      authenticated: true;
      alreadyAuthenticated: boolean;
    }>;
  };
}
