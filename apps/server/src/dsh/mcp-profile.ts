import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Install the local Spec Agent MCP tool server into a DSH profile.
 *
 * The profile gets the mcp-client bundle plus a patch entry that spawns
 * `spec-agent-tools.mjs` with the current organization root. Only agent
 * creation/listing tools are exposed; project file tools stay untouched.
 */
export function prepareMcpToolsPatch(
  dshHome: string,
  script: string,
  orgRoot: string,
  projectId: string,
  serverUrl: string,
): string | undefined {
  if (!existsSync(script)) return undefined;
  const require = createRequire(import.meta.url);
  try {
    const mcpPackage = require.resolve(
      '@deepseek-ai/dsh-mcp-client/package.json',
    );
    const profileDir = join(dshHome, 'profiles', 'sdk');
    const packageFile = join(profileDir, 'package.json');
    mkdirSync(profileDir, { recursive: true });
    let manifest: {
      name?: string;
      private?: boolean;
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    } = {
      name: 'dsh-profile-sdk',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-sdk-app',
          ],
        },
      },
    };
    if (existsSync(packageFile)) {
      manifest = JSON.parse(
        readFileSync(packageFile, 'utf8'),
      ) as typeof manifest;
    }
    manifest.dependencies = manifest.dependencies ?? {};
    manifest.dependencies['@deepseek-ai/dsh-mcp-client'] = '0.2.1-rc.5';
    manifest.dsh = manifest.dsh ?? {};
    manifest.dsh.profile = manifest.dsh.profile ?? {};
    const bundles = (manifest.dsh.profile.bundles ?? []).filter(
      (bundle) => bundle !== '@deepseek-ai/dsh-mcp-client',
    );
    manifest.dsh.profile.bundles = bundles;
    writeFileSync(
      packageFile,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    if (!existsSync(join(profileDir, 'cordis.yml'))) {
      writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
    }
    const link = join(
      profileDir,
      'node_modules',
      '@deepseek-ai',
      'dsh-mcp-client',
    );
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) {
      symlinkSync(dirname(mcpPackage), link, 'junction');
    }

    const patchPath = join(dshHome, 'mcp-tools.patch.yml');
    writeFileSync(
      patchPath,
      [
        '# Spec Agent MCP tools: organization agent actions only.',
        '- insert:',
        '    - id: mcp-client',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: spec_agent',
        `        command: ${JSON.stringify(process.execPath)}`,
        '        args:',
        `          - ${JSON.stringify(script)}`,
        '        env:',
        `          SPEC_AGENT_ROOT: ${JSON.stringify(orgRoot)}`,
        `          SPEC_AGENT_PROJECT_ID: ${JSON.stringify(projectId)}`,
        `          SPEC_AGENT_SERVER_URL: ${JSON.stringify(serverUrl)}`,
        `        cwd: ${JSON.stringify(orgRoot)}`,
        '        toolCallTimeoutMs: 15000',
        '        failOnStartupError: false',
        '',
      ].join('\n'),
      'utf8',
    );
    return patchPath;
  } catch (error) {
    console.warn(
      '[mcp-profile] install failed:',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
