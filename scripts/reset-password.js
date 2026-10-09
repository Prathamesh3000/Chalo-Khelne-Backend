require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
// Without this, SRV lookup fails with `querySrv ECONNREFUSED` on machines where
// Node's resolver falls back to 127.0.0.1 — the server has the same guard.
require("../utils/dnsGuard");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const EMAIL = "sagar.talekar@gmail.com";
const NEW_PASSWORD = "p22092003";

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const User = mongoose.connection.collection("users");

  const before = await User.findOne(
    { email: EMAIL },
    { projection: { _id: 1, name: 1, email: 1, role: 1, roles: 1, isApproved: 1, status: 1 } }
  );
  if (!before) {
    console.error(`No user found with email ${EMAIL}`);
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log("Found user:", before);

  const hash = await bcrypt.hash(NEW_PASSWORD, 10);
  const res = await User.updateOne(
    { _id: before._id },
    { $set: { password: hash, passwordChangedAt: new Date(), updatedAt: new Date() } }
  );
  console.log("Update result:", res);

  const check = await User.findOne({ _id: before._id }, { projection: { password: 1 } });
  const verifies = await bcrypt.compare(NEW_PASSWORD, check.password);
  console.log("New hash verifies:", verifies);

  await mongoose.disconnect();
  process.exit(verifies ? 0 : 3);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(99);
});
