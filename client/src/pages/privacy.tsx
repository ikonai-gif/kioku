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
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Last Updated: April 18, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 rounded-xl border border-border bg-muted/30">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-3">Table of Contents</h2>
        <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
          <li><a href="#pp-who" className="hover:text-primary underline-offset-2 hover:underline">Who We Are</a></li>
          <li><a href="#pp-collect" className="hover:text-primary underline-offset-2 hover:underline">What Data We Collect</a></li>
          <li><a href="#pp-use" className="hover:text-primary underline-offset-2 hover:underline">How We Use Your Data</a></li>
          <li><a href="#pp-legal-basis" className="hover:text-primary underline-offset-2 hover:underline">Legal Basis for Processing (GDPR)</a></li>
          <li><a href="#pp-sub-processors" className="hover:text-primary underline-offset-2 hover:underline">Third-Party Sub-Processors</a></li>
          <li><a href="#pp-retention" className="hover:text-primary underline-offset-2 hover:underline">Data Retention</a></li>
          <li><a href="#pp-cookies" className="hover:text-primary underline-offset-2 hover:underline">Cookies &amp; Tracking</a></li>
          <li><a href="#pp-rights" className="hover:text-primary underline-offset-2 hover:underline">Your Rights</a></li>
          <li><a href="#pp-transfers" className="hover:text-primary underline-offset-2 hover:underline">International Transfers</a></li>
          <li><a href="#pp-ai" className="hover:text-primary underline-offset-2 hover:underline">AI Disclosure (EU AI Act)</a></li>
          <li><a href="#pp-children" className="hover:text-primary underline-offset-2 hover:underline">Children&apos;s Privacy</a></li>
          <li><a href="#pp-canspam" className="hover:text-primary underline-offset-2 hover:underline">CAN-SPAM Compliance</a></li>
          <li><a href="#pp-dnt" className="hover:text-primary underline-offset-2 hover:underline">Do Not Track</a></li>
          <li><a href="#pp-ccpa" className="hover:text-primary underline-offset-2 hover:underline">California Privacy Rights (CCPA)</a></li>
          <li><a href="#pp-changes" className="hover:text-primary underline-offset-2 hover:underline">Changes to This Policy</a></li>
          <li><a href="#pp-contact" className="hover:text-primary underline-offset-2 hover:underline">Contact</a></li>
          <li><a href="#pp-eu-rep" className="hover:text-primary underline-offset-2 hover:underline">EU Representative</a></li>
        </ol>
      </nav>

      <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm text-muted-foreground leading-relaxed">

        {/* 1. Who We Are */}
        <section id="pp-who">
          <h2 className="text-base font-semibold text-foreground mb-3">1. Who We Are</h2>
          <p>
            KIOKU™ is a multi-agent AI coordination platform developed and operated by <strong className="text-foreground">IKONBAI™, Inc.</strong>,
            a company incorporated in the State of Delaware, United States. References to &ldquo;KIOKU™&rdquo;, &ldquo;we&rdquo;,
            &ldquo;us&rdquo;, or &ldquo;our&rdquo; in this policy refer to IKONBAI™, Inc.
          </p>
          <p className="mt-2">
            Contact: <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>
          </p>
        </section>

        {/* 2. What Data We Collect */}
        <section id="pp-collect">
          <h2 className="text-base font-semibold text-foreground mb-3">2. What Data We Collect</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li><strong className="text-foreground">Account data:</strong> Email address, name, and subscription plan tier.</li>
            <li><strong className="text-foreground">Usage data:</strong> Agent configurations, memory entries, flow definitions, room messages, deliberation results, and activity logs — all provided by you.</li>
            <li><strong className="text-foreground">Technical data:</strong> IP address, browser type, session identifiers, and request timestamps for security and debugging purposes.</li>
            <li><strong className="text-foreground">Payment data:</strong> Processed exclusively by Stripe. IKONBAI™, Inc. does not store payment card details on its servers.</li>
          </ul>
        </section>

        {/* 3. How We Use Your Data */}
        <section id="pp-use">
          <h2 className="text-base font-semibold text-foreground mb-3">3. How We Use Your Data</h2>
          <p>We use your data exclusively for the following purposes:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Service delivery:</strong> To provide, operate, and improve the KIOKU™ platform.</li>
            <li><strong className="text-foreground">Authentication:</strong> To authenticate your sessions and secure your account.</li>
            <li><strong className="text-foreground">Billing:</strong> To process payments and manage subscriptions via Stripe.</li>
            <li><strong className="text-foreground">Transactional emails:</strong> To send magic links, receipts, and service notifications via Brevo.</li>
            <li><strong className="text-foreground">Legal compliance:</strong> To comply with applicable laws, regulations, and legal obligations.</li>
          </ul>
          <p className="mt-3 p-3 rounded-lg border border-primary/20 bg-primary/5 text-foreground font-medium">
            We do not sell your data. We do not use your prompts or memory data to train AI models.
          </p>
        </section>

        {/* 4. Legal Basis for Processing (GDPR Art. 6) */}
        <section id="pp-legal-basis">
          <h2 className="text-base font-semibold text-foreground mb-3">4. Legal Basis for Processing (GDPR Art. 6)</h2>
          <p>We process your personal data under the following legal bases as defined by the General Data Protection Regulation (GDPR):</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Contract performance (Art. 6(1)(b)):</strong> Processing necessary to provide the KIOKU™ service you signed up for, including account management, AI agent orchestration, and data storage.</li>
            <li><strong className="text-foreground">Legitimate interest (Art. 6(1)(f)):</strong> Processing for security monitoring, fraud prevention, service improvement, and debugging. We balance our interests against your rights and freedoms.</li>
            <li><strong className="text-foreground">Consent (Art. 6(1)(a)):</strong> Where we rely on your consent (e.g., optional communications), you may withdraw consent at any time without affecting the lawfulness of prior processing.</li>
            <li><strong className="text-foreground">Legal obligation (Art. 6(1)(c)):</strong> Processing required to comply with tax, accounting, or other legal requirements.</li>
          </ul>
        </section>

        {/* 5. Third-Party Sub-Processors */}
        <section id="pp-sub-processors">
          <h2 className="text-base font-semibold text-foreground mb-3">5. Third-Party Sub-Processors</h2>
          <p>KIOKU™ relies on the following sub-processors to deliver its services. Each processes data under applicable data processing agreements (DPAs):</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Provider</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Purpose</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Data Shared</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">Location</th>
                  <th className="text-left p-2.5 font-semibold text-foreground border-b border-border">DPA Status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">OpenAI</td>
                  <td className="p-2.5">LLM processing</td>
                  <td className="p-2.5">Prompts &amp; context</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">Auto-included in API terms</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Anthropic</td>
                  <td className="p-2.5">LLM processing</td>
                  <td className="p-2.5">Prompts &amp; context</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">Auto-included in API terms</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Google (Gemini)</td>
                  <td className="p-2.5">LLM processing, video analysis</td>
                  <td className="p-2.5">Prompts, media</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">CDPA available</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Stripe</td>
                  <td className="p-2.5">Payment processing</td>
                  <td className="p-2.5">Email, plan, payment details</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Brevo</td>
                  <td className="p-2.5">Transactional email</td>
                  <td className="p-2.5">Email address</td>
                  <td className="p-2.5">EU (France)</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">E2B</td>
                  <td className="p-2.5">Code sandbox execution</td>
                  <td className="p-2.5">Code snippets</td>
                  <td className="p-2.5">EU (Czech Republic)</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Composio</td>
                  <td className="p-2.5">Third-party app integrations</td>
                  <td className="p-2.5">Action parameters</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">Per ToS</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Neon</td>
                  <td className="p-2.5">PostgreSQL database hosting</td>
                  <td className="p-2.5">All stored data</td>
                  <td className="p-2.5">USA (AWS us-east-1)</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">Railway</td>
                  <td className="p-2.5">Application hosting</td>
                  <td className="p-2.5">All transmitted data</td>
                  <td className="p-2.5">USA</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
                <tr>
                  <td className="p-2.5 text-foreground font-medium">Cloudflare</td>
                  <td className="p-2.5">CDN, DNS, DDoS protection</td>
                  <td className="p-2.5">IP addresses, request data</td>
                  <td className="p-2.5">Global</td>
                  <td className="p-2.5">DPA included</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            Each sub-processor processes data under their own privacy policies and applicable data processing agreements.
            We select providers that maintain appropriate security standards and contractual protections.
          </p>
        </section>

        {/* 6. Data Retention */}
        <section id="pp-retention">
          <h2 className="text-base font-semibold text-foreground mb-3">6. Data Retention</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li><strong className="text-foreground">Active accounts:</strong> Your data is retained indefinitely while your account is active.</li>
            <li><strong className="text-foreground">Deleted accounts:</strong> You have 90 days after account deletion to export your data. After 90 days, all data is permanently and irreversibly deleted from our systems and sub-processor systems.</li>
            <li><strong className="text-foreground">Deletion requests:</strong> Processed within 30 days (15 days for users subject to Brazil&apos;s LGPD). Contact{" "}
              <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
            </li>
          </ul>
        </section>

        {/* 7. Cookies & Tracking */}
        <section id="pp-cookies">
          <h2 className="text-base font-semibold text-foreground mb-3">7. Cookies &amp; Tracking</h2>
          <p>
            KIOKU™ uses only <strong className="text-foreground">essential cookies</strong> required for the service to function.
            We do not use any third-party advertising, analytics, or tracking cookies. We do not use localStorage or sessionStorage.
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
                <tr className="border-b border-border/50">
                  <td className="p-2.5 text-foreground font-medium">kioku_session</td>
                  <td className="p-2.5">Essential (httpOnly, Secure, SameSite=Lax)</td>
                  <td className="p-2.5">Authentication — keeps you logged in</td>
                </tr>
                <tr>
                  <td className="p-2.5 text-foreground font-medium">kioku_consent</td>
                  <td className="p-2.5">Essential (Secure, SameSite=Lax)</td>
                  <td className="p-2.5">Remembers your cookie consent choice</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            For full details on our cookie usage, please see our{" "}
            <a href="#/cookies" className="text-primary underline">Cookie Policy</a>.
          </p>
        </section>

        {/* 8. Your Rights */}
        <section id="pp-rights">
          <h2 className="text-base font-semibold text-foreground mb-3">8. Your Rights</h2>

          <h3 className="text-sm font-semibold text-foreground mt-4 mb-2">GDPR (European Union)</h3>
          <p>If you are located in the EU/EEA, you have the following rights under the General Data Protection Regulation:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Right of Access:</strong> Request a copy of the personal data we hold about you.</li>
            <li><strong className="text-foreground">Right to Rectification:</strong> Request correction of inaccurate personal data.</li>
            <li><strong className="text-foreground">Right to Erasure:</strong> Request deletion of your personal data (&ldquo;right to be forgotten&rdquo;).</li>
            <li><strong className="text-foreground">Right to Data Portability:</strong> Receive your data in a machine-readable format (KMEF, JSON, or CSV).</li>
            <li><strong className="text-foreground">Right to Restrict Processing:</strong> Request limitation of how we process your data.</li>
            <li><strong className="text-foreground">Right to Object:</strong> Object to processing based on legitimate interest.</li>
            <li><strong className="text-foreground">Right to Withdraw Consent:</strong> Withdraw consent at any time without affecting the lawfulness of prior processing.</li>
            <li><strong className="text-foreground">Right to Lodge a Complaint:</strong> File a complaint with your local Data Protection Authority (DPA).</li>
          </ul>

          <h3 className="text-sm font-semibold text-foreground mt-4 mb-2">CCPA (California, USA)</h3>
          <p>If you are a California resident, you have the following rights under the California Consumer Privacy Act:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Right to Know:</strong> Request disclosure of what personal information we collect, use, and share.</li>
            <li><strong className="text-foreground">Right to Delete:</strong> Request deletion of your personal information.</li>
            <li><strong className="text-foreground">Right to Opt-Out of Sale:</strong> We do not sell your personal information. No opt-out is required.</li>
            <li><strong className="text-foreground">Right to Non-Discrimination:</strong> We will not discriminate against you for exercising your CCPA rights.</li>
          </ul>

          <h3 className="text-sm font-semibold text-foreground mt-4 mb-2">CalOPPA (California Online Privacy Protection Act)</h3>
          <p>In accordance with CalOPPA:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>This Privacy Policy is accessible via a conspicuous link on our homepage.</li>
            <li>We honor Do Not Track (DNT) signals from your browser.</li>
            <li>We notify users of material changes to this policy via email.</li>
          </ul>

          <h3 className="text-sm font-semibold text-foreground mt-4 mb-2">LGPD (Brazil)</h3>
          <p>If you are located in Brazil, you have all rights granted under the Lei Geral de Prote&ccedil;&atilde;o de Dados, equivalent to GDPR rights listed above. Deletion requests under LGPD are processed within 15 days.</p>

          <p className="mt-4">
            To exercise any right, email <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
            We will respond within 30 days (15 days for LGPD requests).
          </p>
        </section>

        {/* 9. International Transfers */}
        <section id="pp-transfers">
          <h2 className="text-base font-semibold text-foreground mb-3">9. International Transfers</h2>
          <p>
            KIOKU™ is operated from the United States. If you access KIOKU™ from outside the US (including the EU, UK, or Brazil),
            your data may be transferred to and processed in the United States.
          </p>
          <p className="mt-2">
            For transfers of personal data from the EU/EEA to the United States, we rely on <strong className="text-foreground">Standard Contractual Clauses (SCCs)</strong> approved
            by the European Commission, as well as data processing agreements with our sub-processors that incorporate equivalent safeguards.
          </p>
        </section>

        {/* 10. AI Disclosure (EU AI Act Art. 50) */}
        <section id="pp-ai">
          <h2 className="text-base font-semibold text-foreground mb-3">10. AI Disclosure (EU AI Act Art. 50)</h2>
          <p>
            KIOKU™ is a <strong className="text-foreground">General-Purpose AI (GPAI) system</strong> as defined under the EU AI Act.
            In accordance with Article 50, we disclose the following:
          </p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>KIOKU™ War Room™ sessions and agent interactions produce <strong className="text-foreground">AI-generated content</strong>. All non-human participants in sessions are AI agents powered by large language models (LLMs).</li>
            <li>AI-generated content is clearly identified within the platform. When interacting with an AI agent, you are always informed that you are communicating with an artificial intelligence system.</li>
            <li>AI responses are <strong className="text-foreground">not professional advice</strong>. They do not constitute legal, financial, medical, or any other form of professional guidance. You are solely responsible for verifying and acting on AI-generated content.</li>
          </ul>
          <p className="mt-3">
            Prompts and context sent to AI providers (OpenAI, Anthropic, Google Gemini) are processed under their respective
            data processing agreements and are not used for model training with our API configurations.
          </p>
        </section>

        {/* 11. Children's Privacy */}
        <section id="pp-children">
          <h2 className="text-base font-semibold text-foreground mb-3">11. Children&apos;s Privacy</h2>
          <p>
            KIOKU™ is not directed at children. We do not knowingly collect personal data from anyone under <strong className="text-foreground">16 years of age</strong> (the
            GDPR threshold) or under <strong className="text-foreground">13 years of age</strong> (the COPPA threshold).
          </p>
          <p className="mt-2">
            If we become aware that a child under these applicable age thresholds has provided personal data,
            we will delete it promptly. If you believe a child has provided us with personal data, please
            contact <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
          </p>
        </section>

        {/* 12. CAN-SPAM Compliance */}
        <section id="pp-canspam">
          <h2 className="text-base font-semibold text-foreground mb-3">12. CAN-SPAM Compliance</h2>
          <p>We comply with the CAN-SPAM Act. All transactional emails include:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Clear identification of IKONBAI™, Inc. as the sender.</li>
            <li>A valid physical mailing address (P.O. Box).</li>
            <li>Opt-out instructions where applicable.</li>
          </ul>
          <p className="mt-3">
            Physical address: IKONBAI™, Inc., P.O. Box, United States
          </p>
        </section>

        {/* 13. Do Not Track */}
        <section id="pp-dnt">
          <h2 className="text-base font-semibold text-foreground mb-3">13. Do Not Track</h2>
          <p>
            KIOKU™ <strong className="text-foreground">honors Do Not Track (DNT) signals</strong> sent by your browser.
            Since we do not use any tracking, analytics, or advertising cookies, there is no tracking behavior to disable.
            Your experience on KIOKU™ is the same regardless of your DNT setting.
          </p>
        </section>

        {/* 14. California Privacy Rights (CCPA) */}
        <section id="pp-ccpa">
          <h2 className="text-base font-semibold text-foreground mb-3">14. California Privacy Rights</h2>
          <p>
            Under the California Consumer Privacy Act (CCPA), California residents have specific rights regarding their personal information:
          </p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li><strong className="text-foreground">Categories of personal information collected:</strong> Identifiers (email, name), internet activity (usage data, IP address), and commercial information (subscription plan).</li>
            <li><strong className="text-foreground">Sale of personal information:</strong> We do <strong className="text-foreground">not</strong> sell personal information as defined by the CCPA.</li>
            <li><strong className="text-foreground">Sharing for cross-context behavioral advertising:</strong> We do <strong className="text-foreground">not</strong> share personal information for behavioral advertising.</li>
            <li><strong className="text-foreground">Sensitive personal information:</strong> We do not collect sensitive personal information as defined by the CCPA.</li>
          </ul>
          <p className="mt-3">
            To submit a verifiable consumer request, email <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
            We will verify your identity and respond within 45 days.
          </p>
        </section>

        {/* 15. Changes to This Policy */}
        <section id="pp-changes">
          <h2 className="text-base font-semibold text-foreground mb-3">15. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify registered users of material changes via email
            at least 30 days before such changes take effect. Continued use of KIOKU™ after changes constitutes acceptance of the updated policy.
          </p>
        </section>

        {/* 16. Contact */}
        <section id="pp-contact">
          <h2 className="text-base font-semibold text-foreground mb-3">16. Contact</h2>
          <p>
            For privacy inquiries: <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a><br />
            For legal inquiries: <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a><br />
            IKONBAI™, Inc. · Delaware, United States
          </p>
        </section>

        {/* 17. EU Representative */}
        <section id="pp-eu-rep">
          <h2 className="text-base font-semibold text-foreground mb-3">17. EU Representative</h2>
          <p>
            To be appointed. In the meantime, EU residents may direct inquiries
            to <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>&copy; {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/terms" className="hover:text-foreground underline">Terms of Service</a>
          <a href="#/cookies" className="hover:text-foreground underline">Cookie Policy</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
