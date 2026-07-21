import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../fixture.js';
import { callTool, startServer, textOf, type TestServer } from '../helpers.js';

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
    const [preRemote] = await fx.bareLog('%H', 1);
    const res = await callTool(srv.client, 'write_note', {
      path: '../evil.md',
      content: 'escape attempt\n',
    });
    expect(res.isError).toBe(true);
    expect(existsSync(join(fx.root, 'evil.md'))).toBe(false);
    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
  });

  it('absolute paths are refused', async () => {
    const res = await callTool(srv.client, 'read_note', { path: '/etc/hosts' });
    expect(res.isError).toBe(true);
  });

  it('.obsidian writes are refused at the tool layer', async () => {
    const [preRemote] = await fx.bareLog('%H', 1);
    const res = await callTool(srv.client, 'write_note', {
      path: '.obsidian/app.json',
      content: '{"pwned":true}',
    });
    expect(res.isError).toBe(true);
    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
  });

  it('.obsidian is refused by wrapper-added tools too', async () => {
    const [preRemote] = await fx.bareLog('%H', 1);
    const res = await callTool(srv.client, 'append_to_section', {
      path: '.obsidian/note.md',
      heading: 'X',
      text: 'y',
    });
    expect(res.isError).toBe(true);
    const [postRemote] = await fx.bareLog('%H', 1);
    expect(postRemote).toBe(preRemote);
  });

  it('list_directory omits .obsidian', async () => {
    const res = await callTool(srv.client, 'list_directory', { path: '' });
    expect(textOf(res)).not.toContain('.obsidian');
  });
});
