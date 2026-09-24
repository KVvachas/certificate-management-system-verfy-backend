import express from "express";
import cors from "cors";
import multer from "multer";
import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;

const app = express();

const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const port = Number(process.env.PORT || 8090);

const adminKey =
  process.env.ADMIN_IMPORT_KEY || "local-dev-import-key";

const exportSigningKeys = {
  "cms-production-v1": process.env.CMS_EXPORT_SIGNING_KEY,
};

const allowedOrigins = [
  "https://cms.vsfreedomsolutions.in",
  "http://localhost:5173",
  "http://localhost:8080"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json({ limit: "12mb" }));

const now = () => new Date().toISOString();

const safeStatus = (status) =>
  String(status || "VALID").toUpperCase();

function canonicalize(value, securityNode = false) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter(
        (name) =>
          !(securityNode && name === "signature")
      )
      .sort()
      .map(
        (name) =>
          `${JSON.stringify(name)}:${canonicalize(
            value[name],
            name === "security"
          )}`
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function verifyExportSignature(data) {
  const security = data?.security;

  if (
    !security?.algorithm ||
    !security?.keyId ||
    !security?.signature
  ) {
    return {
      ok: false,
      code: "UNSIGNED_EXPORT",
      message:
        "This export file is not signed and cannot be imported.",
    };
  }

  if (security.algorithm !== "HMAC-SHA256") {
    return {
      ok: false,
      code: "UNSUPPORTED_SIGNATURE_ALGORITHM",
      message:
        "The export uses an unsupported signature algorithm.",
    };
  }

  const secret = exportSigningKeys[security.keyId];

  if (!secret) {
    return {
      ok: false,
      code: "UNKNOWN_KEY_ID",
      message:
        "The export signing key is not supported.",
    };
  }

  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(canonicalize(data), "utf8")
      .digest();

    const supplied = Buffer.from(
      security.signature,
      "base64"
    );

    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(expected, supplied)
    ) {
      return {
        ok: false,
        code: "INVALID_EXPORT_SIGNATURE",
        message:
          "The export file signature is invalid or the file has been modified.",
      };
    }

    return {
      ok: true,
      algorithm: security.algorithm,
      keyId: security.keyId,
    };
  } catch {
    return {
      ok: false,
      code: "INVALID_EXPORT_SIGNATURE",
      message:
        "The export file signature is invalid or the file has been modified.",
    };
  }
}

function requireSignedPackage(data, res) {
  const security = verifyExportSignature(data);

  if (!security.ok) {
    res.status(400).json({
      success: false,
      code: security.code,
      message: security.message,
    });

    return null;
  }

  return security;
}

function validatePackage(data) {
  const errors = [];

  if (!data || data.version !== 3) {
    errors.push(
      "Only version 3 export packages are supported."
    );
  }

  for (const name of [
    "events",
    "programs",
    "participants",
    "certificates",
  ]) {
    if (!Array.isArray(data?.[name])) {
      errors.push(`${name} must be an array.`);
    }
  }

  if (errors.length) {
    return errors;
  }

  const eventKeys = new Set(
    data.events.map((item) => item.key)
  );

  const programKeys = new Set(
    data.programs.map((item) => item.key)
  );

  const participantKeys = new Set(
    data.participants.map((item) => item.key)
  );

  const seenTokens = new Set();
  const seenNumbers = new Set();

  data.events.forEach((item, index) => {
    if (!item.key || !item.name) {
      errors.push(
        `events[${index}] requires key and name.`
      );
    }
  });

  data.programs.forEach((item, index) => {
    if (
      !item.key ||
      !item.name ||
      !eventKeys.has(item.eventKey)
    ) {
      errors.push(
        `programs[${index}] has an invalid eventKey or missing fields.`
      );
    }
  });

  data.participants.forEach((item, index) => {
    if (!item.key || !item.name) {
      errors.push(
        `participants[${index}] requires key and name.`
      );
    }
  });

  data.certificates.forEach((item, index) => {
    if (
      !item.verificationToken ||
      !item.certificateNumber ||
      !programKeys.has(item.programKey) ||
      !participantKeys.has(item.participantKey)
    ) {
      errors.push(
        `certificates[${index}] has invalid references or missing identity fields.`
      );
    }

    if (seenTokens.has(item.verificationToken)) {
      errors.push(
        `Duplicate verificationToken in package: ${item.verificationToken}`
      );
    }

    if (seenNumbers.has(item.certificateNumber)) {
      errors.push(
        `Duplicate certificateNumber in package: ${item.certificateNumber}`
      );
    }

    seenTokens.add(item.verificationToken);
    seenNumbers.add(item.certificateNumber);
  });

  return errors;
}

