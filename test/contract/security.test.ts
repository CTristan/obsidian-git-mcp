import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, type Fixture } from '../fixture.js';
import { callTool, startServer, textOf, type TestServer } from '../helpers.js';

/** The rejected write never reached the remote — its head is exactly where it was. */
async function expectRemoteUnchanged(fx: Fixture, preRemote: string): Promise<void> {
  expect(await fx.bareHead()).toBe(preRemote);
}

/** The rejected write left no trace in the checkout — nothing staged, nothing dirty. */
async function expectCleanWorkingTree(fx: Fixture): Promise<void> {
  expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
}

/** Commits a symlink from the collaborator clone and pushes it to the remote. */
async function commitSymlink(
  fx: Fixture,
  linkName: string,
  target: string,
  message: string,
): Promise<void> {
  await symlink(target, join(fx.collabDir, linkName));
  await git(['add', '-A'], fx.collabDir);
  await git(['commit', '-m', message], fx.collabDir);
  await git(['push', 'origin', 'main'], fx.collabDir);
}

/** Commits a chain of symlinks (each hop's target becomes the next hop's name) in one push. */
async function commitSymlinkChain(
  fx: Fixture,
  links: ReadonlyArray<readonly [linkName: string, target: string]>,
  message: string,
): Promise<void> {
  for (const [linkName, target] of links) {
    await symlink(target, join(fx.collabDir, linkName));
  }
  await git(['add', '-A'], fx.collabDir);
  await git(['commit', '-m', message], fx.collabDir);
  await git(['push', 'origin', 'main'], fx.collabDir);
}

