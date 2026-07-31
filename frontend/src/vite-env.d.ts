/// <reference types="vite/client" />

interface Window {
  visionOwlDesktop?: {
    platform: string;
    selectDirectory: () => Promise<string | null>;
  };
}
