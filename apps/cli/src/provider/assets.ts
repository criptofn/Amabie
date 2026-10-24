import path from 'node:path';

// Build-time constant only: callers cannot redirect the trusted toolchain via env.
declare const AMABIE_PACKAGED: boolean;
export const packagedProvider = typeof AMABIE_PACKAGED !== 'undefined' && AMABIE_PACKAGED;
export const providerRoot = path.resolve(import.meta.dirname, packagedProvider ? '..' : '../../../../..');