async function summarize(data) {
  const summary = {
    eventsCreated: 0,
    eventsMatched: 0,
    programsCreated: 0,
    programsMatched: 0,
    participantsCreated: 0,
    participantsMatched: 0,
    certificatesCreated: 0,
    certificatesAlreadyImported: 0,
    conflicts: 0,
    errors: 0,
  };

  const conflicts = [];

  const eventMap = new Map();
  const programMap = new Map();
  const participantMap = new Map();

  for (const event of data.events) {
    const result = await pool.query(
      `
      SELECT *
      FROM events
      WHERE source_key = $1
         OR (
          name = $2
          AND organizer IS NOT DISTINCT FROM $3
          AND start_date IS NOT DISTINCT FROM $4
          AND end_date IS NOT DISTINCT FROM $5
          AND venue IS NOT DISTINCT FROM $6
         )
      LIMIT 1
      `,
      [
        event.key,
        event.name,
        event.organizer || null,
        event.startDate || null,
        event.endDate || null,
        event.venue || null,
      ]
    );

    const existing = result.rows[0];

    eventMap.set(event.key, existing?.id || null);

    if (existing) {
      summary.eventsMatched++;
    } else {
      summary.eventsCreated++;
    }
  }

  for (const program of data.programs) {
    const eventId = eventMap.get(program.eventKey);

    const result = await pool.query(
      `
      SELECT *
      FROM programs
      WHERE source_key = $1
         OR (
          event_id = $2
          AND name = $3
          AND start_date_time IS NOT DISTINCT FROM $4
          AND end_date_time IS NOT DISTINCT FROM $5
         )
      LIMIT 1
      `,
      [
        program.key,
        eventId,
        program.name,
        program.startDateTime || null,
        program.endDateTime || null,
      ]
    );

    const existing = result.rows[0];

    programMap.set(
      program.key,
      existing?.id || null
    );

    if (existing) {
      summary.programsMatched++;
    } else {
      summary.programsCreated++;
    }
  }

  for (const participant of data.participants) {
    const result = await pool.query(
      `
      SELECT *
      FROM participants
      WHERE source_key = $1
      LIMIT 1
      `,
      [participant.key]
    );

    const existing = result.rows[0];

    participantMap.set(
      participant.key,
      existing?.id || null
    );

    if (existing) {
      summary.participantsMatched++;
    } else {
      summary.participantsCreated++;
    }
  }

  for (const certificate of data.certificates) {
    const result = await pool.query(
      `
      SELECT *
      FROM certificates
      WHERE verification_token = $1
      LIMIT 1
      `,
      [certificate.verificationToken]
    );

    const existing = result.rows[0];

    if (!existing) {
      summary.certificatesCreated++;
      continue;
    }

    const participantId =
      participantMap.get(
        certificate.participantKey
      );

    const programId =
      programMap.get(certificate.programKey);

    const matches =
      existing.certificate_number ===
        certificate.certificateNumber &&
      existing.participant_id === participantId &&
      existing.program_id === programId &&
      existing.issued_date ===
        (certificate.issuedDate || null) &&
      existing.status ===
        safeStatus(certificate.status);

    if (matches) {
      summary.certificatesAlreadyImported++;
    } else {
      summary.conflicts++;

      conflicts.push({
        status: "CONFLICT",
        verificationToken:
          certificate.verificationToken,
        reason:
          "Existing certificate data differs from imported certificate",
      });
    }
  }

  return {
    summary,
    conflicts,
  };
}

function requireAdmin(req, res, next) {
  if (req.get("x-admin-key") !== adminKey) {
    return res.status(401).json({
      message: "Admin authentication required.",
    });
  }

  next();
}

/* --------------------------------
   ADMIN IMPORT PREVIEW
-------------------------------- */

app.post(
  "/api/v1/admin/import/preview",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const data = req.file
        ? JSON.parse(
            req.file.buffer.toString("utf8")
          )
        : req.body;

      const security =
        requireSignedPackage(data, res);

      if (!security) return;

      const errors = validatePackage(data);

      if (errors.length) {
        return res.status(400).json({
          status: "INVALID",
          errors,
        });
      }

      const result = await summarize(data);

      res.json({
        status: result.summary.conflicts
          ? "CONFLICTS"
          : "VALID",
        security: {
          verified: true,
          algorithm: security.algorithm,
          keyId: security.keyId,
        },
        summary: result.summary,
        conflicts: result.conflicts,
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        status: "INVALID",
        errors: [
          "Uploaded content is not valid JSON.",
        ],
      });
    }
  }
);

