const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'hotel.db'));
db.pragma('foreign_keys = ON');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no TEXT NOT NULL UNIQUE,
  type    TEXT NOT NULL CHECK (type IN ('Single','Double','Suite')),
  price   REAL NOT NULL CHECK (price > 0)
);
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  check_in   TEXT NOT NULL,
  check_out  TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

if (process.env.SEED_DEMO !== '0' && db.prepare('SELECT COUNT(*) c FROM rooms').get().c === 0) {
  const addRoom = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)');
  [['101','Single',2000],['102','Single',2200],['103','Single',2200],['201','Double',3500],['202','Double',3800],
   ['203','Double',3600],['204','Double',4000],['301','Suite',7500],['302','Suite',9000]].forEach(r => addRoom.run(...r));
  const t = new Date(); const day = n => { const d = new Date(t); d.setDate(d.getDate() + n); return ymd(d); };
  const addBooking = db.prepare('INSERT INTO bookings (room_id,guest_name,check_in,check_out) VALUES (?,?,?,?)');
  [[1,'Ananya Kulkarni',-1,2],[4,'Rohan Deshmukh',-2,1],[5,'Priya Nair',0,3],[8,'Vikram Shah',-1,4],
   [2,'Sneha Joshi',2,5],[6,'Arjun Patil',3,6],[9,'Meera Iyer',5,9],[3,'Kabir Singh',-9,-6]]
    .forEach(([r, g, a, b]) => addBooking.run(r, g, day(a), day(b)));
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const fail = (res, code, msg, field) => res.status(code).json({ error: msg, field });

// Two stays overlap if existing.check_in < new.check_out AND existing.check_out > new.check_in
// (check-out day is free for the next guest)
const OVERLAP = `check_in < @out AND check_out > @in`;

function validateStay(b, keepCheckIn) {
  if (!b.guest_name || !b.guest_name.trim()) return ['Guest name is required', 'guest_name'];
  if (!isDate(b.check_in)) return ['A valid check-in date is required', 'check_in'];
  if (!isDate(b.check_out)) return ['A valid check-out date is required', 'check_out'];
  if (b.check_in < today() && b.check_in !== keepCheckIn) return ['Check-in date cannot be in the past', 'check_in'];
  if (b.check_out <= b.check_in) return ['Check-out must be after check-in', 'check_out'];
  return null;
}

// ---------- Rooms ----------
// List rooms. Optional filters: q (room no), type, and a date range (check_in/check_out).
// Without dates the status is for today.
app.get('/api/rooms', (req, res) => {
  const t = today();
  let { q = '', type = '', check_in, check_out } = req.query;
  if (check_in || check_out) {
    if (!isDate(check_in) || !isDate(check_out) || check_out <= check_in)
      return fail(res, 400, 'Choose a valid check-in and a later check-out date', 'check_out');
  } else { check_in = t; check_out = addDays(t, 1); }
  const rows = db.prepare(`
    SELECT r.*,
      (SELECT b.guest_name FROM bookings b WHERE b.room_id=r.id AND b.check_in < @out AND b.check_out > @in ORDER BY b.check_in LIMIT 1) AS busy_guest,
      (SELECT b.check_out  FROM bookings b WHERE b.room_id=r.id AND b.check_in < @out AND b.check_out > @in ORDER BY b.check_in LIMIT 1) AS busy_until
    FROM rooms r
    WHERE (@type = '' OR r.type = @type) AND (@q = '' OR r.room_no LIKE '%' || @q || '%')
    ORDER BY r.room_no`).all({ in: check_in, out: check_out, type, q: q.trim() });
  res.json(rows.map(r => ({ ...r, status: r.busy_guest ? 'Booked' : 'Available' })));
});

// Dashboard numbers
app.get('/api/summary', (req, res) => {
  const t = today();
  const rooms = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
  const occupied = db.prepare('SELECT COUNT(DISTINCT room_id) c FROM bookings WHERE check_in <= ? AND check_out > ?').get(t, t).c;
  const upcoming = db.prepare('SELECT COUNT(*) c FROM bookings WHERE check_in > ?').get(t).c;
  const active = db.prepare('SELECT COUNT(*) c FROM bookings WHERE check_out > ?').get(t).c;
  const value = db.prepare(`SELECT COALESCE(SUM(CAST(julianday(b.check_out)-julianday(b.check_in) AS INTEGER)*r.price),0) v
    FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.check_out > ?`).get(t).v;
  res.json({ rooms, occupied, available: rooms - occupied, upcoming, active, value });
});

