// Suite-wide guard: no test may reach live Linear. Loaded by bunfig.toml before any test file.
for (const name of ["LINEAR_API_KEY", "LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET", "LINEAR_OAUTH_REDIRECT_URI"]) {
  delete process.env[name];
}

const realFetch = globalThis.fetch;
const isLinearHost = (host: string) => host === "linear.app" || host.endsWith(".linear.app");

// Belt and braces: linear.app is reachable only through the explicit live-contract opt-in, which
// makeClient() never reads. Any other test that supplies its own key still cannot hit it.
const liveOptIn = Boolean(process.env.LNR_LIVE_CONTRACT_KEY);
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    let host = "";
    try { host = new URL(url).hostname; } catch { /* relative or malformed: not a Linear host */ }
    if (isLinearHost(host) && !liveOptIn) return Promise.reject(new Error(`test guard: network call to ${host} blocked`));
    return realFetch(input, init);
  },
  realFetch,
) as typeof fetch;
