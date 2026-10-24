import assert from 'node:assert/strict';
import { it } from 'node:test';
import { modelTransportArgs } from '../src/provider/model-transport.js';

function toolServerEnv(): Record<string, string> {
  const args = modelTransportArgs('store', 'work', 'prompt', 'model');
  return JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.amabie_confined.env;
}

it('carries the operator-selected PowerShell Core host to the confined tool server', () => {
  const saved = process.env.AMABIE_POWERSHELL_CORE_PATH;
  process.env.AMABIE_POWERSHELL_CORE_PATH = 'C:\\Tools\\pwsh\\pwsh.exe';
  try {
    // MEASURED: without it every model tool call fell back to Windows PowerShell 5.1, which crashes
    // with 0xC0000005 on hosts that need Core, while the transport's own preflight (Core) passed.
    assert.equal(toolServerEnv().AMABIE_POWERSHELL_CORE_PATH, 'C:\\Tools\\pwsh\\pwsh.exe');
  } finally {
    if (saved === undefined) delete process.env.AMABIE_POWERSHELL_CORE_PATH;
    else process.env.AMABIE_POWERSHELL_CORE_PATH = saved;
  }
});

it('carries the opt-in confined-check flag to the tool server and leaves it off by default', () => {
  const saved = process.env.AMABIE_CONFINED_CHECK;
  try {
    delete process.env.AMABIE_CONFINED_CHECK;
    assert.notEqual(toolServerEnv().AMABIE_CONFINED_CHECK, '1');
    process.env.AMABIE_CONFINED_CHECK = '1';
    // MEASURED: the key sat beside `env`, not in it, so worker-tools never saw the flag.
    assert.equal(toolServerEnv().AMABIE_CONFINED_CHECK, '1');
  } finally {
    if (saved === undefined) delete process.env.AMABIE_CONFINED_CHECK;
    else process.env.AMABIE_CONFINED_CHECK = saved;
  }
});

it('still withholds model credentials from the confined tool server', () => {
  const env = toolServerEnv();
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(env.ANTHROPIC_BASE_URL, '');
});
