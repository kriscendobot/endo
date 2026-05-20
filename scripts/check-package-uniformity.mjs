#!/usr/bin/env zx
/**
 * @file Enforce uniformity of metadata files across every workspace
 * package using packages/skel/ as the template.
 *
 * The checks (all fail closed; non-zero exit on any drift):
 *
 *   1. SECURITY.md is byte-identical to packages/skel/SECURITY.md.
 *   2. LICENSE matches packages/skel/LICENSE modulo the copyright line.
 *      The copyright line must match either the skel placeholder
 *      "Copyright [yyyy] [name of copyright owner]" or the filled form
 *      "Copyright <YYYY> Endo Contributors". This preserves the existing
 *      scripts/set-license-text.sh convention of stamping the package's
 *      creation year into its LICENSE.
 *   3. package.json fields:
 *      - author              matches skel
 *      - license             matches skel
 *      - type                matches skel
 *      - repository.type     matches skel
 *      - repository.url      matches skel
 *      - repository.directory == "packages/<dir>"
 *      - name                ends with "/<dir>" (after the @endo scope)
 *                            or equals "<dir>" for unscoped historical names
 *      - bugs.url            matches skel
 *      - publishConfig.access == "public" (only for packages whose
 *                                          private flag is not true)
 *      - description         is non-empty AND not equal to skel's
 *                            description (skel itself is exempt; skel's
 *                            null value is the placeholder this check
 *                            forbids elsewhere)
 *   4. tsconfig.json (only checked for packages that ship one):
 *      - .extends             matches packages/skel/tsconfig.json's value
 *                             (the canonical eslint-base extension chain).
 *      - .include             matches packages/skel/tsconfig.json's array
 *                             exactly (deep-equality).
 *      .compilerOptions and .exclude are unrestricted: legitimate per-package
 *      variation lives there (e.g., checkJs: false for relaxed checking).
 *   5. tsconfig.build.json (only checked for packages that ship one):
 *      - .extends             matches packages/skel/tsconfig.build.json
 *                             exactly (the build-options extension chain).
 *      .exclude and .compilerOptions are unrestricted: per-package test/demo
 *      exclusions are expected.
 *
 *   The tsconfig checks exist because PR endojs/endo#3270 was opened to fix
 *   a class of drift where a package's tsconfig.json diverged from skel's
 *   include shape in a way that broke composite builds (e.g., using
 *   "src/**\/*.js","src/**\/*.ts" instead of the canonical "src" directory
 *   shorthand). Catching that drift in CI prevents the same class of break
 *   from recurring silently.
 *
 *   The tsconfig EXCEPTIONS allowlist lets specific packages override the
 *   include or extends invariant with a documented reason (e.g.,
 *   eslint-plugin's CommonJS layout, packages with extra source roots
 *   like "scripts" or "src-xs"); see TSCONFIG_INCLUDE_EXCEPTIONS below.
 *
 * The skel package is the source of truth and is exempt from the
 * description differs-from-skel check (since skel defines the default
 * the check forbids).
 *
 * This is the JavaScript port of the original scripts/check-package-uniformity.sh
 * (zx-flavored per the workspace's preference for JS over shell for new
 * enforcement scripts).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const SKEL_REL = 'packages/skel';
const SKEL_ABS = path.join(repoRoot, SKEL_REL);

let exitCode = 0;

/**
 * Report a finding and mark exit non-zero. The message shape mirrors the
 * original shell script: "<pkg>: <what differs>".
 *
 * @param {string} message
 */
const fail = message => {
  console.log(message);
  exitCode = 1;
};

/**
 * @param {string} absPath
 * @returns {Promise<string>}
 */
const sha256OfFile = async absPath => {
  const buf = await readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
};

/**
 * sha256 of LICENSE body with the canonical copyright line stripped.
 * The shell script does `grep -v '^   Copyright ' LICENSE | sha256sum`.
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
const sha256OfLicenseModuloCopyright = async absPath => {
  const text = await readFile(absPath, 'utf8');
  const lines = text.split('\n');
  const filtered = lines.filter(line => !line.startsWith('   Copyright '));
  return createHash('sha256').update(filtered.join('\n')).digest('hex');
};

/**
 * Extract a value at a dotted path from a parsed object, returning '' for any
 * missing intermediate or final value. Mirrors `jq -r '<path> // ""'`.
 *
 * @param {unknown} obj
 * @param {string} dottedPath e.g. ".repository.url"
 * @returns {string}
 */
const fieldAt = (obj, dottedPath) => {
  const parts = dottedPath.replace(/^\./, '').split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return '';
    cursor = /** @type {Record<string, unknown>} */ (cursor)[part];
  }
  if (cursor == null) return '';
  return String(cursor);
};

