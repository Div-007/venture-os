// Runs once, when the database volume is first created: the app gets its own user limited to its database.
const dbName = process.env.MONGODB_DB || "venture_studio";
db.getSiblingDB(dbName).createUser({
  user: process.env.MONGO_APP_USERNAME || "venture_app",
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: "readWrite", db: dbName }],
});
