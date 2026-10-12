import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Executable, LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

/** The binary an editor runs, and where it came from. */
interface Server {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

let client: LanguageClient | undefined;

/**
 * Where the splash-lsp binary is.
 *
 * An editor integration is only as good as its discovery: a linter nobody can
 * start is a linter nobody uses. In order: the setting, the environment, the
 * PATH, then the Octoscript-Makepad checkouts beside the workspace — the same
 * places `octo` looks for the tools it wraps.
 */
function resolveServer(): Server | undefined {
  const configured = vscode.workspace.getConfiguration('splashCheck').get<string>('serverPath');
  if (configured && configured.trim().length > 0) {
    return { command: configured.trim(), args: [] };
  }
  const fromEnv = process.env.SPLASH_LSP;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { command: fromEnv, args: [] };
  }
  const exe = process.platform === 'win32' ? 'splash-lsp.exe' : 'splash-lsp';
  const onPath = findOnPath(exe);
  if (onPath) {
    return { command: onPath, args: [] };
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const candidate of [
      path.join(folder.uri.fsPath, '..', 'makepad', 'target', 'release'),
      path.join(folder.uri.fsPath, '..', 'Octoscript-Makepad', 'target', 'release'),
      path.join(folder.uri.fsPath, 'makepad', 'target', 'release'),
    ]) {
      const binary = path.join(candidate, exe);
      if (fs.existsSync(binary)) {
        return { command: binary, args: [] };
      }
    }
  }
  return undefined;
}

function findOnPath(exe: string): string | undefined {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Tell the user, once, that the checker is not running — and what to do. */
function explainMissingServer() {
  void vscode.window.showWarningMessage(
    'Splash Check: splash-lsp was not found. Build it in an Octoscript-Makepad checkout ' +
      '(cargo build --release -p makepad-widgets --bin splash-lsp --features maps) and set ' +
      '"splashCheck.serverPath", $SPLASH_LSP, or put it on your PATH.',
    'Open Settings',
  ).then((choice) => {
    if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'splashCheck');
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const server = resolveServer();
  if (!server) {
    explainMissingServer();
    // A configuration change may supply what was missing; restart the client
    // when the setting moves, so the user does not have to reload the window.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('splashCheck.serverPath')) {
          void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        }
      }),
    );
    return;
  }

  // The debounce is a server-side setting, passed through the environment so
  // the binary needs no configuration file.
  const debounceMs = vscode.workspace.getConfiguration('splashCheck').get<number>('debounceMs', 300);
  const run: Executable = {
    command: server.command,
    args: server.args,
    options: { env: { ...process.env, ...(server.env ?? {}), SPLASH_LSP_DEBOUNCE_MS: String(debounceMs) } },
  };
  const serverOptions: ServerOptions = { run, debug: { command: server.command, args: server.args, options: run.options } };

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

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
  }
}