/**
 * Known historical exceptions: <pkg>:<jq-path>:<allowed-value>.
 *
 * Each entry permits one specific package.json field to deviate from the
 * skel value for a documented reason. Keep this list small and named;
 * every entry needs a comment explaining why.
 */
const EXCEPTIONS = [
  // eslint-plugin is a CommonJS plugin for ESLint v8 (it consumes
  // requireindex and uses __dirname / module.exports). Migrating it
  // to ESM is a substantial refactor; until that lands, the package
  // legitimately ships without a 'type' field (effectively commonjs).
  'packages/eslint-plugin:.type:',
];

/**
 * Per-package tsconfig.json .include overrides. Each entry names a
 * package and the exact include array that package is permitted to
 * ship in place of skel's canonical ["*.js", "*.ts", "src", "test"].
 *
 * Adding an entry requires a comment explaining why the package needs a
 * different include shape. Keep this list small. The intent is to catch
 * the drift class endojs/endo#3270 fixed (packages using
 * "src/**\/*.js","src/**\/*.ts" instead of "src", which broke composite
 * builds) while permitting deliberate per-package deviations.
 *
 * @type {Array<{ pkg: string; include: string[] }>}
 */
const TSCONFIG_INCLUDE_EXCEPTIONS = [
  // eslint-plugin is a CommonJS ESLint v8 plugin with source under lib/
  // (consumes requireindex). No src/ directory; no .ts sources.
  { pkg: 'packages/eslint-plugin', include: ['lib/**/*.js', 'test'] },
  // goblin-chat ships an executable under bin/ alongside src/ and test/.
  {
    pkg: 'packages/goblin-chat',
    include: ['*.js', '*.ts', 'bin', 'src', 'test'],
  },
  // cli ships a demo/ alongside src/ and test/.
  { pkg: 'packages/cli', include: ['*.js', '*.ts', 'demo', 'src', 'test'] },
  // import-bundle ships a demo/ alongside src/ and test/.
  {
    pkg: 'packages/import-bundle',
    include: ['*.js', '*.ts', 'demo', 'src', 'test'],
  },
  // nat ships a scripts/ folder of release helpers alongside src/ and test/.
  { pkg: 'packages/nat', include: ['*.js', '*.ts', 'scripts', 'src', 'test'] },
  // ses ships scripts/ and src-xs/ (XS-shim variants) alongside src/ and test/.
  {
    pkg: 'packages/ses',
    include: ['*.js', '*.ts', 'scripts', 'src', 'src-xs', 'test'],
  },
  // module-source ships scripts/ and src-xs/ alongside src/, plus a narrow
  // test glob ("test/*.*") that intentionally omits test/fixtures/.
  {
    pkg: 'packages/module-source',
    include: ['*.js', '*.ts', 'scripts', 'src', 'src-xs', 'test/*.*'],
  },
  // test262-runner ships a scripts/ folder alongside src/ and test/.
  {
    pkg: 'packages/test262-runner',
    include: ['*.js', '*.ts', 'scripts', 'src', 'test'],
  },
  // compartment-mapper ships a demo/ alongside src/ and test/, and uses
  // an explicit src/**/*.{js,ts} glob paired with "exclude": ["**/*.d.ts"]
  // to deliberately omit the package's hand-written .d.ts files from the
  // type-check pass. Replacing this with bare "src" would re-include
  // those .d.ts files; the deviation is intentional.
  {
    pkg: 'packages/compartment-mapper',
    include: ['*.js', '*.ts', 'demo', 'src/**/*.js', 'src/**/*.ts', 'test'],
  },
];

/**
 * Look up a per-package tsconfig.json .include override.
 *
 * @param {string} pkg
 * @returns {string[] | undefined}
 */
const tsconfigIncludeException = pkg => {
  const entry = TSCONFIG_INCLUDE_EXCEPTIONS.find(e => e.pkg === pkg);
  return entry ? entry.include : undefined;
};

/**
 * @param {string} pkg
 * @param {string} path
 * @param {string} actual
 */
const isException = (pkg, path, actual) =>
  EXCEPTIONS.includes(`${pkg}:${path}:${actual}`);

/**
 * Strip JSONC features (line comments and trailing commas) to make a
 * tsconfig parseable by JSON.parse. TypeScript itself tolerates these
 * but JSON.parse does not. Block comments (slash-star) are not stripped
 * because none of the current tsconfigs use them; introducing one would
 * trigger a clear parse error here.
 *
 * @param {string} text
 * @returns {string}
 */
