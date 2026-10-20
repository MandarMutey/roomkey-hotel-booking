// Edge-case tests: run with `npm test` (uses a throw-away in-memory database)
process.env.DB_FILE = ':memory:';
process.env.SEED_DEMO = '0';
const app = require('./server');
const assert = require('assert');
const server = app.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const ymd = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return ymd(x); };
  let pass = 0;
  const t = (name, ok) => { assert(ok, name); console.log('  ✓ ' + name); pass++; };
  try {
    t('starts empty', (await call('GET', '/rooms')).data.length === 0);
    const a = (await call('POST', '/rooms', { room_no: '101', type: 'Single', price: 2000 })).data.id;
    const b = (await call('POST', '/rooms', { room_no: '201', type: 'Double', price: 3500 })).data.id;
    t('duplicate room rejected (409)', (await call('POST', '/rooms', { room_no: '101', type: 'Single', price: 1 })).status === 409);
    t('negative price rejected (400)', (await call('POST', '/rooms', { room_no: '999', type: 'Single', price: -5 })).status === 400);
    t('bad room type rejected (400)', (await call('POST', '/rooms', { room_no: '998', type: 'Palace', price: 5 })).status === 400);

    const b1 = await call('POST', '/bookings', { room_id: a, guest_name: 'Asha', check_in: d(2), check_out: d(5) });
    t('booking created (201)', b1.status === 201);
    const clash = await call('POST', '/bookings', { room_id: a, guest_name: 'Ravi', check_in: d(4), check_out: d(7) });
    t('overlapping booking blocked (409)', clash.status === 409 && clash.data.field === 'check_in');
    t('back-to-back booking allowed', (await call('POST', '/bookings', { room_id: a, guest_name: 'Ravi', check_in: d(5), check_out: d(7) })).status === 201);
    t('same dates in another room allowed', (await call('POST', '/bookings', { room_id: b, guest_name: 'Ravi', check_in: d(4), check_out: d(7) })).status === 201);
    t('check-out before check-in rejected', (await call('POST', '/bookings', { room_id: a, guest_name: 'X', check_in: d(9), check_out: d(8) })).status === 400);
    t('past check-in rejected', (await call('POST', '/bookings', { room_id: a, guest_name: 'X', check_in: d(-3), check_out: d(1) })).status === 400);
    t('blank guest rejected', (await call('POST', '/bookings', { room_id: a, guest_name: ' ', check_in: d(9), check_out: d(10) })).status === 400);
    t('unknown room -> 404', (await call('POST', '/bookings', { room_id: 999, guest_name: 'X', check_in: d(9), check_out: d(10) })).status === 404);

    const av = (await call('GET', `/rooms/available?type=Single&check_in=${d(3)}&check_out=${d(4)}`)).data;
    t('search excludes booked room', av.length === 0);
    const withDates = (await call('GET', `/rooms?check_in=${d(3)}&check_out=${d(4)}`)).data;
    t('room list shows status for a date range', withDates.find(r => r.id === a).status === 'Booked' && withDates.find(r => r.id === a).busy_guest === 'Asha');
    t('room list shows Available today', (await call('GET', '/rooms')).data.every(r => r.status === 'Available'));
    t('invalid date range rejected', (await call('GET', `/rooms?check_in=${d(5)}&check_out=${d(3)}`)).status === 400);
    t('room search by number', (await call('GET', '/rooms?q=201')).data.length === 1);
    t('room filter by type', (await call('GET', '/rooms?type=Suite')).data.length === 0);

    t('bookings search by guest', (await call('GET', '/bookings?q=asha')).data.length === 1);
    t('bookings filter: upcoming', (await call('GET', '/bookings?status=upcoming')).data.length === 3);
    t('bookings filter: staying now', (await call('GET', '/bookings?status=current')).data.length === 0);

    t('edit to clashing dates blocked (409)', (await call('PUT', `/bookings/${b1.data.id}`, { check_in: d(2), check_out: d(6) })).status === 409);
    t('edit to free dates works', (await call('PUT', `/bookings/${b1.data.id}`, { check_in: d(2), check_out: d(4) })).status === 200);
    t('edit unknown booking -> 404', (await call('PUT', '/bookings/9999', { check_out: d(9) })).status === 404);

    const s = (await call('GET', '/summary')).data;
    t('summary counts', s.rooms === 2 && s.upcoming === 3 && s.occupied === 0 && s.available === 2 && s.value > 0);

    t('cancel booking works', (await call('DELETE', `/bookings/${b1.data.id}`)).status === 200);
    t('cancel non-existent booking -> 404', (await call('DELETE', '/bookings/9999')).status === 404);
    t('delete room cascades bookings', (await call('DELETE', `/rooms/${a}`)).status === 200 && (await call('GET', '/bookings')).data.length === 1);
    console.log(`\nAll ${pass} tests passed`);
  } catch (e) { console.error('✗ FAILED:', e.message); process.exitCode = 1; }
  server.close();
});
