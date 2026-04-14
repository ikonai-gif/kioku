import { ArrowLeft, Shield } from "lucide-react";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10 max-w-3xl mx-auto">
      <div className="mb-8">
        <a href="#/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
          <ArrowLeft className="w-4 h-4" /> Back
        </a>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground">Privacy Policy</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Last Updated: April 14, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      {/* Legal notice */}
      <div className="mb-8 p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-yellow-400">Note:</strong> This is a preliminary Privacy Policy prepared by IKONBAI™, Inc. A legally
        reviewed version will be published before public launch. For questions, contact{" "}
        <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
      </div>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 rounded-xl border border-border bg-muted/30">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-3">Table of Contents</h2>
        <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
          <li><a href="#pp-who" className="hover:text-primary underline-offset-2 hover:underline">Who We Are</a></li>
          <li><a href="#pp-collect" className="hover:text-primary underline-offset-2 hover:underline">What Data We Collect</a></li>
          <li><a href="#pp-use" className="hover:text-primary underline-offset-2 hover:underline">How We Use Your Data</a></li>
          <li><a href="#pp-third-parties" className="hover:text-primary underline-offset-2 hover:underline">Third-Party Services</a></li>
          <li><a href="#pp-retention" className="hover:text-primary underline-offset-2 hover:underline">Data Retention</a></li>
          <li><a href="#pp-cookies" className="hover:text-primary underline-offset-2 hover:underline">Cookies &amp; Tracking</a></li>
          <li><a href="#pp-gdpr" className="hover:text-primary underline-offset-2 hover:underline">Your Rights (GDPR &amp; Global)</a></li>
          <li><a href="#pp-transfers" className="hover:text-primary underline-offset-2 hover:underline">International Transfers</a></li>
          <li><a href="#pp-ai" className="hover:text-primary underline-offset-2 hover:underline">AI Disclosure</a></li>
          <li><a href="#pp-children" className="hover:text-primary underline-offset-2 hover:underline">Children's Privacy</a></li>
          <li><a href="#pp-canspam" className="hover:text-primary underline-offset-2 hover:underline">CAN-SPAM Compliance</a></li>
          <li><a href="#pp-changes" className="hover:text-primary underline-offset-2 hover:underline">Changes to This Policy</a></li>
          <li><a href="#pp-contact" className="hover:text-primary underline-offset-2 hover:underline">Contact</a></li>
        </ol>
      </nav>

      <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm text-muted-foreground leading-relaxed">

        <section id="pp-who">
          <h2 className="text-base font-semibold text-foreground mb-3">1. Who We Are</h2>
          <p>
            KIOKU™ is a multi-agent AI coordination platform developed and operated by <strong className="text-foreground">IKONBAI Inc.</strong>,
            a company incorporated in the United States. References to "KIOKU™", "we", "us", or "our" in this policy refer to IKONBAI Inc.
          </p>
          <p className="mt-2">
            Contact: <a href="mailto:kotkave@gmail.com" className="text-primary underline">kotkave@gmail.com</a>
          </p>
        </section>

        <section id="pp-collect">
          <h2 className="text-base font-semibold text-foreground mb-3">2. What Data We Collect</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li><strong className="text-foreground">Account data:</strong> Email address, name, and plan tier.</li>
            <li><strong className="text-foreground">Usage data:</strong> Agent configurations, memory entries, flow definitions, room messages, deliberation results, and activity logs — all provided by you.</li>
            <li><strong className="text-foreground">Technical data:</strong> IP address, browser type, session identifiers, and request timestamps for security and debugging purposes.</li>
            <li><strong className="text-foreground">Payment data:</strong> Processed by Stripe. IKONBAI Inc. does not store payment card details.</li>
          </ul>
        </section>

        <section id="pp-use">
          <h2 className="text-base font-semibold text-foreground mb-3">3. How We Use Your Data</h2>
          <p>We use your data exclusively for service delivery:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>To provide, operate, and improve the KIOKU™ platform.</li>
            <li>To authenticate your sessions and secure your account.</li>
            <li>To process payments and manage subscriptions.</li>
            <li>To send transactional emails (magic links, receipts).</li>
            <li>To comply with legal obligations.</li>
          </ul>
          <p className="mt-3 p-3 rounded-lg border border-primary/20 bg-primary/5 text-foreground font-medium">
            We do not sell your data. We do not use your prompts or memory data to train AI models.
          </p>
        </section>

        <section id="pp-third-parties">
          <h2 className="text-base font-semibold text-foreground mb-3">4. Third-Party Services</h2>
          <p>KIOKU™ integrates with the following third-party services to deliver functionality:</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Service</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Purpose</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Data Shared</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Stripe</td>
                  <td className="p-2.5">Payment processing &amp; billing</td>
                  <td className="p-2.5">Email, plan tier, payment details</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Brevo</td>
                  <td className="p-2.5">Transactional email delivery</td>
                  <td className="p-2.5">Email address</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">OpenAI</td>
                  <td className="p-2.5">AI model processing (deliberations)</td>
                  <td className="p-2.5">Prompts &amp; context sent to models</td>
                </tr>
                <tr>
                  <td className="p-2.5 text-foreground font-medium">Google Gemini</td>
                  <td className="p-2.5">AI model processing (deliberations)</td>
                  <td className="p-2.5">Prompts &amp; context sent to models</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            Each third-party provider processes data under their own privacy policies. We select providers that maintain
            appropriate security standards and data processing agreements.
          </p>
        </section>

        <section id="pp-retention">
          <h2 className="text-base font-semibold text-foreground mb-3">5. Data Retention</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li><strong className="text-foreground">Active accounts:</strong> Your data is retained indefinitely while your account is active.</li>
            <li><strong className="text-foreground">Deleted accounts:</strong> You have 90 days after account deletion to export your data. After 90 days, all data is permanently and irreversibly deleted.</li>
            <li><strong className="text-foreground">Deletion requests:</strong> Processed within 30 days (15 days for users subject to Brazil's LGPD). Contact{" "}
              <a href="mailto:kotkave@gmail.com" className="text-primary underline">kotkave@gmail.com</a>.
            </li>
          </ul>
        </section>

        <section id="pp-cookies">
          <h2 className="text-base font-semibold text-foreground mb-3">6. Cookies &amp; Tracking</h2>
          <p>
            KIOKU™ uses <strong className="text-foreground">httpOnly session cookies</strong> strictly for authentication.
            We do not use third-party advertising trackers. We do not use localStorage or sessionStorage for
            tracking purposes.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Cookie</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Type</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Purpose</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-2.5 text-foreground font-medium">Session cookie</td>
                  <td className="p-2.5">Essential (httpOnly)</td>
                  <td className="p-2.5">Authentication — keeps you logged in</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            No tracking cookies are used. The cookie consent banner is shown for transparency, not because we deploy
            non-essential cookies.
          </p>
        </section>

        <section id="pp-gdpr">
          <h2 className="text-base font-semibold text-foreground mb-3">7. Your Rights (GDPR &amp; Global)</h2>
          <p>Depending on your location, you have the following rights under GDPR and other applicable data protection laws:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Right of Access:</strong> Request a copy of the personal data we hold about you.</li>
            <li><strong className="text-foreground">Right to Rectification:</strong> Request correction of inaccurate personal data.</li>
            <li><strong className="text-foreground">Right to Erasure:</strong> Request deletion of your personal data ("right to be forgotten").</li>
            <li><strong className="text-foreground">Right to Data Portability:</strong> Receive your data in a machine-readable format (KMEF, JSON, or CSV).</li>
            <li><strong className="text-foreground">Right to Object:</strong> Object to processing of your data for specific purposes.</li>
            <li><strong className="text-foreground">Right to Restrict Processing:</strong> Request limitation of how we process your data.</li>
            <li><strong className="text-foreground">Right to Withdraw Consent:</strong> Withdraw consent at any time where processing is based on consent.</li>
          </ul>
          <p className="mt-3">
            To exercise any right, email <a href="mailto:kotkave@gmail.com" className="text-primary underline">kotkave@gmail.com</a>.
            We will respond within 30 days.
          </p>
        </section>

        <section id="pp-transfers">
          <h2 className="text-base font-semibold text-foreground mb-3">8. International Transfers</h2>
          <p>
            KIOKU™ is operated from the United States. If you access KIOKU™ from outside the US (including the EU, UK, or Brazil),
            your data may be transferred to and processed in the United States. We take appropriate safeguards to ensure your
            data is handled in compliance with applicable law, including standard contractual clauses where required.
          </p>
        </section>

        <section id="pp-ai">
          <h2 className="text-base font-semibold text-foreground mb-3">9. AI Disclosure</h2>
          <p>
            KIOKU™ War Room™ sessions may involve AI-generated responses from agents powered by large language models (LLMs).
            AI responses are not professional advice. You are always interacting with an AI agent when a non-human participant
            is active in a session.
          </p>
          <p className="mt-3">
            Prompts and context sent to AI providers (OpenAI, Google Gemini) are processed under their data processing
            agreements and are not used for model training with our API configurations.
          </p>
        </section>

        <section id="pp-children">
          <h2 className="text-base font-semibold text-foreground mb-3">10. Children's Privacy</h2>
          <p>
            KIOKU™ is not directed at children under 13. We do not knowingly collect personal data from anyone under 13 years of age.
            If we become aware that a child under 13 has provided personal data, we will delete it promptly.
          </p>
        </section>

        <section id="pp-canspam">
          <h2 className="text-base font-semibold text-foreground mb-3">11. CAN-SPAM Compliance</h2>
          <p>We comply with the CAN-SPAM Act. All transactional emails include:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Clear identification of IKONBAI Inc. as the sender.</li>
            <li>A valid physical mailing address.</li>
            <li>Opt-out instructions where applicable.</li>
          </ul>
          <p className="mt-3">
            Physical address: IKONBAI Inc., P.O. Box, United States
          </p>
        </section>

        <section id="pp-changes">
          <h2 className="text-base font-semibold text-foreground mb-3">12. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify registered users of material changes via email.
            Continued use of KIOKU™ after changes constitutes acceptance of the updated policy.
          </p>
        </section>

        <section id="pp-contact">
          <h2 className="text-base font-semibold text-foreground mb-3">13. Contact</h2>
          <p>
            For privacy inquiries: <a href="mailto:kotkave@gmail.com" className="text-primary underline">kotkave@gmail.com</a><br />
            For legal inquiries: <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a><br />
            IKONBAI Inc. · United States
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>&copy; {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/terms" className="hover:text-foreground underline">Terms of Service</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
