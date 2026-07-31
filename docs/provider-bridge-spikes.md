# Hosted provider bridge spikes

These three spikes answer one narrow question: can an existing ChatGPT app provide a useful mobile bridge to a note corpus from ordinary ChatGPT conversations, without a custom MCP publication? Run each spike independently with disposable, non-sensitive content. Do not copy a real vault until one provider passes its acceptance gate.

Google Drive receives `92/100`. It is the strongest first experiment because ChatGPT Pro supports Drive sync, Google Docs actions now live inside the Drive app, and connected Google content can participate in personalization when Memory is enabled. The remaining uncertainty is whether actions available to this account can create and update documents reliably from iOS and whether raw Markdown remains useful without conversion.

Dropbox receives `58/100`. It is worth a bounded compatibility test because the app advertises read access and write actions where available. Its documented sync corpus omits Markdown and plain text, which means a successful design will probably require converting notes to `.docx` or PDF and will no longer preserve a natural Obsidian round trip.

Notion receives `28/100`. It can still prove cross-conversation mobile retrieval, but new connections no longer receive sync and the app exposes no write or modify actions. It cannot satisfy the complete goal unless current account behavior differs from the published contract or a separate automation performs every write.

Current capability references:

- [Google Drive app with sync setup](https://help.openai.com/en/articles/10948259-google-drive-synced-connectors-self-service-setup/)
- [Google app data controls and Memory behavior](https://help.openai.com/en/articles/10408842-google-connector-for-chatgpt-data-controls-faq)
- [Dropbox app with sync](https://help.openai.com/en/articles/12364275-dropbox-connector)
- [Notion app](https://help.openai.com/en/articles/12532955-notion-synced-connector)
- [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in)

## Shared fixture and evidence

Create a new provider account, workspace, or top-level folder for each spike. Give it no access to the real vault. Copy the following five-note fixture into that provider's native representation:

- `00-index` links to every other note and contains `indigo-harbor-4c91`.
- `10-profile` states one harmless durable preference and contains `cedar-window-82ea`.
- `20-project` contains a dated status, one open task, and `quartz-signal-19bd`.
- `30-linked-detail` links back to `20-project` and contains `ember-lattice-73f0`.
- `40-write-target` starts at revision `1` and contains `silver-circuit-5aa6`.

Capture each attempt in a fresh evidence table with timestamp, ChatGPT plan, iOS app version, provider connection state, conversation ID, prompt, observed citations, provider revision, and pass or fail. Screen recordings are useful supporting evidence, but provider revision history is the authority for write results.

Run the same acceptance sequence from the ChatGPT mobile app:

1. Start a new conversation, select or mention only the provider under test, ask for `indigo-harbor-4c91`, and require a source citation.
2. Start another new conversation without selecting the app. Ask the same question. Record whether ChatGPT discovers the source automatically. Failure here means the provider does not satisfy "any conversation" without an invocation convention.
3. Ask for the project status, then ask a follow-up that requires traversing the link to `30-linked-detail`. Record whether links preserve useful note structure or act only as plain text.
4. Change `20-project` in the provider, record its provider revision, and poll from a new ChatGPT conversation at 1, 5, 15, 60, and 240 minutes. Stop after the first correct citation or the four-hour boundary.
5. Ask ChatGPT to change `40-write-target` from revision `1` to revision `2` and append a fresh nonce. Approve the provider action only after ChatGPT shows the exact proposed change. Verify the provider's revision history directly, then retrieve the nonce from a new conversation.
6. In a separate conversation with Memory enabled, explicitly ask ChatGPT to remember the harmless preference from `10-profile`. Start another conversation and ask what preference it remembers without mentioning the provider. Then delete that saved memory and confirm its removal. Treat this as a Memory test, not evidence that provider content becomes memory automatically.
7. Remove ChatGPT's access to `30-linked-detail`, wait for the documented sync window, and confirm that a new conversation cannot retrieve its unique token. Reconnect only after recording the result.
8. Disconnect the provider app and confirm that new conversations no longer retrieve fixture content. Delete the disposable corpus after the spike.

A provider passes the full bridge gate only if it supports cited reads from a new iOS conversation, a verified write with provider-side revision evidence, retrieval of that write from another conversation, and predictable revocation. Automatic source discovery is a separate gate because an app may work from every conversation while still requiring an explicit `@` mention or source selection.

## Google Drive spike

Use one new folder named `ChatGPT Vault Spike`. Create the five fixtures first as Google Docs because the documented action surface targets Docs, Sheets, and Slides through the Drive app. Upload an identical second set as `.md` files so the spike measures Markdown support instead of assuming it.

1. Connect Google Drive from `Settings > Apps`, select sync, grant only the requested account, and wait until the fixture folder becomes searchable.
2. Run the shared sequence against the Google Docs set.
3. Repeat read, freshness, and citation tests against the raw Markdown set. Do not run writes against both formats unless ChatGPT exposes a concrete action for each.
4. For the write test, require an update to the existing Google Doc, not a new unsourced summary. Record the Drive revision ID or version timestamp before and after approval.
5. Repeat the read and write tests in an existing conversation that predates the connection.

Pass Google Drive when Google Docs meet the full bridge gate. Treat raw Markdown support as an optimization. If Docs pass and Markdown fails, the next design decision is a reversible Markdown-to-Google-Docs projection with stable note IDs, not a replacement of the vault's canonical files.

## Dropbox spike

Use one new folder named `ChatGPT Vault Spike`. Store each fixture as `.md`, `.txt`, `.docx`, and PDF so the experiment distinguishes unsupported formats from retrieval failure. Preserve the same unique token in every representation, prefixed by its format name.

1. Connect Dropbox from `Settings > Apps`, enable sync if offered, and wait for partial or complete sync.
2. Run the shared read and freshness sequence once per format.
3. If ChatGPT offers a write action, require it to update the existing `.docx` fixture and verify the Dropbox version history. Also attempt a raw Markdown update only if the UI presents that exact action.
4. Record whether citations resolve to the correct file representation and whether duplicate formats cause ambiguous retrieval.

Pass Dropbox only if one representation meets the full bridge gate and has a deterministic reversible conversion to Markdown. A `.docx`-only pass proves ChatGPT connectivity, but it does not yet prove a safe Obsidian bridge.

## Notion spike

Use one new private workspace or parent page named `ChatGPT Vault Spike`. Create each fixture as a child page, preserve backlinks as ordinary Notion links, and authorize only that test area if the connection flow supports granular selection.

1. Connect Notion from `Settings > Apps` and record whether this account receives file search only or retains a legacy synced connection.
2. Run shared steps 1 through 4, 6, 7, and 8.
3. Attempt the write prompt once. Do not introduce third-party automation during this spike. Record the absence of an action as the expected result under the current published contract.
4. Repeat retrieval from an existing conversation and a new conversation without an explicit app mention.

Pass Notion only as a read bridge if cited mobile retrieval, freshness, and revocation work. It cannot pass the full bridge gate without a native write action. If read behavior is exceptional enough to retain, treat Notion as a read-only projection and evaluate its write automation as a new architecture, not as part of this spike.

## Decision rule

Run Google Drive first, Dropbox second, and Notion last. Stop after Google Drive if it passes every mandatory gate unless a second-provider fallback has independent value. Stop any spike immediately if the connection requests broader access than the disposable account or if ChatGPT proposes a write without an exact confirmation preview.

The winning spike proves product capability only. Before copying a real vault, design stable note identity, format conversion, conflict handling, deletion semantics, audit receipts, backups, and a single canonical writer. A provider-side successful update does not prove that the corresponding Git commit reached the vault's canonical remote.
