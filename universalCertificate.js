import QRCode from "qrcode";

/**
 * Formats a date string or timestamp into "24 September 2026"
 */
export function formatCertificateDate(dateInput) {
  if (!dateInput) {
    return new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  try {
    const d = new Date(dateInput);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    }
  } catch (e) {}
  return String(dateInput);
}

/**
 * Returns dynamic action text based on the program data
 * Defaults to the universal phrase: "participating in / completing / receiving recognition for"
 */
export function getActionPhrase(program) {
  const type = String(program?.type || "").trim().toUpperCase();
  if (type === "PARTICIPATION") return "participating in";
  if (type === "COMPLETION") return "completing";
  if (type === "MERIT" || type === "ACHIEVEMENT" || type === "WINNER") return "receiving recognition for";
  if (type.includes("PARTICIPAT")) return "participating in";
  if (type.includes("COMPLET")) return "completing";
  if (type.includes("MERIT") || type.includes("WIN") || type.includes("RECOGNITION")) return "receiving recognition for";
  return "participating in / completing / receiving recognition for";
}

/**
 * Generates QR code as a base64 Data URL
 */
export async function generateQrDataUrl(text) {
  if (!text) return "";
  try {
    return await QRCode.toDataURL(text, {
      width: 140,
      margin: 1,
      color: {
        dark: "#0F172A",
        light: "#FFFFFF",
      },
      errorCorrectionLevel: "M",
    });
  } catch (err) {
    console.error("Failed to generate QR code data URL:", err);
    return `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(text)}`;
  }
}

/**
 * Generates the complete, standalone Universal Certificate HTML document
 */
