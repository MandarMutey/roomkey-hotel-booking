// Roomkey front end. Mini project by Mandar Mutey.
const $ = s => document.querySelector(s);
const state = { view: 'rooms', roomQ: '', type: '', from: '', to: '', bookingQ: '', bstatus: '', mode: 'room', editId: null };
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd(new Date());
const fmtDate = s => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const nightsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { field: data.field });
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 2800);
}
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- Occupancy panel ----------
const loadSummary = safe(async () => {
  const s = await api('/summary');
  $('#healthBar').innerHTML = s.rooms
    ? `<span class="busy" style="flex-grow:${s.occupied}"></span><span class="ok" style="flex-grow:${s.available}"></span>` : '';
  $('#freeCount').textContent = s.available; $('#busyCount').textContent = s.occupied;
  $('#tRooms').textContent = s.rooms; $('#tUpcoming').textContent = s.upcoming; $('#tValue').textContent = inr.format(s.value);
  $('#healthText').textContent = !s.rooms ? 'No rooms added yet.'
    : `${s.occupied} of ${s.rooms} rooms occupied (${Math.round(s.occupied / s.rooms * 100)}%).`;
});
const refresh = () => { loadSummary(); state.view === 'rooms' ? loadRooms() : loadBookings(); };

// ---------- Views ----------
document.querySelectorAll('.view').forEach(b => b.onclick = () => {
  state.view = b.dataset.view;
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x === b));
  $('#roomsView').hidden = state.view !== 'rooms'; $('#bookingsView').hidden = state.view !== 'bookings';
  refresh();
});

// ---------- Rooms ----------
const hasDates = () => state.from && state.to;
const loadRooms = safe(async () => {
  const p = new URLSearchParams();
  if (state.roomQ) p.set('q', state.roomQ);
  if (state.type) p.set('type', state.type);
  if (hasDates()) { p.set('check_in', state.from); p.set('check_out', state.to); }
  let rooms;
  try { rooms = await api('/rooms?' + p); }
  catch (e) { $('#roomHint').textContent = e.message; return; }
  $('#clearDates').hidden = !(state.from || state.to);
  $('#roomHint').textContent = hasDates()
    ? `Showing availability for ${fmtDate(state.from)} to ${fmtDate(state.to)} (${nightsBetween(state.from, state.to)} night(s)).`
    : (state.from || state.to ? 'Pick both a check-in and a check-out date to check availability.' : 'Status shown for today.');
  $('#roomRows').innerHTML = rooms.map(r => `
    <tr data-id="${r.id}">
      <td><div class="pname">Room ${esc(r.room_no)}</div></td>
      <td>${esc(r.type)}</td>
      <td class="num">${inr.format(r.price)}</td>
      <td><span class="pill ${r.status}">${r.status}</span>
          ${r.busy_guest ? `<div class="psub">${esc(r.busy_guest)}, until ${fmtDate(r.busy_until)}</div>` : ''}</td>
      <td><div class="row-actions">
        ${r.status === 'Available' ? '<button class="link strong" data-act="book">Book</button>' : ''}
        <button class="link danger" data-act="delroom">Delete</button></div></td></tr>`).join('');
  const empty = $('#roomEmpty'); empty.hidden = rooms.length > 0;
  if (!rooms.length) empty.textContent = (state.roomQ || state.type)
    ? 'No rooms match these filters. Clear the search or pick another type.'
    : 'No rooms yet. Select Add room to create the first one.';
  window._rooms = rooms;
});
$('#roomSearch').oninput = e => { state.roomQ = e.target.value; loadRooms(); };
$('#roomType').onchange = e => { state.type = e.target.value; loadRooms(); };
$('#fromDate').min = todayStr();
$('#fromDate').onchange = e => { state.from = e.target.value; $('#toDate').min = state.from; loadRooms(); };
$('#toDate').onchange = e => { state.to = e.target.value; loadRooms(); };
$('#clearDates').onclick = () => { state.from = state.to = ''; $('#fromDate').value = $('#toDate').value = ''; loadRooms(); };

$('#roomRows').onclick = safe(async e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const id = +btn.closest('tr').dataset.id;
  if (btn.dataset.act === 'book') openDialog('book', { room_id: id, check_in: state.from, check_out: state.to });
  if (btn.dataset.act === 'delroom') {
    const r = window._rooms.find(x => x.id === id);
    if (!confirm(`Delete room ${r.room_no} and all of its bookings?`)) return;
    await api('/rooms/' + id, 'DELETE'); toast(`Room ${r.room_no} deleted.`); refresh();
  }
});

