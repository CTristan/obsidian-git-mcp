import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, git, SEED_NOTES, type Fixture } from '../fixture.js';
import { callTool, commitShaOf, startServer, type TestServer } from '../helpers.js';

const ALPHA = 'Projects/Alpha.md';

function remoteAlpha(fx: Fixture): Promise<string> {
  return fx.remoteFile(ALPHA);
}

describe('append_to_section', () => {
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

  it('appends under an existing trailing section', async () => {
    const res = await callTool(srv.client, 'append_to_section', {
      path: ALPHA,
      heading: 'Decisions',
      text: '- Buy the dip.',
    });
    expect(res.isError).toBeFalsy();
    expect(commitShaOf(res)).toMatch(/^[0-9a-f]{40}$/);

    const expected = SEED_NOTES[ALPHA]!.replace('- Ship early.\n', '- Ship early.\n- Buy the dip.\n');
    expect(await remoteAlpha(fx)).toBe(expected);
  });

  it('appends to a middle section without disturbing later sections', async () => {
    const res = await callTool(srv.client, 'append_to_section', {
      path: ALPHA,
      heading: 'Status',
      text: 'Still in flight.',
    });
    expect(res.isError).toBeFalsy();

    const expected = SEED_NOTES[ALPHA]!.replace(
      'Alpha is in flight.\n',
      'Alpha is in flight.\nStill in flight.\n',
    );
    expect(await remoteAlpha(fx)).toBe(expected);
  });

  it('creates the section at the end of the note when the heading is absent', async () => {
    const res = await callTool(srv.client, 'append_to_section', {
      path: ALPHA,
      heading: 'Log',
      text: '- Started.',
    });
    expect(res.isError).toBeFalsy();

    const expected = `${SEED_NOTES[ALPHA]!}\n## Log\n\n- Started.\n`;
    expect(await remoteAlpha(fx)).toBe(expected);
  });

  it('matches the note\'s CRLF line endings instead of mixing styles', async () => {
    const crlf = '# Win\r\n\r\n## Log\r\n\r\n- one\r\n';
    await fx.collabWrite('Inbox/Windows.md', crlf, 'collab: add CRLF note');

    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Inbox/Windows.md',
      heading: 'Log',
      text: '- two',
    });
    expect(res.isError).toBeFalsy();

    expect(await fx.remoteFile('Inbox/Windows.md')).toBe(
      '# Win\r\n\r\n## Log\r\n\r\n- one\r\n- two\r\n',
    );
  });

  it('refuses a missing note instead of inventing one', async () => {
    const res = await callTool(srv.client, 'append_to_section', {
      path: 'Nope/Missing.md',
      heading: 'X',
      text: 'y',
    });
    expect(res.isError).toBe(true);
    expect(await git(['status', '--porcelain'], fx.serverDir)).toBe('');
  });
});