const stripJsonc = text => {
  // Remove line comments. We do the simple thing because tsconfigs are
  // small and well-formed: walk the string, track whether we are inside
  // a string literal, and drop everything from '//' to end-of-line when
  // we are not.
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      // skip to end of line, preserving the newline
      while (i < text.length && text[i] !== '\n') i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  // Strip trailing commas before ] or } (allowing whitespace in between).
  return out.replace(/,(\s*[\]}])/g, '$1');
};

/**
 * Deep equality on JSON-shaped values.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const ak = Object.keys(/** @type {object} */ (a)).sort();
    const bk = Object.keys(/** @type {object} */ (b)).sort();
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k, i) =>
        k === bk[i] &&
        deepEqual(
          /** @type {Record<string, unknown>} */ (a)[k],
          /** @type {Record<string, unknown>} */ (b)[k],
        ),
    );
  }
  return false;
};

/**
 * @param {string} pkg
 * @param {object} json parsed package.json
 * @param {string} path dotted jq-style path
 * @param {string} expected expected value (as a string; '' for absent)
 */
const assertField = (pkg, json, path, expected) => {
  const actual = fieldAt(json, path);
  if (actual !== expected) {
    if (isException(pkg, path, actual)) return;
    fail(
      `${pkg}: package.json ${path} expected '${expected}' actual '${actual}'`,
    );
  }
};

