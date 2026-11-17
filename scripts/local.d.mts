/** Types for the dependency-free launcher; no TypeScript runtime is required. */
export const projectRoot: string;
export function validateNode(version?: string): void;
export function parseConfiguration(contents: string): {
  config: Record<string, string>;
  origin: string;
  port: number;
};
export function envValue(value: string): string;
export function createEnvironment(input: {
  email: string;
  name: string;
  password: string;
}): string;
export function resolveLocalSchemaEngine(root: string): Promise<string>;
export function npmInstallCommand(platform?: NodeJS.Platform, comspec?: string): [string, string[]];
export function isCrmHealthy(port: number): Promise<boolean>;
export function main(args?: string[], root?: string): Promise<void>;