// ---------- Bookings ----------
const STATUS_LABEL = { current: 'Staying now', upcoming: 'Upcoming', past: 'Completed' };
const loadBookings = safe(async () => {
  const p = new URLSearchParams();
  if (state.bookingQ) p.set('q', state.bookingQ);
  if (state.bstatus) p.set('status', state.bstatus);
  const list = await api('/bookings?' + p);
  window._bookings = list;
  $('#bookingRows').innerHTML = list.map(b => `
    <tr data-id="${b.id}">
      <td><div class="pname">${esc(b.guest_name)}</div></td>
      <td>Room ${esc(b.room_no)}<div class="psub">${esc(b.type)}</div></td>
      <td>${fmtDate(b.check_in)}</td><td>${fmtDate(b.check_out)}</td>
      <td class="num">${b.nights}</td><td class="num">${inr.format(b.nights * b.price)}</td>
      <td><span class="pill ${b.status}">${STATUS_LABEL[b.status]}</span></td>
      <td><div class="row-actions">
        ${b.status !== 'past' ? '<button class="link" data-act="edit">Edit</button><button class="link danger" data-act="cancel">Cancel</button>' : ''}
      </div></td></tr>`).join('');
  const empty = $('#bookingEmpty'); empty.hidden = list.length > 0;
  if (!list.length) empty.textContent = (state.bookingQ || state.bstatus)
    ? 'No bookings match these filters.' : 'No bookings yet. Select New booking to make the first one.';
});
$('#bookingSearch').oninput = e => { state.bookingQ = e.target.value; loadBookings(); };
document.querySelectorAll('.chip').forEach(c => c.onclick = () => {
  state.bstatus = c.dataset.status;
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c)); loadBookings();
});
$('#bookingRows').onclick = safe(async e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const b = window._bookings.find(x => x.id === +btn.closest('tr').dataset.id);
  if (btn.dataset.act === 'edit') openDialog('edit', b);
  if (btn.dataset.act === 'cancel') {
    if (!confirm(`Cancel ${b.guest_name}'s booking for room ${b.room_no}?`)) return;
    await api('/bookings/' + b.id, 'DELETE'); toast('Booking cancelled.'); refresh();
  }
});

// ---------- Dialog (add room / new booking / edit booking) ----------
const dlg = $('#dlg'), form = $('#form');
const TITLES = { room: 'Add room', book: 'New booking', edit: 'Edit booking' };

async function openDialog(mode, v = {}) {
  state.mode = mode; state.editId = mode === 'edit' ? v.id : null;
  form.reset(); clearErrors();
  $('#dlgTitle').textContent = TITLES[mode];
  form.querySelectorAll('[data-mode]').forEach(el => (el.hidden = !el.dataset.mode.split(' ').includes(mode)));
  if (mode !== 'room') {
    const rooms = await api('/rooms');
    $('#roomPick').innerHTML = rooms.map(r => `<option value="${r.id}">Room ${esc(r.room_no)} · ${esc(r.type)} · ${inr.format(r.price)}</option>`).join('');
    window._priceById = Object.fromEntries(rooms.map(r => [r.id, r.price]));
    form.room_id.value = v.room_id || rooms[0]?.id || '';
    form.room_id.disabled = mode === 'edit';
    form.guest_name.value = v.guest_name || '';
    form.check_in.value = v.check_in || ''; form.check_out.value = v.check_out || '';
    form.check_in.min = mode === 'book' ? todayStr() : '';
    updateQuote();
  }
  dlg.showModal();
  (mode === 'room' ? form.room_no : mode === 'book' ? form.guest_name : form.guest_name).focus();
}
function updateQuote() {
  const q = $('#quote'), { check_in: a, check_out: b, room_id } = form;
  const n = a.value && b.value ? nightsBetween(a.value, b.value) : 0;
  q.hidden = !(n > 0 && window._priceById?.[room_id.value]);
  if (!q.hidden) q.innerHTML = `${n} night(s) × ${inr.format(window._priceById[room_id.value])} = <b>${inr.format(n * window._priceById[room_id.value])}</b>`;
}
['check_in', 'check_out', 'room_id'].forEach(n => form[n].addEventListener('change', updateQuote));
function clearErrors() { $('#formError').textContent = ''; form.querySelectorAll('.bad').forEach(e => e.classList.remove('bad')); }

$('#addRoomBtn').onclick = () => openDialog('room');
$('#newBookingBtn').onclick = safe(() => openDialog('book', { check_in: state.from, check_out: state.to }));
$('#cancel').onclick = () => dlg.close();

form.onsubmit = async e => {
  e.preventDefault(); clearErrors();
  const f = Object.fromEntries(new FormData(form));
  try {
    if (state.mode === 'room') { await api('/rooms', 'POST', f); toast(`Room ${f.room_no} added.`); }
    else if (state.mode === 'book') { await api('/bookings', 'POST', { ...f, room_id: +f.room_id }); toast('Booking confirmed.'); }
    else { await api('/bookings/' + state.editId, 'PUT', f); toast('Booking updated.'); }
    dlg.close(); refresh();
  } catch (err) {
    $('#formError').textContent = err.message;
    if (err.field && form[err.field]) { form[err.field].classList.add('bad'); form[err.field].focus(); }
  }
};

refresh();