const main = async () => {
  // Source-of-truth values harvested from skel once.
  const skelSecuritySha = await sha256OfFile(
    path.join(SKEL_ABS, 'SECURITY.md'),
  );
  const skelLicenseNoCopy = await sha256OfLicenseModuloCopyright(
    path.join(SKEL_ABS, 'LICENSE'),
  );
  const skelPackage = JSON.parse(
    await readFile(path.join(SKEL_ABS, 'package.json'), 'utf8'),
  );
  const skelAuthor = fieldAt(skelPackage, '.author');
  const skelLicenseField = fieldAt(skelPackage, '.license');
  const skelType = fieldAt(skelPackage, '.type');
  const skelRepoType = fieldAt(skelPackage, '.repository.type');
  const skelRepoUrl = fieldAt(skelPackage, '.repository.url');
  const skelBugsUrl = fieldAt(skelPackage, '.bugs.url');
  const skelDescription = fieldAt(skelPackage, '.description');

  // Collect every workspace package (every packages/<dir>/package.json),
  // sorted to match the shell script's `find ... | sort` order.
  const packagesDir = path.join(repoRoot, 'packages');
  const dirents = await readdir(packagesDir, { withFileTypes: true });
  /** @type {string[]} */
  const pkgs = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const pkgRel = `packages/${dirent.name}`;
    try {
      await stat(path.join(repoRoot, pkgRel, 'package.json'));
      pkgs.push(pkgRel);
    } catch {
      // No package.json in this directory; skip it (matches the shell
      // script's `find -name 'package.json'` filter).
    }
  }
  pkgs.sort();

  // --- SECURITY.md byte-identical to skel --------------------------------
  for (const pkg of pkgs) {
    const securityPath = path.join(repoRoot, pkg, 'SECURITY.md');
    try {
      await stat(securityPath);
    } catch {
      fail(`${pkg}: missing SECURITY.md`);
      continue;
    }
    const hash = await sha256OfFile(securityPath);
    if (hash !== skelSecuritySha) {
      fail(
        `${pkg}: SECURITY.md differs from ${SKEL_REL}/SECURITY.md (sha256 ${hash} vs ${skelSecuritySha})`,
      );
    }
  }

  // --- LICENSE matches skel modulo the copyright line --------------------
  for (const pkg of pkgs) {
    const licensePath = path.join(repoRoot, pkg, 'LICENSE');
    try {
      await stat(licensePath);
    } catch {
      fail(`${pkg}: missing LICENSE`);
      continue;
    }
    const noCopyHash = await sha256OfLicenseModuloCopyright(licensePath);
    if (noCopyHash !== skelLicenseNoCopy) {
      fail(
        `${pkg}: LICENSE body differs from ${SKEL_REL}/LICENSE (ignoring copyright line)`,
      );
      continue;
    }
    const licenseText = await readFile(licensePath, 'utf8');
    const copyLine =
      licenseText.split('\n').find(line => line.startsWith('   Copyright ')) ||
      '';
    if (
      !/^ {3}Copyright (\[yyyy\] \[name of copyright owner\]|[0-9]{4} Endo Contributors)$/.test(
        copyLine,
      )
    ) {
      fail(`${pkg}: LICENSE copyright line not canonical: ${copyLine}`);
    }
  }

  // --- package.json field uniformity -------------------------------------
  for (const pkg of pkgs) {
    const jsonPath = path.join(repoRoot, pkg, 'package.json');
    const dirName = path.basename(pkg);
    const json = JSON.parse(await readFile(jsonPath, 'utf8'));

    assertField(pkg, json, '.author', skelAuthor);
    assertField(pkg, json, '.license', skelLicenseField);
    assertField(pkg, json, '.type', skelType);
    assertField(pkg, json, '.repository.type', skelRepoType);
    assertField(pkg, json, '.repository.url', skelRepoUrl);
    assertField(pkg, json, '.repository.directory', `packages/${dirName}`);
    assertField(pkg, json, '.bugs.url', skelBugsUrl);

    // name: either "@<scope>/<dir>" or unscoped "<dir>".
    const actualName = fieldAt(json, '.name');
    if (actualName !== dirName && !actualName.endsWith(`/${dirName}`)) {
      fail(
        `${pkg}: package.json .name '${actualName}' does not end with directory '${dirName}'`,
      );
    }

    // publishConfig.access: required to be "public" for non-private
    // packages.
    const isPrivate = fieldAt(json, '.private') === 'true';
    if (!isPrivate) {
      assertField(pkg, json, '.publishConfig.access', 'public');
    }

    // description: non-empty and not equal to skel's default. Skel itself
    // is exempt because skel defines the default the check forbids.
    if (pkg !== SKEL_REL) {
      const actualDesc = fieldAt(json, '.description');
      if (actualDesc === '') {
        fail(`${pkg}: package.json .description is empty`);
      } else if (actualDesc === skelDescription) {
        fail(
          `${pkg}: package.json .description matches skel's default ('${skelDescription}')`,
        );
      }
    }
  }

  // --- tsconfig.json uniformity against skel -----------------------------
  // PR endojs/endo#3270 was opened to fix a class of drift where a
  // package's tsconfig.json .include diverged from skel in a way that
  // broke composite builds. This check catches that class going forward.
  const skelTsconfig = JSON.parse(
    stripJsonc(await readFile(path.join(SKEL_ABS, 'tsconfig.json'), 'utf8')),
  );
  const skelTsconfigBuild = JSON.parse(
    stripJsonc(
      await readFile(path.join(SKEL_ABS, 'tsconfig.build.json'), 'utf8'),
    ),
  );

  for (const pkg of pkgs) {
    if (pkg === SKEL_REL) continue;

    const tsconfigPath = path.join(repoRoot, pkg, 'tsconfig.json');
    let tsconfig;
    try {
      tsconfig = JSON.parse(stripJsonc(await readFile(tsconfigPath, 'utf8')));
    } catch (err) {
      if (err && /** @type {{code?: string}} */ (err).code === 'ENOENT') {
        // Packages without a tsconfig.json are not subject to the check.
        continue;
      }
      fail(
        `${pkg}: tsconfig.json parse error: ${/** @type {Error} */ (err).message}`,
      );
      continue;
    }

    if (!deepEqual(tsconfig.extends, skelTsconfig.extends)) {
      fail(
        `${pkg}: tsconfig.json .extends differs from skel (expected ${JSON.stringify(skelTsconfig.extends)}, actual ${JSON.stringify(tsconfig.extends)})`,
      );
    }

    const expectedInclude =
      tsconfigIncludeException(pkg) || skelTsconfig.include;
    if (!deepEqual(tsconfig.include, expectedInclude)) {
      fail(
        `${pkg}: tsconfig.json .include differs from skel (expected ${JSON.stringify(expectedInclude)}, actual ${JSON.stringify(tsconfig.include)})`,
      );
    }
  }

  // --- tsconfig.build.json uniformity against skel -----------------------
  for (const pkg of pkgs) {
    if (pkg === SKEL_REL) continue;

    const buildPath = path.join(repoRoot, pkg, 'tsconfig.build.json');
    let buildConfig;
    try {
      buildConfig = JSON.parse(stripJsonc(await readFile(buildPath, 'utf8')));
    } catch (err) {
      if (err && /** @type {{code?: string}} */ (err).code === 'ENOENT') {
        // Packages without a tsconfig.build.json are not subject to the check.
        continue;
      }
      fail(
        `${pkg}: tsconfig.build.json parse error: ${/** @type {Error} */ (err).message}`,
      );
      continue;
    }

    if (!deepEqual(buildConfig.extends, skelTsconfigBuild.extends)) {
      fail(
        `${pkg}: tsconfig.build.json .extends differs from skel (expected ${JSON.stringify(skelTsconfigBuild.extends)}, actual ${JSON.stringify(buildConfig.extends)})`,
      );
    }
  }

  process.exit(exitCode);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
