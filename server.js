const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.join(__dirname, 'data', 'db.json');
const ADMIN_INVITE_CODE = process.env.ADMIN_INVITE_CODE || 'CMNR-ADMIN-2026';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const VALID_ROLES = ['CNA', 'Nurse'];
const VALID_SHIFT_TYPES = ['Day 7a-7p', 'Night 7p-7a'];

const sessions = new Map();

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readDb() {
  if (!fs.existsSync(DATA_PATH)) return { users: [], shifts: [] };
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, originalHash] = passwordHash.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1e6) req.socket.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
  });
}

function getUserFromAuth(req, db) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, 'public', safePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const ext = path.extname(filePath);
  const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(filePath));
}

function sanitizeRole(value) {
  if (!value) return '';
  if (String(value).toLowerCase() === 'nurse') return 'Nurse';
  if (String(value).toLowerCase() === 'cna') return 'CNA';
  return String(value);
}

function initializeData() {
  const db = readDb();
  if (!db.users.some((u) => u.role === 'admin')) {
    db.users.push({
      id: crypto.randomUUID(),
      fullName: 'CMNR Admin',
      email: 'admin@colonialmanor.local',
      passwordHash: hashPassword('Admin#1234'),
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
  }

  if (db.shifts.length === 0) {
    [
      { date: '2026-02-20', shiftType: 'Day 7a-7p', unit: 'Skilled Nursing', neededRole: 'CNA' },
      { date: '2026-02-20', shiftType: 'Night 7p-7a', unit: 'Skilled Nursing', neededRole: 'Nurse' },
      { date: '2026-02-21', shiftType: 'Day 7a-7p', unit: 'Memory Care', neededRole: 'CNA' },
      { date: '2026-02-21', shiftType: 'Night 7p-7a', unit: 'Memory Care', neededRole: 'Nurse' },
    ].forEach((template) => {
      db.shifts.push({
        id: crypto.randomUUID(),
        ...template,
        status: 'open',
        pickedByUserId: null,
        callInReason: null,
        createdAt: new Date().toISOString(),
      });
    });
  }

  writeDb(db);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/auth/signup') {
      const body = await parseBody(req);
      const { fullName, email, password, role = 'normal', inviteCode } = body;
      if (!fullName || !email || !password) return json(res, 400, { message: 'Name, email, and password are required.' });

      const db = readDb();
      if (db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
        return json(res, 409, { message: 'Email already in use.' });
      }

      let resolvedRole = 'normal';
      if (role === 'admin') {
        if (inviteCode !== ADMIN_INVITE_CODE) return json(res, 403, { message: 'Invalid admin invite code.' });
        resolvedRole = 'admin';
      }

      db.users.push({
        id: crypto.randomUUID(),
        fullName,
        email,
        passwordHash: hashPassword(password),
        role: resolvedRole,
        createdAt: new Date().toISOString(),
      });
      writeDb(db);
      return json(res, 201, { message: 'Account created successfully.' });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await parseBody(req);
      const db = readDb();
      const user = db.users.find((u) => u.email.toLowerCase() === String(body.email || '').toLowerCase());
      if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
        return json(res, 401, { message: 'Invalid credentials.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + TOKEN_TTL_MS });

      return json(res, 200, {
        token,
        user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role },
      });
    }

    if (req.method === 'GET' && pathname === '/api/shifts') {
      const db = readDb();
      const user = getUserFromAuth(req, db);
      if (!user) return json(res, 401, { message: 'Unauthorized.' });
      const shifts = db.shifts.map((shift) => ({
        ...shift,
        pickedBy: shift.pickedByUserId ? db.users.find((u) => u.id === shift.pickedByUserId)?.fullName || null : null,
      }));
      return json(res, 200, shifts);
    }

    if (req.method === 'POST' && pathname === '/api/shifts') {
      const db = readDb();
      const user = getUserFromAuth(req, db);
      if (!user) return json(res, 401, { message: 'Unauthorized.' });
      if (user.role !== 'admin') return json(res, 403, { message: 'Admin only route.' });
      const body = await parseBody(req);

      const neededRole = sanitizeRole(body.neededRole);
      if (!body.date || !body.shiftType || !body.unit || !neededRole) {
        return json(res, 400, { message: 'date, shiftType, unit, and neededRole are required.' });
      }
      if (!VALID_SHIFT_TYPES.includes(body.shiftType)) {
        return json(res, 400, { message: `shiftType must be one of: ${VALID_SHIFT_TYPES.join(', ')}` });
      }
      if (!VALID_ROLES.includes(neededRole)) {
        return json(res, 400, { message: `neededRole must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const shift = {
        id: crypto.randomUUID(),
        date: body.date,
        shiftType: body.shiftType,
        unit: body.unit,
        neededRole,
        status: 'open',
        pickedByUserId: null,
        callInReason: null,
        createdAt: new Date().toISOString(),
      };
      db.shifts.push(shift);
      writeDb(db);
      return json(res, 201, shift);
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/shifts\/[^/]+\/pickup$/)) {
      const shiftId = pathname.split('/')[3];
      const db = readDb();
      const user = getUserFromAuth(req, db);
      if (!user) return json(res, 401, { message: 'Unauthorized.' });
      const shift = db.shifts.find((s) => s.id === shiftId);
      if (!shift) return json(res, 404, { message: 'Shift not found.' });
      if (shift.status !== 'open') return json(res, 409, { message: 'Shift is no longer open.' });
      shift.status = 'picked';
      shift.pickedByUserId = user.id;
      writeDb(db);
      return json(res, 200, { message: 'Shift picked up successfully.' });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/shifts\/[^/]+\/callin$/)) {
      const shiftId = pathname.split('/')[3];
      const body = await parseBody(req);
      const db = readDb();
      const user = getUserFromAuth(req, db);
      if (!user) return json(res, 401, { message: 'Unauthorized.' });
      const shift = db.shifts.find((s) => s.id === shiftId);
      if (!shift) return json(res, 404, { message: 'Shift not found.' });
      if (shift.status !== 'picked') return json(res, 409, { message: 'Only picked shifts can be called in.' });
      if (shift.pickedByUserId !== user.id && user.role !== 'admin') {
        return json(res, 403, { message: 'Only the assigned user or admin can call in this shift.' });
      }
      // Re-open called-in shifts so another eligible user can pick them up.
      shift.status = 'open';
      shift.pickedByUserId = null;
      shift.callInReason = body.reason || 'No reason provided.';
      writeDb(db);
      return json(res, 200, { message: 'Call in recorded successfully.' });
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const db = readDb();
      const user = getUserFromAuth(req, db);
      if (!user) return json(res, 401, { message: 'Unauthorized.' });
      if (user.role !== 'admin') return json(res, 403, { message: 'Admin only route.' });
      return json(res, 200, db.users.map(({ passwordHash, ...rest }) => rest));
    }

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    return json(res, 404, { message: 'Route not found.' });
  } catch (error) {
    return json(res, 500, { message: error.message || 'Internal server error.' });
  }
});

initializeData();
server.listen(PORT, () => {
  console.log(`CMNR Schedule app running on http://localhost:${PORT}`);
});
