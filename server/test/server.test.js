'use strict';
// End-to-end tests: real HTTP/WebSocket server on a random port, real WebSocket clients (Node >= 22),
// and an INJECTED fake clock for the 24h tests (the system clock is never touched).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createGameServer, playerIdFromKey } = require('../server.js');

const H = 3600 * 1000;
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✔ ' + name); } catch (e) { failed++; console.log('  ✘ ' + name + '\n      ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n      ')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newKey = () => crypto.randomBytes(24).toString('base64url');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dtb-'));
const blueprint = (id, extra) => Object.assign({ id, nm: 'Test ' + id, d: { w: 2, h: 2, c: [1, 1, 1, 1], d: '2222', u: 0.5 }, x: 3, y: 0, z: 4, ry: 0, s: 1 }, extra || {});

function startServer(opts) {
  const clock = { t: Date.parse('2026-11-01T00:00:00Z') };
  const gs = createGameServer(Object.assign({ now: () => clock.t, dataDir: tmp(), sweepMs: 3600000 }, opts || {}));
  return new Promise(res => gs.start(0, () => res({ gs, clock, port: gs.server.address().port, dataDir: gs.server.dataDir })));
}
function client(port, key, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws'), c = { ws, msgs: [], key, waiters: [] };
    ws.onmessage = ev => { const m = JSON.parse(ev.data); c.msgs.push(m); c.waiters.slice().forEach(w => w(m)); };
    ws.onerror = e => reject(new Error('ws error'));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', key, name: name || 'P', emoji: '😎' }));
    c.send = m => ws.send(JSON.stringify(m));
    c.wait = (pred, ms) => new Promise((res, rej) => { const f = c.msgs.find(pred); if (f) return res(f); const to = setTimeout(() => rej(new Error('timeout waiting for message')), ms || 2000); const w = m => { if (pred(m)) { clearTimeout(to); c.waiters = c.waiters.filter(x => x !== w); res(m); } }; c.waiters.push(w); });
    c.since = n => c.msgs.slice(n);
    c.wait(m => m.t === 'init').then(init => { c.init = init; c.id = init.you; resolve(c); }, reject);
  });
}
const close = c => { try { c.ws.close(); } catch (e) {} };

