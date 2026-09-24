import express from "express";
import cors from "cors";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const db = new DatabaseSync(process.env.DB_FILE || "central-verification.db");
const port = Number(process.env.PORT || 8090);
const adminKey = process.env.ADMIN_IMPORT_KEY || "local-dev-import-key";
const exportSigningKeys = {
  "cms-production-v1": process.env.CMS_EXPORT_SIGNING_KEY,
};

app.use(cors());
app.use(express.json({ limit: "12mb" }));

db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, name TEXT NOT NULL,
    description TEXT, organizer TEXT, venue TEXT, start_date TEXT, end_date TEXT, status TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, event_id INTEGER NOT NULL,
    name TEXT NOT NULL, type TEXT, description TEXT, start_date_time TEXT, end_date_time TEXT,
    venue TEXT, coordinator TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, name TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, certificate_number TEXT NOT NULL UNIQUE,
    verification_token TEXT NOT NULL UNIQUE, participant_id INTEGER NOT NULL, program_id INTEGER NOT NULL,
    issued_date TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(participant_id) REFERENCES participants(id), FOREIGN KEY(program_id) REFERENCES programs(id)
  );
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, imported_at TEXT NOT NULL,
    status TEXT NOT NULL, summary_json TEXT NOT NULL, signature_verified INTEGER NOT NULL DEFAULT 0,
    signature_algorithm TEXT, key_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_certificates_token ON certificates(verification_token);
`);
try { db.exec("ALTER TABLE import_batches ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE import_batches ADD COLUMN signature_algorithm TEXT"); } catch {}
try { db.exec("ALTER TABLE import_batches ADD COLUMN key_id TEXT"); } catch {}

const now = () => new Date().toISOString();
const key = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const normalize = (value) => String(value ?? "").trim().toLowerCase();
const safeStatus = (status) => String(status || "VALID").toUpperCase();

function canonicalize(value, securityNode = false) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((name) => !(securityNode && name === "signature")).sort().map((name) => `${JSON.stringify(name)}:${canonicalize(value[name], name === "security")}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifyExportSignature(data) {
  const security = data?.security;
  if (!security?.algorithm || !security?.keyId || !security?.signature) {
    return { ok: false, code: "UNSIGNED_EXPORT", message: "This export file is not signed and cannot be imported." };
  }
  if (security.algorithm !== "HMAC-SHA256") {
    return { ok: false, code: "UNSUPPORTED_SIGNATURE_ALGORITHM", message: "The export uses an unsupported signature algorithm." };
  }
  const secret = exportSigningKeys[security.keyId];
  if (!secret) return { ok: false, code: "UNKNOWN_KEY_ID", message: "The export signing key is not supported." };
  try {
    const expected = crypto.createHmac("sha256", secret).update(canonicalize(data), "utf8").digest();
    const supplied = Buffer.from(security.signature, "base64");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) {
      return { ok: false, code: "INVALID_EXPORT_SIGNATURE", message: "The export file signature is invalid or the file has been modified." };
    }
    return { ok: true, algorithm: security.algorithm, keyId: security.keyId };
  } catch {
    return { ok: false, code: "INVALID_EXPORT_SIGNATURE", message: "The export file signature is invalid or the file has been modified." };
  }
}

function requireSignedPackage(data, res) {
  const security = verifyExportSignature(data);
  if (!security.ok) {
    res.status(400).json({ success: false, code: security.code, message: security.message });
    return null;
  }
  return security;
}

function validatePackage(data) {
  const errors = [];
  if (!data || data.version !== 3) errors.push("Only version 3 export packages are supported.");
  for (const name of ["events", "programs", "participants", "certificates"]) {
    if (!Array.isArray(data?.[name])) errors.push(`${name} must be an array.`);
  }
  if (errors.length) return errors;
  const eventKeys = new Set(data.events.map((item) => item.key));
  const programKeys = new Set(data.programs.map((item) => item.key));
  const participantKeys = new Set(data.participants.map((item) => item.key));
  const seenTokens = new Set();
  const seenNumbers = new Set();
  data.events.forEach((item, index) => { if (!item.key || !item.name) errors.push(`events[${index}] requires key and name.`); });
  data.programs.forEach((item, index) => {
    if (!item.key || !item.name || !eventKeys.has(item.eventKey)) errors.push(`programs[${index}] has an invalid eventKey or missing fields.`);
  });
  data.participants.forEach((item, index) => { if (!item.key || !item.name) errors.push(`participants[${index}] requires key and name.`); });
  data.certificates.forEach((item, index) => {
    if (!item.verificationToken || !item.certificateNumber || !programKeys.has(item.programKey) || !participantKeys.has(item.participantKey)) errors.push(`certificates[${index}] has invalid references or missing identity fields.`);
    if (seenTokens.has(item.verificationToken)) errors.push(`Duplicate verificationToken in package: ${item.verificationToken}`);
    if (seenNumbers.has(item.certificateNumber)) errors.push(`Duplicate certificateNumber in package: ${item.certificateNumber}`);
    seenTokens.add(item.verificationToken); seenNumbers.add(item.certificateNumber);
  });
  return errors;
}