export function generateUniversalCertificateHtml({ cert, program, event, origin = "", qrDataUrl = "" }) {
  const recipient = cert?.recipientName || "Recipient Name";
  const certNumber = cert?.certificateNumber || "CERT-NUMBER";
  const token = cert?.verificationToken || cert?.token || "VERIFICATION-TOKEN";
  const progName = program?.name || "Program";
  const evName = event?.name || "Event";
  const orgName = event?.organizer || "College of Engineering Poonjar";
  const dateFormatted = formatCertificateDate(cert?.issuedDate);
  const actionPhrase = getActionPhrase(program);

  const baseUrl = origin || "https://central-verification.vercel.app";
  const verifyUrl = `${baseUrl}/verify/${encodeURIComponent(token)}`;
  const qrSrc = qrDataUrl || `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(verifyUrl)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Certificate - ${recipient} (${certNumber})</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800;900&family=Playfair+Display:ital,wght@0,600;0,700;1,600&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #0B0F19;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: #0F172A;
      -webkit-font-smoothing: antialiased;
    }

    /* Screen Action Bar */
    .print-actions {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      z-index: 100;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(12px);
      padding: 8px 12px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }

    .btn-action {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #2563EB;
      color: #FFFFFF;
      border: 0;
      padding: 9px 18px;
      border-radius: 9999px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.18s ease;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
    }

    .btn-action:hover {
      background: #1D4ED8;
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.5);
    }

    .btn-action.btn-secondary {
      background: rgba(255, 255, 255, 0.12);
      color: #E2E8F0;
      box-shadow: none;
    }

    .btn-action.btn-secondary:hover {
      background: rgba(255, 255, 255, 0.22);
      color: #FFFFFF;
    }

    /* Certificate Outer Frame */
    .cert-frame {
      width: 1020px;
      max-width: 100%;
      background: #FFFFFF;
      border-radius: 12px;
      padding: 48px 56px;
      position: relative;
      box-shadow: 0 30px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08);
      text-align: center;
      overflow: hidden;
      outline: 14px solid #0F172A;
      outline-offset: -14px;
      border: 2px solid #D4AF37;
    }

    /* Inner Decorative Golden Inset Border */
    .cert-frame::before {
      content: "";
      position: absolute;
      top: 24px;
      left: 24px;
      right: 24px;
      bottom: 24px;
      border: 1.5px solid rgba(212, 175, 55, 0.45);
      border-radius: 6px;
      pointer-events: none;
    }

    /* Subtle Security Watermark */
    .cert-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-25deg);
      font-family: 'Cinzel', serif;
      font-size: 88px;
      font-weight: 900;
      color: rgba(15, 23, 42, 0.024);
      letter-spacing: 0.18em;
      pointer-events: none;
      white-space: nowrap;
      user-select: none;
    }

    /* Top Ribbon / Crest Badge */
    .cert-crest {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #92400E;
      background: linear-gradient(135deg, #FEF3C7 0%, #FDE68A 100%);
      padding: 6px 18px;
      border-radius: 9999px;
      margin-bottom: 20px;
      border: 1px solid #F59E0B;
      box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
    }

    /* Primary Heading */
    h1.cert-title {
      font-family: 'Cinzel', serif;
      font-size: 44px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: 0.14em;
      line-height: 1.1;
      margin-bottom: 6px;
    }

    .cert-subtitle {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.24em;
      color: #64748B;
      font-weight: 700;
      margin-bottom: 24px;
    }

    /* Body Text & Flow */
    .cert-issue-statement {
      font-size: 15px;
      font-style: italic;
      color: #475569;
      margin-bottom: 10px;
      font-family: 'Playfair Display', serif;
    }

    .cert-recipient {
      font-family: 'Cinzel', serif;
      font-size: 38px;
      font-weight: 800;
      color: #1E3A8A;
      letter-spacing: 0.04em;
      margin: 4px 0 16px;
      padding: 0 20px 8px;
      display: inline-block;
      border-bottom: 2px solid #CBD5E1;
      text-transform: uppercase;
    }

    .cert-purpose {
      font-size: 14px;
      font-style: italic;
      color: #475569;
      margin-bottom: 8px;
      font-family: 'Playfair Display', serif;
    }

    .cert-program {
      font-size: 22px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: 0.02em;
      margin-bottom: 12px;
    }

    .cert-conducted-label {
      font-size: 13px;
      font-style: italic;
      color: #64748B;
      margin-bottom: 4px;
      font-family: 'Playfair Display', serif;
    }

    .cert-event {
      font-size: 18px;
      font-weight: 700;
      color: #1E293B;
      margin-bottom: 12px;
    }

    .cert-organized-label {
      font-size: 13px;
      font-style: italic;
      color: #64748B;
      margin-bottom: 4px;
      font-family: 'Playfair Display', serif;
    }

    .cert-organizer {
      font-size: 19px;
      font-weight: 800;
      color: #0F172A;
      margin-bottom: 32px;
      letter-spacing: 0.03em;
    }

    /* Bottom Metadata & Verification Box */
    .cert-footer-grid {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 24px;
      padding-top: 24px;
      border-top: 1.5px solid #E2E8F0;
      background: #F8FAFC;
      border-radius: 8px;
      padding: 20px 28px;
      text-align: left;
    }

    .meta-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .meta-item {
      font-size: 13px;
      color: #334155;
    }

    .meta-item strong {
      color: #0F172A;
      font-weight: 700;
    }

    .meta-token {
      font-family: 'JetBrains Mono', Consolas, monospace;
      font-size: 12px;
      background: #FFFFFF;
      border: 1px solid #CBD5E1;
      padding: 2px 6px;
      border-radius: 4px;
      color: #0F172A;
      word-break: break-all;
    }

    .meta-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #15803D;
      background: #DCFCE7;
      padding: 4px 10px;
      border-radius: 9999px;
      border: 1px solid #86EFAC;
    }

    .cert-divider-vertical {
      width: 1px;
      height: 100px;
      background: #E2E8F0;
    }

    /* QR Code Verification Section */
    .cert-qr-section {
      display: flex;
      align-items: center;
      gap: 16px;
      text-align: left;
    }

    .qr-container {
      width: 100px;
      height: 100px;
      flex-shrink: 0;
      background: #FFFFFF;
      padding: 6px;
      border: 1.5px solid #CBD5E1;
      border-radius: 8px;
      display: grid;
      place-items: center;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }

    .qr-container img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .qr-info h4 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #0F172A;
      font-weight: 800;
      margin-bottom: 4px;
    }

    .qr-info p {
      font-size: 11px;
      color: #64748B;
      line-height: 1.4;
      margin-bottom: 6px;
    }

    .cert-verify-link {
      font-family: 'JetBrains Mono', Consolas, monospace;
      font-size: 10px;
      color: #2563EB;
      text-decoration: none;
      word-break: break-all;
      display: block;
      max-width: 210px;
    }

    .cert-verify-link:hover {
      text-decoration: underline;
    }

    /* Print and PDF Optimization Styles */
    @media print {
      .print-actions {
        display: none !important;
      }

      body {
        background: #FFFFFF !important;
        padding: 0 !important;
        margin: 0 !important;
        min-height: auto !important;
        display: block !important;
      }

      .cert-frame {
        width: 100% !important;
        max-width: 100% !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        outline: 10px solid #0F172A !important;
        outline-offset: -10px !important;
        border: 2px solid #D4AF37 !important;
        page-break-inside: avoid;
        margin: 0 auto;
        padding: 40px 48px;
      }

      @page {
        size: landscape;
        margin: 10mm;
      }

      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
  </style>
</head>
<body>
  <!-- Print and Actions Bar for Web View -->
  <div class="print-actions">
    <button class="btn-action" onclick="window.print()">
      🖨️ Print / Save as PDF
    </button>
    <a class="btn-action btn-secondary" href="${verifyUrl}" target="_blank">
      🔍 Verify Online
    </a>
  </div>

  <!-- Universal Certificate Frame -->
  <div class="cert-frame">
    <div class="cert-watermark">CENTRAL VERIFICATION</div>

    <div class="cert-crest">
      ★ Official Digital Credential · Tamper-Proof ★
    </div>

    <h1 class="cert-title">CERTIFICATE</h1>
    <div class="cert-subtitle">Central Verification Registry</div>

    <p class="cert-issue-statement">This certificate is issued to</p>
    <div class="cert-recipient">${recipient}</div>

    <p class="cert-purpose">for ${actionPhrase}</p>
    <div class="cert-program">${progName}</div>

    <p class="cert-conducted-label">conducted as part of</p>
    <div class="cert-event">${evName}</div>

    <p class="cert-organized-label">organized by</p>
    <div class="cert-organizer">${orgName}</div>

    <!-- Footer: Details and Verification QR -->
    <div class="cert-footer-grid">
      <div class="meta-list">
        <div class="meta-item">
          <strong>Issued:</strong> ${dateFormatted}
        </div>
        <div class="meta-item">
          <strong>Certificate No:</strong> <span class="meta-token">${certNumber}</span>
        </div>
        <div class="meta-item">
          <strong>Verification Token:</strong> <span class="meta-token">${token}</span>
        </div>
        <div class="meta-badge">
          ✓ Tamper-Proof Verified
        </div>
      </div>

      <div class="cert-divider-vertical"></div>

      <div class="cert-qr-section">
        <div class="qr-container">
          <img src="${qrSrc}" alt="Verification QR Code" />
        </div>
        <div class="qr-info">
          <h4>Verify Certificate</h4>
          <p>Scan QR code or click link to verify authenticity:</p>
          <a class="cert-verify-link" href="${verifyUrl}" target="_blank">${verifyUrl}</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
