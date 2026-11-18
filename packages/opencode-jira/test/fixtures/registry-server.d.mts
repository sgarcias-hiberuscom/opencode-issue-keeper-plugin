export interface RegistryServerOptions {
  /** Serve a 404 packument so the requested version is missing. */
  missing?: boolean;
  /** Omit dist.integrity so the installer's own integrity check must reject. */
  wrongIntegrity?: boolean;
  /** Serve a packument with a different package name. */
  otherName?: boolean;
  /** Cut the tarball response short. */
  truncate?: boolean;
}

export interface RegistryServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export declare function startRegistryServer(tarballPath: string, options?: RegistryServerOptions): Promise<RegistryServerHandle>;
