/**
 * Browser stub for node-fetch — use global fetch/Headers/Request/Response
 * so esbuild can bundle the RWA adapter for browser without Node builtins.
 */
export default typeof fetch !== 'undefined' ? fetch : undefined;
export const Headers = typeof Headers !== 'undefined' ? Headers : undefined;
export const Request = typeof Request !== 'undefined' ? Request : undefined;
export const Response = typeof Response !== 'undefined' ? Response : undefined;
