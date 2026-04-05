export interface GraphVisualizationResult {
  url: string;
  port: number;
  message: string;
}

export interface GraphVizServerOptions {
  port?: number;
  repoRoot: string;
  openBrowser?: boolean;
}