// Search available rooms by type and date range
app.get('/api/rooms/available', (req, res) => {
  const { type, check_in, check_out } = req.query;
  if (!isDate(check_in) || !isDate(check_out) || check_out <= check_in)
    return fail(res, 400, 'Provide valid check_in and check_out (check-out after check-in)');
  const rows = db.prepare(`
    SELECT * FROM rooms r
    WHERE (@type IS NULL OR @type = '' OR r.type = @type)
      AND NOT EXISTS (SELECT 1 FROM bookings WHERE room_id = r.id AND ${OVERLAP})
    ORDER BY r.price`).all({ type: type || null, in: check_in, out: check_out });
  res.json(rows);
});

app.post('/api/rooms', (req, res) => {
  const { room_no, type } = req.body;
  const price = Number(req.body.price);
  if (!room_no || !String(room_no).trim()) return fail(res, 400, 'Room number is required', 'room_no');
  if (!['Single', 'Double', 'Suite'].includes(type)) return fail(res, 400, 'Type must be Single, Double or Suite', 'type');
  if (!(price > 0)) return fail(res, 400, 'Price must be a positive number', 'price');
  try {
    const info = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)')
      .run(String(room_no).trim(), type, price);
    res.status(201).json({ id: info.lastInsertRowid, room_no: String(room_no).trim(), type, price });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return fail(res, 409, `Room ${room_no} already exists`, 'room_no');
    throw e;
  }
});

app.delete('/api/rooms/:id', (req, res) => {
  const info = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Room not found');
  res.json({ message: 'Room deleted' });
});

// ---------- Bookings ----------
app.get('/api/bookings', (req, res) => {
  const t = today();
  const { q = '', status = '' } = req.query;
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT b.*, r.room_no, r.type, r.price,
             CAST(julianday(b.check_out) - julianday(b.check_in) AS INTEGER) AS nights,
             CASE WHEN b.check_out <= @t THEN 'past' WHEN b.check_in > @t THEN 'upcoming' ELSE 'current' END AS status
      FROM bookings b JOIN rooms r ON r.id = b.room_id)
    WHERE (@status = '' OR status = @status)
      AND (@q = '' OR guest_name LIKE '%' || @q || '%' OR room_no LIKE '%' || @q || '%')
    ORDER BY check_in`).all({ t, status, q: q.trim() });
  res.json(rows);
});

app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const err = validateStay(b);
  if (err) return fail(res, 400, ...err);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(b.room_id);
  if (!room) return fail(res, 404, 'Room not found');

  // Transaction makes the check + insert atomic (no double-booking race)
  const book = db.transaction(() => {
    const clash = db.prepare(`SELECT 1 FROM bookings WHERE room_id=@id AND ${OVERLAP}`)
      .get({ id: room.id, in: b.check_in, out: b.check_out });
    if (clash) return null;
    return db.prepare('INSERT INTO bookings (room_id,guest_name,check_in,check_out) VALUES (?,?,?,?)')
      .run(room.id, b.guest_name.trim(), b.check_in, b.check_out).lastInsertRowid;
  });
  const id = book();
  if (!id) return fail(res, 409, `Room ${room.room_no} is already booked for overlapping dates`, 'check_in');
  res.status(201).json({ id, room_no: room.room_no, guest_name: b.guest_name.trim(), check_in: b.check_in, check_out: b.check_out });
});

// Modify dates / guest of an existing booking
app.put('/api/bookings/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!cur) return fail(res, 404, 'Booking not found');
  const b = { guest_name: cur.guest_name, check_in: cur.check_in, check_out: cur.check_out, ...req.body };
  const err = validateStay(b, cur.check_in);
  if (err) return fail(res, 400, ...err);
  const clash = db.prepare(`SELECT 1 FROM bookings WHERE room_id=@rid AND id<>@id AND ${OVERLAP}`)
    .get({ rid: cur.room_id, id: cur.id, in: b.check_in, out: b.check_out });
  if (clash) return fail(res, 409, 'Room is already booked for those dates', 'check_in');
  db.prepare('UPDATE bookings SET guest_name=?, check_in=?, check_out=? WHERE id=?')
    .run(b.guest_name.trim(), b.check_in, b.check_out, cur.id);
  res.json({ message: 'Booking updated' });
});

app.delete('/api/bookings/:id', (req, res) => {
  const info = db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Booking not found');
  res.json({ message: 'Booking cancelled' });
});

// ---------- Error handling ----------
app.use('/api', (req, res) => fail(res, 404, 'Endpoint not found'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON');
  console.error(err); fail(res, 500, 'Internal server error');
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Hotel booking app running at http://localhost:${PORT}`));
}