/* --------------------------------
   ADMIN IMPORT
-------------------------------- */

app.post(
  "/api/v1/admin/import",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const data = req.file
        ? JSON.parse(
            req.file.buffer.toString("utf8")
          )
        : req.body;

      const security =
        requireSignedPackage(data, res);

      if (!security) {
        client.release();
        return;
      }

      const errors = validatePackage(data);

      if (errors.length) {
        client.release();

        return res.status(400).json({
          status: "INVALID",
          errors,
        });
      }

      const preview = await summarize(data);

      if (preview.summary.conflicts) {
        client.release();

        return res.status(409).json({
          status: "CONFLICTS",
          summary: preview.summary,
          conflicts: preview.conflicts,
        });
      }

      await client.query("BEGIN");

      const eventMap = new Map();
      const programMap = new Map();
      const participantMap = new Map();

      /* EVENTS */

      for (const event of data.events) {
        const existingResult =
          await client.query(
            `
            SELECT *
            FROM events
            WHERE source_key = $1
               OR (
                name = $2
                AND organizer IS NOT DISTINCT FROM $3
                AND start_date IS NOT DISTINCT FROM $4
                AND end_date IS NOT DISTINCT FROM $5
                AND venue IS NOT DISTINCT FROM $6
               )
            LIMIT 1
            `,
            [
              event.key,
              event.name,
              event.organizer || null,
              event.startDate || null,
              event.endDate || null,
              event.venue || null,
            ]
          );

        let row = existingResult.rows[0];

        if (!row) {
          const stamp = now();

          const result =
            await client.query(
              `
              INSERT INTO events (
                source_key,
                name,
                description,
                organizer,
                venue,
                start_date,
                end_date,
                status,
                created_at,
                updated_at
              )
              VALUES (
                $1,$2,$3,$4,$5,
                $6,$7,$8,$9,$10
              )
              RETURNING id
              `,
              [
                event.key,
                event.name,
                event.description || null,
                event.organizer || null,
                event.venue || null,
                event.startDate || null,
                event.endDate || null,
                safeStatus(event.status),
                stamp,
                stamp,
              ]
            );

          row = result.rows[0];
        }

        eventMap.set(event.key, row.id);
      }

      /* PROGRAMS */

      for (const program of data.programs) {
        const existingResult =
          await client.query(
            `
            SELECT *
            FROM programs
            WHERE source_key = $1
            LIMIT 1
            `,
            [program.key]
          );

        let row = existingResult.rows[0];

        if (!row) {
          const stamp = now();

          const result =
            await client.query(
              `
              INSERT INTO programs (
                source_key,
                event_id,
                name,
                type,
                description,
                start_date_time,
                end_date_time,
                venue,
                coordinator,
                status,
                created_at,
                updated_at
              )
              VALUES (
                $1,$2,$3,$4,$5,$6,
                $7,$8,$9,$10,$11,$12
              )
              RETURNING id
              `,
              [
                program.key,
                eventMap.get(program.eventKey),
                program.name,
                program.type || null,
                program.description || null,
                program.startDateTime || null,
                program.endDateTime || null,
                program.venue || null,
                program.coordinator || null,
                safeStatus(program.status),
                stamp,
                stamp,
              ]
            );

          row = result.rows[0];
        }

        programMap.set(
          program.key,
          row.id
        );
      }

      /* PARTICIPANTS */

      for (const participant of data.participants) {
        const existingResult =
          await client.query(
            `
            SELECT *
            FROM participants
            WHERE source_key = $1
            LIMIT 1
            `,
            [participant.key]
          );

        let row = existingResult.rows[0];

        if (!row) {
          const stamp = now();

          const result =
            await client.query(
              `
              INSERT INTO participants (
                source_key,
                name,
                created_at,
                updated_at
              )
              VALUES ($1,$2,$3,$4)
              RETURNING id
              `,
              [
                participant.key,
                participant.name,
                stamp,
                stamp,
              ]
            );

          row = result.rows[0];
        }

        participantMap.set(
          participant.key,
          row.id
        );
      }

      /* CERTIFICATES */

      for (const certificate of data.certificates) {
        const existingResult =
          await client.query(
            `
            SELECT id
            FROM certificates
            WHERE verification_token = $1
            LIMIT 1
            `,
            [certificate.verificationToken]
          );

        const existing =
          existingResult.rows[0];

        if (!existing) {
          const stamp = now();

          await client.query(
            `
            INSERT INTO certificates (
              certificate_number,
              verification_token,
              participant_id,
              program_id,
              issued_date,
              status,
              created_at,
              updated_at
            )
            VALUES (
              $1,$2,$3,$4,
              $5,$6,$7,$8
            )
            `,
            [
              certificate.certificateNumber,
              certificate.verificationToken,
              participantMap.get(
                certificate.participantKey
              ),
              programMap.get(
                certificate.programKey
              ),
              certificate.issuedDate || null,
              safeStatus(certificate.status),
              stamp,
              stamp,
            ]
          );
        }
      }

      /* IMPORT HISTORY */

      const result = await client.query(
        `
        INSERT INTO import_batches (
          version,
          imported_at,
          status,
          summary_json,
          signature_verified,
          signature_algorithm,
          key_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
        `,
        [
          3,
          now(),
          "COMPLETED",
          JSON.stringify(
            preview.summary
          ),
          1,
          security.algorithm,
          security.keyId,
        ]
      );

      await client.query("COMMIT");

      const batchId =
        result.rows[0].id;

      res.json({
        success: true,
        status: "COMPLETED",
        importBatchId: batchId,
        security: {
          verified: true,
          algorithm: security.algorithm,
          keyId: security.keyId,
        },
        summary: preview.summary,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Import failed:",
        error
      );

      res.status(500).json({
        status: "FAILED",
        message:
          "Import failed without changing the database.",
      });
    } finally {
      client.release();
    }
  }
);

