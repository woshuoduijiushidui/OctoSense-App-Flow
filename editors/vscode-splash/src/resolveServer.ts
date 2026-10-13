import * as path from 'path';

/**
 * Where the splash-lsp server comes from, as one strategy over injected inputs.
 *
 * An editor integration is only as good as its discovery: a linter nobody can
 * start is a linter nobody uses. ADR 0003 §2 makes the whole strategy a single
 * function whose inputs are all injected — the setting, the environment, the
 * PATH, the sibling checkouts, and (its last source) the download — so the
 * priority chain is decided by code that touches nothing, and the caller
 * performs the effects. The download is last because everything before it is a
 * local statement of intent: a person who set a path, exported a variable, or
 * has the fork checked out beside the workspace means that build.
 */

/** The binary an editor runs. */
export interface Server {
  command: string;
  args: string[];
}

/**
 * The platforms a release asset exists for, as `platform-arch` → the target
 * the release workflow builds. Today win32/x64 alone, because the workflow's
 * matrix builds windows-latest alone; a platform the matrix gains is a new
 * entry here beside the record's own `platforms` entry, and until then the
 * notice says "no server for this platform yet" rather than "download failed".
 */
const RELEASE_TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
};

/** The repository that holds the server release (tools/splash-server-toolchain.json). */
const RELEASE_REPOSITORY = 'woshuoduijiushidui/OctoSense-App-Flow';

/** Which source a resolved server came from, in the chain's priority order. */
export type ServerSource = 'setting' | 'environment' | 'path' | 'sibling' | 'download';

/** Why no server could be produced. Each is a different sentence to the user. */
export type UnavailableReason =
  | { kind: 'no-server' }
  | { kind: 'unsupported-platform'; platform: string; arch: string }
  | { kind: 'download-failed'; cause: string };

export type Resolution =
  | { status: 'found'; server: Server; source: ServerSource }
  | { status: 'unavailable'; reason: UnavailableReason };

/** Fetches `url` and leaves the runnable binary at `destination`; rejects with the cause. */
export type Downloader = (url: string, destination: string) => Promise<void>;

/** The download source: a pinned version's asset, cached under its own name. */
export interface Download {
  fetch: Downloader;
  cacheDir: string;
}

export interface ResolveInputs {
  /** The `splashCheck.serverPath` setting, raw. */
  setting: string | undefined;
  /** The environment: `SPLASH_LSP` and `PATH`. */
  env: Record<string, string | undefined>;
  /** The workspace folders, for sibling checkouts. */
  workspaceFolders: readonly string[];
  /** The only filesystem this strategy touches. */
  exists: (candidate: string) => boolean;
  /** The host's platform and architecture, as `process.platform` and `process.arch` report them. */
  platform: string;
  arch: string;
  /** The pinned server version, already overridden by the workspace setting. */
  version: string;
  /** The download source; absent, the chain is the four local sources alone. */
  download?: Download;
}

export async function resolveServer(inputs: ResolveInputs): Promise<Resolution> {
  const fromSetting = resolveFromSetting(inputs);
  if (fromSetting) {
    return { status: 'found', server: fromSetting, source: 'setting' };
  }
  const fromEnvironment = resolveFromEnvironment(inputs);
  if (fromEnvironment) {
    return { status: 'found', server: fromEnvironment, source: 'environment' };
  }
  const fromPath = resolveFromPath(inputs);
  if (fromPath) {
    return { status: 'found', server: fromPath, source: 'path' };
  }
  const fromSibling = resolveFromSibling(inputs);
  if (fromSibling) {
    return { status: 'found', server: fromSibling, source: 'sibling' };
  }
  return resolveByDownload(inputs);
}

/**
 * The last source: the platform binary for the pinned version, downloaded from
 * this repository's own release.
 *
 * A platform no asset was published for is not a failed download — it is a
 * server that was never built for it, and the notice has to say which of the
 * two happened (ADR 0003 §5). A download that fails is a missing feature, not
 * a broken install: the resolution is the same "unavailable" the chain alone
 * would have given, now carrying the cause, and this function does not throw
 * (ADR 0003 §4).
 */
async function resolveByDownload(inputs: ResolveInputs): Promise<Resolution> {
  const download = inputs.download;
  if (!download) {
    return { status: 'unavailable', reason: { kind: 'no-server' } };
  }
  const target = RELEASE_TARGETS[`${inputs.platform}-${inputs.arch}`];
  if (!target) {
    return {
      status: 'unavailable',
      reason: { kind: 'unsupported-platform', platform: inputs.platform, arch: inputs.arch },
    };
  }
  // The asset is named for the server and the platform it runs on, and the tag
  // for the version — the naming tools/splash_server_release.py publishes
  // under, so a download says which of two servers it just got.
  const asset = `splash-lsp-${inputs.version}-${target}.zip`;
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/splash-lsp-v${inputs.version}/${asset}`;
  // The version names the directory and the archive's own entry name is kept,
  // so extracting the asset leaves something runnable without a rename — and a
  // version bump is a new directory, which re-downloads.
  const destination = path.join(download.cacheDir, `splash-lsp-${inputs.version}`, executableName(inputs.platform));
  try {
    await download.fetch(url, destination);
  } catch (error) {
    return { status: 'unavailable', reason: { kind: 'download-failed', cause: causeOf(error) } };
  }
  return { status: 'found', server: { command: destination, args: [] }, source: 'download' };
}

export function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveFromSetting(inputs: ResolveInputs): Server | undefined {
  const configured = inputs.setting?.trim();
  // The setting has to point at something. A path that is not there is not a
  // statement of intent: it is a value that was mangled on its way in — a
  // Windows path typed with single backslashes, or one a JSON layer escaped
  // once and delivered with its separators eaten — and returning it anyway
  // produces the worst symptom in ADR 0003, an extension that activates, finds
  // nothing where the path points, and silently degrades to highlighting. A
  // setting that resolves behaves exactly as it always has; this is the
  // difference for the one that cannot.
  if (configured && configured.length > 0 && inputs.exists(configured)) {
    return { command: configured, args: [] };
  }
  return undefined;
}

function resolveFromEnvironment(inputs: ResolveInputs): Server | undefined {
  const fromEnv = inputs.env.SPLASH_LSP;
  if (fromEnv && inputs.exists(fromEnv)) {
    return { command: fromEnv, args: [] };
  }
  return undefined;
}

function resolveFromPath(inputs: ResolveInputs): Server | undefined {
  const exe = executableName(inputs.platform);
  const directories = (inputs.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, exe);
    if (inputs.exists(candidate)) {
      return { command: candidate, args: [] };
    }
  }
  return undefined;
}

function resolveFromSibling(inputs: ResolveInputs): Server | undefined {
  const exe = executableName(inputs.platform);
  for (const folder of inputs.workspaceFolders) {
    for (const candidate of [
      path.join(folder, '..', 'makepad', 'target', 'release'),
      path.join(folder, '..', 'Octoscript-Makepad', 'target', 'release'),
      path.join(folder, 'makepad', 'target', 'release'),
    ]) {
      const binary = path.join(candidate, exe);
      if (inputs.exists(binary)) {
        return { command: binary, args: [] };
      }
    }
  }
  return undefined;
}

function executableName(platform: string): string {
  return platform === 'win32' ? 'splash-lsp.exe' : 'splash-lsp';
}