(async () => {
  console.log('\nDraw To Build server tests\n');

  await test('identity: server derives playerId from the secret key (client cannot choose it)', async () => {
    const { gs, port } = await startServer(); const k = newKey();
    const a = await client(port, k, 'A'); assert.strictEqual(a.id, playerIdFromKey(k));
    // same hash as the browser implementation will compute: u + sha256("dtb-v2:"+key)[0..24]
    assert.strictEqual(a.id, 'u' + crypto.createHash('sha256').update('dtb-v2:' + k).digest('hex').slice(0, 24));
    assert.strictEqual(a.init.v, 2);
    // a join that lies about pid / ownerId is ignored
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws'); const got = []; ws.onmessage = e => got.push(JSON.parse(e.data));
    await new Promise(r => ws.onopen = r); const k2 = newKey();
    ws.send(JSON.stringify({ t: 'join', key: k2, pid: a.id, playerId: a.id, name: 'Evil', emoji: '😈' })); await sleep(150);
    assert.strictEqual(got.find(m => m.t === 'init').you, playerIdFromKey(k2)); assert.notStrictEqual(got.find(m => m.t === 'init').you, a.id);
    ws.close(); close(a); await gs.stop();
  });

  await test('invalid / missing key is rejected', async () => {
    const { gs, port } = await startServer();
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws'); const got = []; ws.onmessage = e => got.push(JSON.parse(e.data));
    let code = 0; ws.onclose = e => code = e.code; await new Promise(r => ws.onopen = r);
    ws.send(JSON.stringify({ t: 'join', pid: 'pSomething', name: 'x' })); await sleep(300);
    assert.ok(!got.find(m => m.t === 'init')); assert.strictEqual(code, 4001); await gs.stop();
  });

  await test('add: server stamps ownerId + createdAt, ignoring values sent by the client', async () => {
    const { gs, clock, port } = await startServer(); const a = await client(port, newKey(), 'A'), b = await client(port, newKey(), 'B');
    a.send({ t: 'add', o: blueprint('obj_aaaa1', { ownerId: b.id, createdAt: 1, owner: 'B' }) });
    const m = await b.wait(x => x.t === 'add' && x.o.id === 'obj_aaaa1');
    assert.strictEqual(m.o.ownerId, a.id); assert.strictEqual(m.o.createdAt, clock.t); assert.strictEqual(gs.objects.get('obj_aaaa1').ownerId, a.id);
    close(a); close(b); await gs.stop();
  });

  await test('add: cannot overwrite an existing object id; invalid data rejected', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey()), b = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_dup01') }); await a.wait(x => x.t === 'add');
    b.send({ t: 'add', o: blueprint('obj_dup01', { x: 50 }) }); await b.wait(x => x.t === 'adderr');
    assert.strictEqual(gs.objects.get('obj_dup01').ownerId, a.id); assert.strictEqual(gs.objects.get('obj_dup01').x, 3);
    b.send({ t: 'add', o: { id: 'obj_bad01', d: { w: 2, h: 2, c: [1], d: '2' , u: 0.5 } } }); await b.wait(x => x.t === 'adderr' && x.id === 'obj_bad01');
    b.send({ t: 'add', o: blueprint('obj_big01', { d: { w: 999, h: 2, c: [], d: '', u: 0.5 } }) }); await b.wait(x => x.t === 'adderr' && x.id === 'obj_big01');
    assert.ok(!gs.objects.has('obj_bad01') && !gs.objects.has('obj_big01')); close(a); close(b); await gs.stop();
  });

  await test('OWNERSHIP: other player cannot delete (single del)', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey()), b = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_own01') }); await b.wait(x => x.t === 'add');
    b.send({ t: 'del', id: 'obj_own01', req: 7 }); const r = await b.wait(x => x.t === 'delres' && x.req === 7);
    assert.deepStrictEqual(r.deleted, []); assert.deepStrictEqual(r.denied, ['obj_own01']); assert.ok(gs.objects.has('obj_own01'));
    assert.ok(!a.msgs.find(x => x.t === 'delmany'), 'owner must not see a deletion'); close(a); close(b); await gs.stop();
  });

  await test('OWNERSHIP: other player cannot move / rotate / resize (upd) and gets the real state back', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey()), b = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_own02') }); await b.wait(x => x.t === 'add');
    b.send({ t: 'upd', id: 'obj_own02', x: -50, y: 9, z: -50, ry: 1, s: 8 });
    const back = await b.wait(x => x.t === 'upd'); assert.strictEqual(back.x, 3); assert.strictEqual(back.s, 1);
    const o = gs.objects.get('obj_own02'); assert.deepStrictEqual([o.x, o.y, o.z, o.ry, o.s], [3, 0, 4, 0, 1]);
    a.send({ t: 'upd', id: 'obj_own02', x: 10, y: 0, z: 11, ry: 0.5, s: 2 }); await b.wait(x => x.t === 'upd' && x.x === 10);
    assert.strictEqual(gs.objects.get('obj_own02').s, 2, 'owner CAN update'); close(a); close(b); await gs.stop();
  });

  await test('MULTI-DELETE checks ownership of every object (mixed own + foreign + missing)', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey()), b = await client(port, newKey());
    for (const id of ['obj_a0001', 'obj_a0002', 'obj_a0003']) a.send({ t: 'add', o: blueprint(id) });
    for (const id of ['obj_b0001', 'obj_b0002']) b.send({ t: 'add', o: blueprint(id) });
    await a.wait(x => x.t === 'add' && x.o.id === 'obj_b0002');
    a.send({ t: 'delmany', req: 1, ids: ['obj_a0001', 'obj_b0001', 'obj_a0002', 'obj_nope1', 'obj_b0002'] });
    const r = await a.wait(x => x.t === 'delres' && x.req === 1);
    assert.deepStrictEqual(r.deleted.sort(), ['obj_a0001', 'obj_a0002']); assert.deepStrictEqual(r.denied.sort(), ['obj_b0001', 'obj_b0002']); assert.deepStrictEqual(r.missing, ['obj_nope1']);
    assert.ok(gs.objects.has('obj_a0003') && gs.objects.has('obj_b0001') && gs.objects.has('obj_b0002') && !gs.objects.has('obj_a0001'));
    const bc = await b.wait(x => x.t === 'delmany'); assert.deepStrictEqual(bc.ids.sort(), ['obj_a0001', 'obj_a0002']);
    // select-all-style delete of all 3 own + 2 foreign leaves only the foreign ones
    a.send({ t: 'delmany', req: 2, ids: [...gs.objects.keys()] }); await a.wait(x => x.t === 'delres' && x.req === 2);
    assert.deepStrictEqual([...gs.objects.keys()].sort(), ['obj_b0001', 'obj_b0002']); close(a); close(b); await gs.stop();
  });

  await test('forged identity: guessing/copying another playerId (public) gives no power', async () => {
    const { gs, port } = await startServer(); const ka = newKey(); const a = await client(port, ka), evil = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_vic01') }); await evil.wait(x => x.t === 'add');
    evil.send({ t: 'delmany', ids: ['obj_vic01'], ownerId: a.id, playerId: a.id, pid: a.id, key: a.id }); await evil.wait(x => x.t === 'delres');
    assert.ok(gs.objects.has('obj_vic01'));
    // a fake "key" equal to the public id cannot be used to join as the victim either
    const imp = await client(port, a.id.padEnd(32, 'x'), 'imp'); assert.notStrictEqual(imp.id, a.id);
    close(a); close(evil); close(imp); await gs.stop();
  });

  await test('24h AUTO-DELETE: removed exactly after 24h from creation, not before (fake clock)', async () => {
    const { gs, clock, port } = await startServer(); const a = await client(port, newKey()), w = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_old01') }); await a.wait(x => x.t === 'add');
    clock.t += 10 * H; a.send({ t: 'add', o: blueprint('obj_mid01') }); await a.wait(x => x.t === 'add' && x.o.id === 'obj_mid01');
    clock.t += 13 * H + 59 * 60000 + 59000;                       // old = 23h59m59s, mid = 13h59m59s
    assert.deepStrictEqual(gs.sweep(), [], 'nothing may be deleted at 23:59:59'); assert.ok(gs.objects.has('obj_old01'));
    clock.t += 1000;                                               // old = 24h00m00s
    assert.deepStrictEqual(gs.sweep(), ['obj_old01']); assert.ok(!gs.objects.has('obj_old01') && gs.objects.has('obj_mid01'), 'younger building survives');
    const bc = await w.wait(x => x.t === 'delmany' && x.reason === 'expired'); assert.deepStrictEqual(bc.ids, ['obj_old01']);
    clock.t += 10 * H + 1000; assert.deepStrictEqual(gs.sweep(), ['obj_mid01']); assert.strictEqual(gs.objects.size, 0);
    close(a); close(w); await gs.stop();
  });

  await test('24h counts from CREATION time, not login time (re-login / owner offline does not extend it)', async () => {
    const { gs, clock, port } = await startServer(); const k = newKey(); let a = await client(port, k);
    a.send({ t: 'add', o: blueprint('obj_log01') }); await a.wait(x => x.t === 'add'); close(a);
    clock.t += 23 * H; a = await client(port, k);                  // logs in again 23h later
    assert.ok(a.init.objects.find(o => o.id === 'obj_log01'), 'still there at 23h');
    clock.t += 1 * H; const gone = gs.sweep(); assert.deepStrictEqual(gone, ['obj_log01']); close(a); await gs.stop();
  });

  await test('expired buildings are never sent to a client that joins late (lazy sweep on join)', async () => {
    const { gs, clock, port } = await startServer(); const a = await client(port, newKey());
    a.send({ t: 'add', o: blueprint('obj_lazy1') }); await a.wait(x => x.t === 'add'); clock.t += 25 * H;
    const b = await client(port, newKey()); assert.strictEqual(b.init.objects.length, 0); close(a); close(b); await gs.stop();
  });

  await test('RESTART PERSISTENCE: kept buildings survive, deleted + expired ones never come back', async () => {
    const dataDir = tmp(); const clock = { t: Date.parse('2026-11-01T00:00:00Z') };
    const mk = () => createGameServer({ now: () => clock.t, dataDir, sweepMs: 3600000 });
    let gs = mk(); await new Promise(r => gs.start(0, r)); let port = gs.server.address().port; const k = newKey(); let a = await client(port, k);
    for (const id of ['obj_keep1', 'obj_del01', 'obj_exp01']) a.send({ t: 'add', o: blueprint(id) });
    await a.wait(x => x.t === 'add' && x.o.id === 'obj_exp01'); clock.t += 20 * H;
    a.send({ t: 'add', o: blueprint('obj_new01') }); await a.wait(x => x.t === 'add' && x.o.id === 'obj_new01');
    a.send({ t: 'delmany', ids: ['obj_del01'], req: 1 }); await a.wait(x => x.t === 'delres');
    close(a); await gs.stop(); gs.server.closeAllConnections && gs.server.closeAllConnections();
    clock.t += 5 * H;                                              // server "offline": obj_keep1/obj_exp01 are now 25h old, obj_new01 5h
    gs = mk(); await new Promise(r => gs.start(0, r)); port = gs.server.address().port;
    assert.deepStrictEqual([...gs.objects.keys()], ['obj_new01'], 'only the building younger than 24h remains');
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'world.json'), 'utf8')); assert.deepStrictEqual(st.objects.map(o => o.id), ['obj_new01'], 'expired + deleted are gone from DISK too');
    a = await client(port, k); assert.strictEqual(a.init.objects[0].ownerId, a.id, 'ownership persisted across restart');
    a.send({ t: 'delmany', ids: ['obj_new01'], req: 2 }); const r = await a.wait(x => x.t === 'delres' && x.req === 2); assert.deepStrictEqual(r.deleted, ['obj_new01']);
    close(a); await gs.stop();
  });

  await test('legacy data without createdAt/ownerId: timer starts at load, nobody can delete it, never deleted early', async () => {
    const dataDir = tmp(); fs.writeFileSync(path.join(dataDir, 'world.json'), JSON.stringify({ objects: [blueprint('obj_leg01')] }));
    const clock = { t: Date.parse('2026-11-01T00:00:00Z') }; const gs = createGameServer({ now: () => clock.t, dataDir, sweepMs: 3600000 });
    await new Promise(r => gs.start(0, r)); const port = gs.server.address().port; const a = await client(port, newKey());
    assert.strictEqual(gs.objects.get('obj_leg01').createdAt, clock.t); a.send({ t: 'delmany', ids: ['obj_leg01'], req: 1 });
    assert.deepStrictEqual((await a.wait(x => x.t === 'delres')).denied, ['obj_leg01']);
    clock.t += 23 * H; assert.deepStrictEqual(gs.sweep(), []); clock.t += 1 * H; assert.deepStrictEqual(gs.sweep(), ['obj_leg01']); close(a); await gs.stop();
  });

  await test('one session per player: second login kicks the first (code 4000)', async () => {
    const { gs, port } = await startServer(); const k = newKey(); const a = await client(port, k); let code = 0; a.ws.onclose = e => code = e.code;
    const a2 = await client(port, k); await sleep(200); assert.strictEqual(code, 4000); assert.strictEqual(gs.players.size, 1); close(a2); await gs.stop();
  });

  await test('/api/status works with CORS and reports counts', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey()); a.send({ t: 'add', o: blueprint('obj_stat1') }); await a.wait(x => x.t === 'add');
    const r = await fetch('http://127.0.0.1:' + port + '/api/status'); const j = await r.json();
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*'); assert.strictEqual(j.players, 1); assert.strictEqual(j.objects, 1); assert.strictEqual(j.v, 2); close(a); await gs.stop();
  });

  await test('chat + presence still work (old features)', async () => {
    const { gs, port } = await startServer(); const a = await client(port, newKey(), 'Ann'), b = await client(port, newKey(), 'Bob');
    await a.wait(x => x.t === 'pj'); a.send({ t: 'chat', m: 'hello <b>' }); const c = await b.wait(x => x.t === 'chat'); assert.strictEqual(c.c.name, 'Ann'); assert.strictEqual(c.c.m, 'hello b');
    a.send({ t: 'pos', x: 5, y: 0, z: 6, ry: 1, mv: 2 }); const p = await b.wait(x => x.t === 'pos'); assert.strictEqual(p.x, 5); assert.strictEqual(p.id, a.id);
    close(a); await b.wait(x => x.t === 'pl'); close(b); await gs.stop();
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