/* --------------------------------
   PUBLIC CERTIFICATE VERIFICATION
-------------------------------- */

app.get(
  "/api/v1/public/verify/:token",
  async (req, res) => {
    try {
      const token = String(
        req.params.token || ""
      ).trim();

      if (!token || token.length > 255) {
        return res.status(400).json({
          verified: false,
          message:
            "Certificate could not be verified.",
        });
      }

      const result = await pool.query(
        `
        SELECT
          c.certificate_number,
          c.verification_token,
          c.issued_date,
          c.status,

          p.name AS participant_name,

          pr.name AS program_name,
          pr.type AS program_type,
          pr.description AS program_description,
          pr.start_date_time,
          pr.end_date_time,
          pr.venue AS program_venue,
          pr.coordinator,

          e.name AS event_name,
          e.description AS event_description,
          e.organizer,
          e.venue AS event_venue,
          e.start_date,
          e.end_date

        FROM certificates c

        JOIN participants p
          ON p.id = c.participant_id

        JOIN programs pr
          ON pr.id = c.program_id

        JOIN events e
          ON e.id = pr.event_id

        WHERE c.verification_token = $1

        LIMIT 1
        `,
        [token]
      );

      const row = result.rows[0];

      if (!row) {
        return res.status(404).json({
          verified: false,
          message:
            "Certificate could not be verified.",
        });
      }

      res.json({
        verified: row.status === "VALID",

        certificate: {
          certificateNumber:
            row.certificate_number,
          recipientName:
            row.participant_name,
          issuedDate:
            row.issued_date,
          status:
            row.status,
        },

        program: {
          name:
            row.program_name,
          type:
            row.program_type,
          description:
            row.program_description,
          startDateTime:
            row.start_date_time,
          endDateTime:
            row.end_date_time,
          venue:
            row.program_venue,
          coordinator:
            row.coordinator,
        },

        event: {
          name:
            row.event_name,
          description:
            row.event_description,
          organizer:
            row.organizer,
          venue:
            row.event_venue,
          startDate:
            row.start_date,
          endDate:
            row.end_date,
        },
      });
    } catch (error) {
      console.error(
        "Verification error:",
        error
      );

      res.status(500).json({
        verified: false,
        message:
          "Certificate verification failed.",
      });
    }
  }
);

/* --------------------------------
   IMPORT HISTORY
-------------------------------- */

app.get(
  "/api/v1/admin/import/history",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          version,
          imported_at AS "importedAt",
          status,
          summary_json AS summary,
          signature_verified AS "signatureVerified",
          signature_algorithm AS "signatureAlgorithm",
          key_id AS "keyId"
        FROM import_batches
        ORDER BY id DESC
      `);

      const history = result.rows.map(
        (item) => ({
          ...item,
          summary:
            JSON.parse(item.summary),
        })
      );

      res.json(history);
    } catch (error) {
      console.error(
        "History error:",
        error
      );

      res.status(500).json({
        message:
          "Unable to load import history.",
      });
    }
  }
);

/* --------------------------------
   HEALTH CHECK
-------------------------------- */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      database: "disconnected",
    });
  }
});

/* --------------------------------
   START SERVER
-------------------------------- */

if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(
      `Central verification backend listening on port ${port}`
    );
  });
}

export default app;