import * as fs from 'fs';
import * as vscode from 'vscode';
import { Executable, LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { resolveServer, type Server, type UnavailableReason } from './resolveServer';
import { downloadServer } from './serverDownload';

let client: LanguageClient | undefined;

/** The notices already shown this session: one per reason, never one per document. */
const noticedReasons = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Registered before anything else, and in both outcomes: a serverPath that
  // moves must restart the extension host, or a stale value stays cached in
  // the running host and the client keeps spawning the path that used to be
  // there. That is not hypothetical — it is how a mangled setting survived a
  // fix. The pinned version moves for the same reason.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('splashCheck.serverPath') ||
        event.affectsConfiguration('splashCheck.serverVersion')
      ) {
        void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      }
    }),
  );

  const configuration = vscode.workspace.getConfiguration('splashCheck');
  const resolution = await resolveServer({
    setting: configuration.get<string>('serverPath'),
    env: process.env,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    exists: (candidate) => fs.existsSync(candidate),
    platform: process.platform,
    arch: process.arch,
    version: pinnedVersion(configuration, context),
    // The download is the strategy's last source; a person who installs the
    // plugin on a fresh VS Code gets the server this way, with nothing built
    // locally (ADR 0003 §1).
    download: { cacheDir: context.globalStorageUri.fsPath, fetch: downloadServer },
  });

  if (resolution.status === 'unavailable') {
    explainUnavailable(resolution.reason);
    // Degraded mode, not a dead plugin: the grammar still highlights, and
    // activation neither throws nor leaves a half-registered client behind.
    return;
  }

  await startClient(context, resolution.server);
}

/**
 * The server version to fetch: the manifest's constant, unless the workspace
 * setting overrides it — a person testing a local build of the server against
 * a released plugin (ADR 0003 §3). Nothing floats: no "latest", no range.
 */
function pinnedVersion(
  configuration: vscode.WorkspaceConfiguration,
  context: vscode.ExtensionContext,
): string {
  const configured = configuration.get<string>('serverVersion');
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  const manifest = context.extension.packageJSON as { splashCheck?: { serverVersion?: string } };
  return manifest.splashCheck?.serverVersion ?? '';
}

async function startClient(context: vscode.ExtensionContext, server: Server): Promise<void> {
  // The debounce is a server-side setting, passed through the environment so
  // the binary needs no configuration file.
  const debounceMs = vscode.workspace.getConfiguration('splashCheck').get<number>('debounceMs', 300);
  const run: Executable = {
    command: server.command,
    args: server.args,
    options: { env: { ...process.env, SPLASH_LSP_DEBOUNCE_MS: String(debounceMs) } },
  };
  const serverOptions: ServerOptions = {
    run,
    debug: { command: server.command, args: server.args, options: run.options },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'splash' }],
    synchronize: { configurationSection: 'splashCheck' },
    outputChannelName: 'Splash Check',
  };

  client = new LanguageClient('splashCheck', 'Splash Check', serverOptions, clientOptions);
  context.subscriptions.push(client);
  try {
    await client.start();
  } catch (error) {
    void vscode.window.showErrorMessage(`Splash Check failed to start: ${String(error)}`);
  }
}

/**
 * One notice, one explanation, and a fallback — never a dead plugin (ADR
 * 0003 §4). The notice fires once per session per reason; the output channel
 * carries the cause and the manual build path, so the person who wants to
 * self-serve can without a round trip through a search engine.
 */
function explainUnavailable(reason: UnavailableReason): void {
  const channel = vscode.window.createOutputChannel('Splash Check');
  channel.appendLine('Splash Check: the splash-lsp server is unavailable, so only highlighting is active.');
  channel.appendLine(`Cause: ${explanation(reason).cause}`);
  channel.appendLine('To build the server yourself:');
  channel.appendLine('  cargo build --release -p makepad-widgets --bin splash-lsp --features maps');
  channel.appendLine('Then point the extension at it: "splashCheck.serverPath", $SPLASH_LSP, or your PATH.');

  if (noticedReasons.has(reason.kind)) {
    return;
  }
  noticedReasons.add(reason.kind);
  void vscode.window
    .showWarningMessage(`${explanation(reason).notice} See the output channel.`, 'Show Output')
    .then((choice) => {
      if (choice === 'Show Output') {
        channel.show();
      }
    });
}

/** The two sentences each reason needs: one for the notice, one for the channel. */
function explanation(reason: UnavailableReason): { notice: string; cause: string } {
  switch (reason.kind) {
    case 'unsupported-platform':
      return {
        notice: `Splash Check: no splash-lsp build for ${reason.platform} (${reason.arch}) yet — highlighting only.`,
        cause: `no splash-lsp release asset is published for ${reason.platform} (${reason.arch}) yet`,
      };
    case 'download-failed':
      return {
        notice: 'Splash Check: could not download the splash-lsp server — highlighting only.',
        cause: `the download failed: ${reason.cause}`,
      };
    case 'no-server':
      return {
        notice: 'Splash Check: no splash-lsp server was found — highlighting only.',
        cause:
          'no splash-lsp in the setting, the environment, the PATH or a sibling checkout, and no download was configured',
      };
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled unavailable reason: ${JSON.stringify(unhandled)}`);
    }
  }
}
