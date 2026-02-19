const state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
};

const authCard = document.getElementById('authCard');
const appCard = document.getElementById('appCard');
const adminPanel = document.getElementById('adminPanel');
const welcome = document.getElementById('welcome');
const shiftList = document.getElementById('shiftList');
const nurseCoverageList = document.getElementById('nurseCoverageList');
const cnaCoverageList = document.getElementById('cnaCoverageList');
const toast = document.getElementById('toast');

function showToast(message) {
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 2500);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  refreshUi();
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  refreshUi();
}

function renderCoverageList(listEl, dates) {
  listEl.innerHTML = '';
  if (dates.length === 0) {
    listEl.innerHTML = '<li class="covered">All currently covered ✅</li>';
    return;
  }

  dates.sort().forEach((date) => {
    const li = document.createElement('li');
    li.className = 'needs-coverage';
    li.textContent = date;
    listEl.appendChild(li);
  });
}

function renderCoverageCalendar(shifts) {
  const nurseDates = new Set();
  const cnaDates = new Set();

  shifts.forEach((shift) => {
    if (shift.status !== 'open') return;
    if (shift.neededRole === 'Nurse') nurseDates.add(shift.date);
    if (shift.neededRole === 'CNA') cnaDates.add(shift.date);
  });

  renderCoverageList(nurseCoverageList, [...nurseDates]);
  renderCoverageList(cnaCoverageList, [...cnaDates]);
}

function renderShifts(shifts) {
  shiftList.innerHTML = '';
  if (!shifts.length) {
    shiftList.innerHTML = '<p>No shifts found.</p>';
    return;
  }

  shifts
    .sort((a, b) => `${a.date}-${a.shiftType}`.localeCompare(`${b.date}-${b.shiftType}`))
    .forEach((shift) => {
      const div = document.createElement('div');
      div.className = 'shift';
      div.innerHTML = `
      <strong>${shift.date} | ${shift.shiftType}</strong><br>
      Unit: ${shift.unit} | Needed Role: ${shift.neededRole}<br>
      Status: <b>${shift.status}</b>${shift.pickedBy ? ` | Assigned: ${shift.pickedBy}` : ''}
      ${shift.callInReason ? `<br>Call-In Reason: ${shift.callInReason}` : ''}
    `;

      const actions = document.createElement('div');
      actions.className = 'actions';

      if (shift.status === 'open') {
        const pickupBtn = document.createElement('button');
        pickupBtn.textContent = 'Pick Up Shift';
        pickupBtn.onclick = async () => {
          try {
            await api(`/api/shifts/${shift.id}/pickup`, { method: 'POST' });
            showToast('Shift picked up successfully.');
            loadShifts();
          } catch (error) {
            showToast(error.message);
          }
        };
        actions.appendChild(pickupBtn);
      }

      if (
        shift.status === 'picked' &&
        (shift.pickedByUserId === state.user.id || state.user.role === 'admin')
      ) {
        const callInBtn = document.createElement('button');
        callInBtn.className = 'danger';
        callInBtn.textContent = 'Call In';
        callInBtn.onclick = async () => {
          const reason = prompt('Reason for call in:') || 'No reason provided.';
          try {
            await api(`/api/shifts/${shift.id}/callin`, {
              method: 'POST',
              body: JSON.stringify({ reason }),
            });
            showToast('Call in recorded.');
            loadShifts();
          } catch (error) {
            showToast(error.message);
          }
        };
        actions.appendChild(callInBtn);
      }

      div.appendChild(actions);
      shiftList.appendChild(div);
    });
}

async function loadShifts() {
  try {
    const shifts = await api('/api/shifts');
    renderCoverageCalendar(shifts);
    renderShifts(shifts);
  } catch (error) {
    showToast(error.message);
  }
}

function refreshUi() {
  const loggedIn = Boolean(state.token && state.user);
  authCard.classList.toggle('hidden', loggedIn);
  appCard.classList.toggle('hidden', !loggedIn);

  if (loggedIn) {
    welcome.textContent = `Welcome ${state.user.fullName} (${state.user.role})`;
    adminPanel.classList.toggle('hidden', state.user.role !== 'admin');
    loadShifts();
  }
}

document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const role = document.getElementById('signupRole').value;

  try {
    await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        fullName: document.getElementById('signupName').value,
        email: document.getElementById('signupEmail').value,
        password: document.getElementById('signupPassword').value,
        role,
        inviteCode: document.getElementById('signupInvite').value,
      }),
    });

    showToast('Signup successful. Please log in.');
    e.target.reset();
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value,
      }),
    });
    setSession(data.token, data.user);
    showToast('Logged in.');
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('createShiftForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  try {
    await api('/api/shifts', {
      method: 'POST',
      body: JSON.stringify({
        date: document.getElementById('shiftDate').value,
        shiftType: document.getElementById('shiftType').value,
        unit: document.getElementById('shiftUnit').value,
        neededRole: document.getElementById('shiftRole').value,
      }),
    });

    showToast('Open shift created.');
    e.target.reset();
    loadShifts();
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearSession();
  showToast('Logged out.');
});

refreshUi();
