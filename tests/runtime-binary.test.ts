// @vitest-environment node
import { expect, onTestFinished, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { connectMdRuntime } from '@agentshouse/mdruntime/client';
import { serveMdRuntime } from '@agentshouse/mdruntime/host';
import { createMemoryAdapter, type MemoryRoom } from '@agentshouse/mdruntime/memory';
import { readAttachment, uploadAttachment } from '../src/data/assets';
import type { Runtime } from '../src/data/house';

test('the real runtime queues and reads a file through its Room binary APIs', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const locator = 'binary-test';
  const room: MemoryRoom = {
    name: 'Binary test', locator, handle: locator, roomVersion: 'one',
    operations: { read: [''], sync: [''], write: [''], delete: [''] },
    replica: { selection: locator, admission: 'admitted' }, providerOwnedPaths: [],
    model: { kind: 'model', snapshot: { identity: locator, version: '1', revision: 'one', schema: null } },
    documents: { 'welcome.md': '# Binary fixture\n' },
  };
  const adapter = createMemoryAdapter({ rooms: [room] });
  const stopped = new AbortController();
  const host = serveMdRuntime({ adapter, signal: stopped.signal, shell: {
    persistentStorage: true, generation: null, keepGeneration() {}, dropGeneration() {},
  } });
  const channel = new MessageChannel();
  host.attach(channel.port1, 'binary-test', undefined, { rooms: [locator], documents: [], conversations: false });
  const client = connectMdRuntime(channel.port2) as Runtime;
  onTestFinished(() => { stopped.abort(); channel.port1.close(); channel.port2.close(); vi.unstubAllGlobals(); });
  await vi.waitFor(async () => expect((await client.rooms())[0]?.roomVersion).toBe('one'));
  adapter.notifyServiceMode('write-halted');
  const descriptor = await uploadAttachment(client, locator, new File(['retained bytes'], 'note.txt', {type:'text/plain'}), 'native-fixture');
  expect(descriptor.path).toBe('files/native-fixture');
  expect(await client.roomDraft.read(locator, descriptor.path)).toBeNull();
  const result = await readAttachment(client, locator, descriptor);
  expect(result.status).toBe('available');
  expect(await result.blob!.text()).toBe('retained bytes');
  await vi.waitFor(async () => {
    const records = await client.query({rooms:[locator],pathPrefix:'files',select:'all'});
    expect(records).toMatchObject({documents:[{path:descriptor.path,binaryFile:{byteLength:14,sha256:descriptor.sha256}}]});
  }, {timeout:3000});
});
