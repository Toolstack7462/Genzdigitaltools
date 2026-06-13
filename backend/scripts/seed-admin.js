'use strict';
const dotenv = require('dotenv');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysqlAdapter = require('../db/mysqlAdapter');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  await mysqlAdapter.connect();
  const User = require('../models/User');
  const email = (process.env.INITIAL_ADMIN_EMAIL || 'admin@genzdigitalstore.com').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMeStrongPassword123!';
  const fullName = process.env.INITIAL_ADMIN_NAME || 'Super Admin';

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin already exists: ${email}`);
    await mysqlAdapter.close();
    return;
  }
  const hashedPassword = await bcrypt.hash(password, 12);
  const admin = await User.create({
    email,
    fullName,
    passwordHash: hashedPassword,
    _passwordPreHashed: true,
    role: 'SUPER_ADMIN',
    status: 'active',
    devicePolicy: { enabled: false, maxDevices: 10 }
  });
  console.log(`Admin created: ${admin.email} (${admin._id})`);
  await mysqlAdapter.close();
}

main().catch(async (err) => {
  console.error('Seed admin failed:', err);
  try { await mysqlAdapter.close(); } catch (_) {}
  process.exit(1);
});
