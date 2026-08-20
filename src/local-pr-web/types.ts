export interface PrWebServerOptions {
  repoRoot: string;
  port?: number;
  openBrowser?: boolean;
}

export interface PrWebServerResult {
  url: string;
  port: number;
  message: string;
}
