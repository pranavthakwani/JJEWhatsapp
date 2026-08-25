const effectiveDate = '25 August 2026';

function page({ title, summary, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title} | Jay Jalaram Enterprise</title>
  <style>
    :root { color-scheme: light dark; --green:#25d366; --ink:#111b21; --muted:#667781; --canvas:#f7f8fa; --card:#fff; --line:#e9edef; }
    @media (prefers-color-scheme: dark) { :root { --ink:#e9edef; --muted:#8696a0; --canvas:#0b141a; --card:#111b21; --line:#222d34; } }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--canvas); color:var(--ink); font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
    header, main, footer { width:min(760px, calc(100% - 32px)); margin-inline:auto; }
    header { padding:56px 0 28px; }
    .brand { color:var(--green); font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:8px 0 12px; font-size:clamp(32px,7vw,48px); line-height:1.12; letter-spacing:-.03em; }
    h2 { margin:32px 0 8px; font-size:21px; line-height:1.25; }
    p, li { color:var(--muted); }
    .summary { font-size:19px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:clamp(20px,5vw,36px); }
    ul { padding-left:24px; }
    a { color:var(--green); }
    footer { padding:28px 0 48px; color:var(--muted); font-size:14px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">Jay Jalaram Enterprise</div>
    <h1>${title}</h1>
    <p class="summary">${summary}</p>
    <p>Effective date: ${effectiveDate}</p>
  </header>
  <main class="card">${content}</main>
  <footer>Jay Jalaram Enterprise · WhatsApp Business: +91 79 4600 7361</footer>
</body>
</html>`;
}

export function privacyPolicyPage() {
  return page({
    title: 'Privacy Policy',
    summary: 'This policy explains how our WhatsApp customer-relationship system handles business communications and related information.',
    content: `
      <h2>Who we are</h2>
      <p>Jay Jalaram Enterprise operates a customer-relationship and messaging service connected to its WhatsApp Business account. This policy applies to information processed through that service.</p>

      <h2>Information we process</h2>
      <ul>
        <li>WhatsApp identifiers, phone numbers, profile names and business contact details.</li>
        <li>Messages, message attachments and message metadata such as timestamps and delivery status.</li>
        <li>Consent and opt-in records, customer lists, campaign history and conversation history.</li>
        <li>Authorized user, session and device information used to secure access to the CRM.</li>
        <li>When AI extraction is enabled, business-message content and extracted product, quantity and pricing information.</li>
      </ul>

      <h2>How we use information</h2>
      <p>We use this information to receive and respond to enquiries, manage customer relationships, send requested or permitted business communications, maintain message history, operate campaigns, secure the service, diagnose faults and, when enabled, organize business messages into actionable lead information.</p>

      <h2>Service providers</h2>
      <p>Information may be processed by Meta and WhatsApp to deliver messages, by our hosting and Microsoft SQL Server infrastructure to operate the service, and by an AI service only when the optional extraction feature is enabled. We do not sell personal information.</p>

      <h2>Retention and security</h2>
      <p>We retain information for as long as reasonably necessary for customer service, business records, security and applicable legal obligations. We use access controls, encrypted credentials and operational safeguards designed to protect the information we hold.</p>

      <h2>Your choices and deletion</h2>
      <p>You may ask us to correct or delete your information, or opt out of future communications. See our <a href="/data-deletion">Data Deletion Instructions</a>. Some records may be retained where required for legal, fraud-prevention or accounting purposes.</p>

      <h2>Changes to this policy</h2>
      <p>We may update this policy when our service or legal obligations change. The effective date above identifies the current version.</p>

      <h2>Contact</h2>
      <p>For privacy questions or requests, contact Jay Jalaram Enterprise through its official WhatsApp Business number: <a href="https://wa.me/917946007361">+91 79 4600 7361</a>.</p>`,
  });
}

export function dataDeletionPage() {
  return page({
    title: 'Data Deletion Instructions',
    summary: 'You can request deletion of information associated with your WhatsApp number.',
    content: `
      <h2>How to submit a request</h2>
      <ol>
        <li>Message <a href="https://wa.me/917946007361">+91 79 4600 7361</a> from the WhatsApp number whose information you want deleted.</li>
        <li>Write <strong>DELETE MY DATA</strong> and include your name or business name.</li>
        <li>We may ask you to confirm the request from the same WhatsApp account before deletion.</li>
      </ol>

      <h2>What happens next</h2>
      <p>After verification, we will delete or anonymize eligible contact details, conversation content and related CRM records. We will respond with the outcome within 30 days. Information that must be retained for legal, security, fraud-prevention or accounting obligations will be isolated and retained only for the required period.</p>

      <h2>Stop future messages</h2>
      <p>You may also send <strong>STOP</strong> to request that promotional or campaign messages cease without requesting deletion of your complete customer-service history.</p>

      <h2>Contact</h2>
      <p>Questions about a deletion request can be sent to our official WhatsApp Business number: <a href="https://wa.me/917946007361">+91 79 4600 7361</a>.</p>`,
  });
}