function summarize(data) {
  const summary = { eventsCreated: 0, eventsMatched: 0, programsCreated: 0, programsMatched: 0, participantsCreated: 0, participantsMatched: 0, certificatesCreated: 0, certificatesAlreadyImported: 0, conflicts: 0, errors: 0 };
  const conflicts = [];
  const eventMap = new Map(); const programMap = new Map(); const participantMap = new Map();
  for (const event of data.events) {
    const existing = db.prepare("SELECT * FROM events WHERE source_key = ? OR (name = ? AND organizer = ? AND start_date = ? AND end_date = ? AND venue = ?)").get(event.key, event.name, event.organizer || null, event.startDate || null, event.endDate || null, event.venue || null);
    eventMap.set(event.key, existing?.id || null); existing ? summary.eventsMatched++ : summary.eventsCreated++;
  }
  for (const program of data.programs) {
    const eventId = eventMap.get(program.eventKey);
    const existing = db.prepare("SELECT * FROM programs WHERE source_key = ? OR (event_id = ? AND name = ? AND start_date_time = ? AND end_date_time = ?)").get(program.key, eventId, program.name, program.startDateTime || null, program.endDateTime || null);
    programMap.set(program.key, existing?.id || null); existing ? summary.programsMatched++ : summary.programsCreated++;
  }
  for (const participant of data.participants) {
    const existing = db.prepare("SELECT * FROM participants WHERE source_key = ?").get(participant.key);
    participantMap.set(participant.key, existing?.id || null); existing ? summary.participantsMatched++ : summary.participantsCreated++;
  }
  for (const certificate of data.certificates) {
    const existing = db.prepare("SELECT * FROM certificates WHERE verification_token = ?").get(certificate.verificationToken);
    if (!existing) { summary.certificatesCreated++; continue; }
    const participantId = participantMap.get(certificate.participantKey);
    const programId = programMap.get(certificate.programKey);
    const matches = existing.certificate_number === certificate.certificateNumber && existing.participant_id === participantId && existing.program_id === programId && existing.issued_date === (certificate.issuedDate || null) && existing.status === safeStatus(certificate.status);
    if (matches) summary.certificatesAlreadyImported++; else { summary.conflicts++; conflicts.push({ status: "CONFLICT", verificationToken: certificate.verificationToken, reason: "Existing certificate data differs from imported certificate" }); }
  }
  return { summary, conflicts };
}

function requireAdmin(req, res, next) {
  if (req.get("x-admin-key") !== adminKey) return res.status(401).json({ message: "Admin authentication required." });
  next();
}

app.post("/api/v1/admin/import/preview", requireAdmin, upload.single("file"), (req, res) => {
  try {
    const data = req.file ? JSON.parse(req.file.buffer.toString("utf8")) : req.body;
    const security = requireSignedPackage(data, res);
    if (!security) return;
    const errors = validatePackage(data);
    if (errors.length) return res.status(400).json({ status: "INVALID", errors });
    const result = summarize(data);
    res.json({ status: result.summary.conflicts ? "CONFLICTS" : "VALID", security: { verified: true, algorithm: security.algorithm, keyId: security.keyId }, summary: result.summary, conflicts: result.conflicts });
  } catch (error) { res.status(400).json({ status: "INVALID", errors: ["Uploaded content is not valid JSON."] }); }
});