describe('security', () => {
  let fx: Fixture;
  let srv: TestServer;

  beforeEach(async () => {
    fx = await createFixture();
    srv = await startServer(fx);
  });

  afterEach(async () => {
    await srv.close();
    await fx.cleanup();
  });

  it('path traversal is refused for reads', async () => {
    await writeFile(join(fx.root, 'outside.md'), 'secret outside the vault\n');
    const res = await callTool(srv.client, 'read_note', { path: '../outside.md' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('secret outside the vault');
  });

  it('path traversal is refused for writes', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'write_note', {
      path: '../evil.md',
      content: 'escape attempt\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(join(fx.root, 'evil.md'))).toBe(false);
    await expectRemoteUnchanged(fx, preRemote);
  });

  it('absolute paths are refused for reads and writes', async () => {
    const read = await callTool(srv.client, 'read_note', { path: '/etc/hosts' });
    expect(read.isError).toBe(true);

    const preRemote = await fx.bareHead();
    const outsideTarget = join(fx.outsideDir, 'evil.md');
    const write = await callTool(srv.client, 'write_note', {
      path: outsideTarget,
      content: 'escape attempt\n',
    });
    expect(write.isError).toBe(true);
    expect(existsSync(outsideTarget)).toBe(false);

    const driveForm = await callTool(srv.client, 'write_note', {
      path: 'C:\\evil.md',
      content: 'escape attempt\n',
    });
    expect(driveForm.isError).toBe(true);
    await expectRemoteUnchanged(fx, preRemote);
    await expectCleanWorkingTree(fx);
  });

  it('.obsidian writes are refused at the tool layer', async () => {
    const preRemote = await fx.bareHead();
    const before = await readFile(join(fx.serverDir, '.obsidian', 'app.json'), 'utf8');
    const res = await callTool(srv.client, 'write_note', {
      path: '.obsidian/app.json',
      content: '{"pwned":true}',
    });
    expect(res.isError).toBe(true);
    await expectRemoteUnchanged(fx, preRemote);
    expect(await readFile(join(fx.serverDir, '.obsidian', 'app.json'), 'utf8')).toBe(before);
    await expectCleanWorkingTree(fx);
  });

  it('.obsidian is refused by wrapper-added tools too', async () => {
    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'append_to_section', {
      path: '.obsidian/note.md',
      heading: 'X',
      text: 'y',
    });
    expect(res.isError).toBe(true);
    await expectRemoteUnchanged(fx, preRemote);
    expect(existsSync(join(fx.serverDir, '.obsidian', 'note.md'))).toBe(false);
    await expectCleanWorkingTree(fx);
  });

  it('append_to_section refuses a symlink that escapes the vault', async () => {
    // A committed symlink is legitimate vault content, but following it would write
    // outside the checkout — invisibly to git status, so no commit and no rollback
    // would ever cover the damage.
    const target = join(fx.root, 'outside-target.md');
    await writeFile(target, '# Outside\n\n## X\n\noriginal\n');
    await commitSymlink(fx, 'Linked.md', '../outside-target.md', 'collab: add symlink');

    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Linked.md',
      heading: 'X',
      text: 'injected',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).not.toContain('injected');
    await expectCleanWorkingTree(fx);
  });

  it('write_note is refused when a committed symlink resolves into .git', async () => {
    // MCPVault's own filter judges only the literal argument ("Linked.md" — nothing
    // restricted in that string); the target it resolves to is where a segment guard has
    // to catch it. git status never reports .git/ at all, ignored or not, so the
    // transaction layer's changedPaths() scan can never see this write either — closing
    // this hole requires an independent realpath check on the forwarded path itself.
    await commitSymlink(fx, 'Linked.md', '.git/hooks/pre-commit', 'collab: add malicious symlink');

    const res = await callTool(srv.client, 'write_note', {
      path: 'Linked.md',
      content: '#!/bin/sh\necho pwned\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(join(fx.serverDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    await expectCleanWorkingTree(fx);
  });

  it('write_note is refused when a committed symlink resolves entirely outside the vault', async () => {
    // Defense-in-depth, not fix-dependent: MCPVault's own resolvePath already refuses an
    // EXISTING out-of-vault target on its own (realpathSync succeeds and the result sits
    // outside the vault), so this test passes with or without this wrapper's own guard.
    // The dangling-target and symlink-chain cases below are the ones that actually
    // depend on it — resolvePath can't realpath a target that doesn't exist yet, and a
    // resolver that stops after one hop misses a chain whose first hop still looks
    // in-vault.
    const target = join(fx.outsideDir, 'existing.md');
    const before = '# Existing\n\noriginal content\n';
    await writeFile(target, before);
    await commitSymlink(fx, 'Linked.md', target, 'collab: add symlink to outside target');

    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'write_note', {
      path: 'Linked.md',
      content: 'pwned\n',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(before);
    await expectRemoteUnchanged(fx, preRemote);
    await expectCleanWorkingTree(fx);
  });

  it('patch_note is refused when a committed symlink resolves entirely outside the vault', async () => {
    // Same forwardWrite preflight as the write_note case above, exercised through
    // patch_note's oldString/newString shape instead of write_note's content — the guard
    // fires before MCPVault ever reads the target to apply the patch.
    const target = join(fx.outsideDir, 'existing-patch.md');
    const before = '# Existing\n\noriginal content\n';
    await writeFile(target, before);
    await commitSymlink(fx, 'Linked.md', target, 'collab: add symlink to outside target');

    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'patch_note', {
      path: 'Linked.md',
      oldString: 'original content',
      newString: 'pwned',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(before);
    await expectRemoteUnchanged(fx, preRemote);
    await expectCleanWorkingTree(fx);
  });

  it('write_note is refused when a 2-hop symlink chain resolves outside the vault', async () => {
    // resolveWriteDestination used to follow ONE hop only: Hop1.md -> Hop2.md still
    // resolves in-vault at that point, so the single-hop guard approved it — only for
    // Hop2.md to itself be a symlink onto a dangling external target, which write_note's
    // actual filesystem write then followed and created. The guard has to walk the full
    // chain, not just the first link.
    const externalTarget = join(fx.outsideDir, 'exfil.md');
    await commitSymlinkChain(
      fx,
      [
        ['Hop1.md', 'Hop2.md'],
        ['Hop2.md', externalTarget],
      ],
      'collab: add 2-hop symlink chain escaping the vault',
    );

    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'write_note', {
      path: 'Hop1.md',
      content: 'PWNED',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(externalTarget)).toBe(false);
    await expectRemoteUnchanged(fx, preRemote);
    await expectCleanWorkingTree(fx);
  });

  it('write_note is refused when a 2-hop symlink chain resolves into .git', async () => {
    // Same chain shape as above, but the second hop lands inside the checkout's own
    // .git — a single-hop guard sees only "Hop1.md -> Hop2.md" (unremarkable) and
    // approves it, letting the actual write follow Hop2.md into .git/config.
    await commitSymlinkChain(
      fx,
      [
        ['Hop1.md', 'Hop2.md'],
        ['Hop2.md', '.git/config'],
      ],
      'collab: add 2-hop symlink chain into .git',
    );

    const before = await readFile(join(fx.serverDir, '.git', 'config'), 'utf8');
    const res = await callTool(srv.client, 'write_note', {
      path: 'Hop1.md',
      content: 'PWNED',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(join(fx.serverDir, '.git', 'config'), 'utf8')).toBe(before);
    await expectCleanWorkingTree(fx);
  });

  it('append_to_section is refused when a committed symlink resolves into .git', async () => {
    // append_to_section touches the filesystem itself (readFile/writeFile) rather than
    // forwarding to MCPVault, so forwardWrite's realpath guard doesn't cover it — this is
    // the same segment-re-check gap as the write_note case above, on appendTool's own path.
    await commitSymlink(fx, 'Linked.md', '.git/config', 'collab: add malicious symlink');

    const before = await readFile(join(fx.serverDir, '.git', 'config'), 'utf8');
    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Linked.md',
      heading: 'X',
      text: 'injected',
    });
    expect(res.isError).toBe(true);
    expect(await readFile(join(fx.serverDir, '.git', 'config'), 'utf8')).toBe(before);
    await expectCleanWorkingTree(fx);
  });

  it('append_to_section through an in-vault symlink to an in-vault note still resolves it', async () => {
    // realpath containment runs before the fd-pinned open, so an in-vault symlink whose
    // target is itself an in-vault note stays allowed exactly as before — the append
    // lands on the resolved target and commits it. This locks that behavior against the
    // fd-pin hardening: closing the TOCTOU window must not change which paths resolve.
    await commitSymlink(fx, 'AlphaLink.md', 'Projects/Alpha.md', 'collab: add in-vault symlink');

    const res = await callTool(srv.client, 'append_to_section', {
      path: 'AlphaLink.md',
      heading: 'Decisions',
      text: '- Via the link.',
    });
    expect(res.isError).toBeFalsy();
    // The write followed the symlink onto the real note; the target carries the append.
    expect(await fx.remoteFile('Projects/Alpha.md')).toContain('- Via the link.');
  });

  it('list_directory omits .obsidian', async () => {
    const res = await callTool(srv.client, 'list_directory', { path: '' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain('.obsidian');
  });

  it('list_directory of .git is refused by the wrapper, not silently emptied', async () => {
    // MCPVault's own filter only strips restricted entries out of the listing, so
    // `list_directory({path: '.git'})` "succeeds" with an empty result today — the
    // wrapper never refuses the call itself the way it refuses a .git write. Relying on
    // per-entry filtering as the only containment is exactly the single-layer trust the
    // read side is missing relative to writes.
    const res = await callTool(srv.client, 'list_directory', { path: '.git' });
    expect(res.isError).toBe(true);
  });

  it('read_note is refused when a committed symlink resolves into .git', async () => {
    // forbiddenReadArgReason checked only the literal "Linked.md" string, and MCPVault's
    // own resolvePath() only confirms the symlink resolves INSIDE the vault — its
    // pathFilter match is against the same literal name, which has no .git segment. Both
    // layers pass a symlink whose target is .git/config, and readFile follows it, so this
    // needs the same realpath-nearest-ancestor check the write path already runs.
    await commitSymlink(fx, 'Linked.md', '.git/config', 'collab: add malicious symlink');

    const res = await callTool(srv.client, 'read_note', { path: 'Linked.md' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('[remote "origin"]');
  });

  it('read_note refuses a note that arrived via fetch with executable ---js frontmatter, never running it', async () => {
    // MCPVault's own FrontmatterHandler.parse only overrides gray-matter's yaml engine, so
    // gray-matter merges its default js/javascript engines back in on every read — a note
    // pushed by a collaborator (never touched by this wrapper's write-path validation)
    // lands via readTransaction's own fetch/fast-forward and must be refused before
    // read_note ever hands it to MCPVault.
    (globalThis as Record<string, unknown>)['__ogmRceProbeTargeted'] = false;
    const payload = [
      '---js',
      'module.exports = { t: ((globalThis.__ogmRceProbeTargeted = true), "x") }',
      '---',
      'body',
    ].join('\n');
    await fx.collabWrite('Malicious.md', payload, 'collab: add malicious note');

    const res = await callTool(srv.client, 'read_note', { path: 'Malicious.md' });
    expect(res.isError).toBe(true);
    expect((globalThis as Record<string, unknown>)['__ogmRceProbeTargeted']).toBe(false);
  });

  it('list_all_tags refuses wholesale when a fetched note anywhere in the vault carries executable frontmatter', async () => {
    // list_all_tags takes no target path — it scans every note in the vault, so the
    // targeted read_note-shaped guard alone can't cover it. The RCE note doesn't need to
    // be the one asked for; it only needs to be reachable from HEAD.
    (globalThis as Record<string, unknown>)['__ogmRceProbeUntargeted'] = false;
    const payload = [
      '---js',
      'module.exports = { t: ((globalThis.__ogmRceProbeUntargeted = true), "x") }',
      '---',
      'body',
    ].join('\n');
    await fx.collabWrite('Inbox/Malicious2.md', payload, 'collab: add malicious note');

    const res = await callTool(srv.client, 'list_all_tags', {});
    expect(res.isError).toBe(true);
    expect((globalThis as Record<string, unknown>)['__ogmRceProbeUntargeted']).toBe(false);
  });

  it('patch_note refuses a note that arrived via fetch with executable ---js frontmatter, never running it', async () => {
    // transact()'s own fetch/ff-only-merge can land this note before mutate() ever runs —
    // no prior read_note call required. patch_note's readNote() would otherwise hand the
    // payload straight to gray-matter's default (unsafe) engines the moment the write tool
    // tries to load the note it's about to patch.
    (globalThis as Record<string, unknown>)['__ogmRceProbeWrite'] = false;
    const payload = [
      '---js',
      'module.exports = { t: ((globalThis.__ogmRceProbeWrite = true), "x") }',
      '---',
      'original body',
    ].join('\n');
    await fx.collabWrite('Malicious3.md', payload, 'collab: add malicious note');

    const preRemote = await fx.bareHead();
    const res = await callTool(srv.client, 'patch_note', {
      path: 'Malicious3.md',
      oldString: 'original body',
      newString: 'pwned',
    });
    expect(res.isError).toBe(true);
    expect((globalThis as Record<string, unknown>)['__ogmRceProbeWrite']).toBe(false);
    await expectRemoteUnchanged(fx, preRemote);
  });

  // MCPVault's PathFilter.allowedExtensions covers .txt/.base/.canvas exactly like .md,
  // and FrontmatterHandler.parse runs gray-matter on all of them — the same RCE the .md
  // case above closes is reachable through any of MCPVault's writable extensions, not
  // just the ones this wrapper happens to treat as "markdown." Each row derives a unique
  // probe key from its extension so a leaked ---js payload can't be masked by a sibling case.
  it.each(['txt', 'base', 'canvas'])(
    'read_note refuses a .%s note that arrived via fetch with executable ---js frontmatter, never running it',
    async (ext) => {
      const file = `Malicious.${ext}`;
      const probeKey = `__ogmRceProbe${ext.charAt(0).toUpperCase()}${ext.slice(1)}Read`;
      (globalThis as Record<string, unknown>)[probeKey] = false;
      const payload = [
        '---js',
        `module.exports = { t: ((globalThis.${probeKey} = true), "x") }`,
        '---',
        'body',
      ].join('\n');
      await fx.collabWrite(file, payload, 'collab: add malicious note');

      const res = await callTool(srv.client, 'read_note', { path: file });
      expect(res.isError).toBe(true);
      expect((globalThis as Record<string, unknown>)[probeKey]).toBe(false);
    },
  );

  it.each(['txt', 'base', 'canvas'])(
    'patch_note refuses a .%s note that arrived via fetch with executable ---js frontmatter, never running it',
    async (ext) => {
      const file = `MaliciousW.${ext}`;
      const probeKey = `__ogmRceProbe${ext.charAt(0).toUpperCase()}${ext.slice(1)}Write`;
      (globalThis as Record<string, unknown>)[probeKey] = false;
      const payload = [
        '---js',
        `module.exports = { t: ((globalThis.${probeKey} = true), "x") }`,
        '---',
        'original body',
      ].join('\n');
      await fx.collabWrite(file, payload, 'collab: add malicious note');

      const preRemote = await fx.bareHead();
      const res = await callTool(srv.client, 'patch_note', {
        path: file,
        oldString: 'original body',
        newString: 'pwned',
      });
      expect(res.isError).toBe(true);
      expect((globalThis as Record<string, unknown>)[probeKey]).toBe(false);
      await expectRemoteUnchanged(fx, preRemote);
    },
  );

  it('read_multiple_notes is refused wholesale when one path targets .git', async () => {
    // MCPVault denies the individual path internally but reports it in a non-error "err"
    // array rather than isError, so a caller that only checks isError sees this as a
    // successful batch read. The wrapper must refuse the whole call before forwarding.
    const res = await callTool(srv.client, 'read_multiple_notes', {
      paths: ['Inbox/Beta.md', '.git/config'],
    });
    expect(res.isError).toBe(true);
  });
});