app.post("/api/v1/admin/import", requireAdmin, upload.single("file"), (req, res) => {
  try {
    const data = req.file ? JSON.parse(req.file.buffer.toString("utf8")) : req.body;
    const security = requireSignedPackage(data, res);
    if (!security) return;
    const errors = validatePackage(data);
    if (errors.length) return res.status(400).json({ status: "INVALID", errors });
    const preview = summarize(data);
    if (preview.summary.conflicts) return res.status(409).json({ status: "CONFLICTS", summary: preview.summary, conflicts: preview.conflicts });
    db.exec("BEGIN");
    try {
      const eventMap = new Map(); const programMap = new Map(); const participantMap = new Map();
      for (const event of data.events) {
        let row = db.prepare("SELECT * FROM events WHERE source_key = ? OR (name = ? AND organizer = ? AND start_date = ? AND end_date = ? AND venue = ?)").get(event.key, event.name, event.organizer || null, event.startDate || null, event.endDate || null, event.venue || null);
        if (!row) { const stamp = now(); const result = db.prepare("INSERT INTO events (source_key,name,description,organizer,venue,start_date,end_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(event.key,event.name,event.description||null,event.organizer||null,event.venue||null,event.startDate||null,event.endDate||null,safeStatus(event.status),stamp,stamp); row = { id: result.lastInsertRowid }; }
        eventMap.set(event.key, row.id);
      }
      for (const program of data.programs) {
        let row = db.prepare("SELECT * FROM programs WHERE source_key = ?").get(program.key);
        if (!row) { const stamp = now(); const result = db.prepare("INSERT INTO programs (source_key,event_id,name,type,description,start_date_time,end_date_time,venue,coordinator,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(program.key,eventMap.get(program.eventKey),program.name,program.type||null,program.description||null,program.startDateTime||null,program.endDateTime||null,program.venue||null,program.coordinator||null,safeStatus(program.status),stamp,stamp); row = { id: result.lastInsertRowid }; }
        programMap.set(program.key, row.id);
      }
      for (const participant of data.participants) {
        let row = db.prepare("SELECT * FROM participants WHERE source_key = ?").get(participant.key);
        if (!row) { const stamp = now(); const result = db.prepare("INSERT INTO participants (source_key,name,created_at,updated_at) VALUES (?,?,?,?)").run(participant.key,participant.name,stamp,stamp); row = { id: result.lastInsertRowid }; }
        participantMap.set(participant.key, row.id);
      }
      for (const certificate of data.certificates) {
        const existing = db.prepare("SELECT id FROM certificates WHERE verification_token = ?").get(certificate.verificationToken);
        if (!existing) { const stamp = now(); db.prepare("INSERT INTO certificates (certificate_number,verification_token,participant_id,program_id,issued_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(certificate.certificateNumber,certificate.verificationToken,participantMap.get(certificate.participantKey),programMap.get(certificate.programKey),certificate.issuedDate||null,safeStatus(certificate.status),stamp,stamp); }
      }
      const result = db.prepare("INSERT INTO import_batches (version, imported_at, status, summary_json, signature_verified, signature_algorithm, key_id) VALUES (?,?,?,?,?,?,?)").run(3, now(), "COMPLETED", JSON.stringify(preview.summary), 1, security.algorithm, security.keyId);
      db.exec("COMMIT");
      const batchId = result.lastInsertRowid;
    res.json({ success: true, status: "COMPLETED", importBatchId: batchId, security: { verified: true, algorithm: security.algorithm, keyId: security.keyId }, summary: preview.summary });
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { res.status(500).json({ status: "FAILED", message: "Import failed without changing the database." }); }
});

app.get("/api/v1/public/verify/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token || token.length > 255) return res.status(400).json({ verified: false, message: "Certificate could not be verified." });
  const row = db.prepare(`SELECT c.certificate_number, c.verification_token, c.issued_date, c.status, p.name AS participant_name,
    pr.name AS program_name, pr.type AS program_type, pr.description AS program_description, pr.start_date_time, pr.end_date_time, pr.venue AS program_venue, pr.coordinator,
    e.name AS event_name, e.description AS event_description, e.organizer, e.venue AS event_venue, e.start_date, e.end_date
    FROM certificates c JOIN participants p ON p.id = c.participant_id JOIN programs pr ON pr.id = c.program_id JOIN events e ON e.id = pr.event_id WHERE c.verification_token = ?`).get(token);
  if (!row) return res.status(404).json({ verified: false, message: "Certificate could not be verified." });
  res.json({ verified: row.status === "VALID", certificate: { certificateNumber: row.certificate_number, recipientName: row.participant_name, issuedDate: row.issued_date, status: row.status }, program: { name: row.program_name, type: row.program_type, description: row.program_description, startDateTime: row.start_date_time, endDateTime: row.end_date_time, venue: row.program_venue, coordinator: row.coordinator }, event: { name: row.event_name, description: row.event_description, organizer: row.organizer, venue: row.event_venue, startDate: row.start_date, endDate: row.end_date } });
});

app.get("/api/v1/admin/import/history", requireAdmin, (req, res) => res.json(db.prepare("SELECT id, version, imported_at AS importedAt, status, summary_json AS summary, signature_verified AS signatureVerified, signature_algorithm AS signatureAlgorithm, key_id AS keyId FROM import_batches ORDER BY id DESC").all().map((item) => ({ ...item, summary: JSON.parse(item.summary) }))));

app.listen(port, () => console.log(`Central verification backend listening on http://localhost:${port}`));
