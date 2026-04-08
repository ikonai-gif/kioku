import { Link } from "wouter";
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
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Effective: January 1, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      {/* Legal notice */}
      <div className="mb-8 p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-yellow-400">Note:</strong> This is a preliminary Privacy Policy prepared by IKONBAI™, Inc. A legally
        reviewed version will be published before public launch. For questions, contact{" "}
        <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
      </div>

      <div className="prose prose-sm prose-invert max-w-none space-y-8 text-sm text-muted-foreground leading-relaxed">

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">1. Who We Are</h2>
          <p>
            KIOKU™ is a multi-agent AI coordination platform developed and operated by <strong className="text-foreground">IKONBAI™, Inc.</strong>,
            a company incorporated in the United States. References to "KIOKU™", "we", "us", or "our" in this policy refer to IKONBAI™, Inc.
          </p>
          <p className="mt-2">
            Contact: <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">2. What Data We Collect</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li><strong className="text-foreground">Account data:</strong> Email address, name, and plan tier.</li>
            <li><strong className="text-foreground">Usage data:</strong> Agent configurations, memory entries, flow definitions, room messages, and activity logs — all provided by you.</li>
            <li><strong className="text-foreground">Technical data:</strong> IP address, browser type, session identifiers, and request timestamps for security and debugging purposes.</li>
            <li><strong className="text-foreground">Payment data:</strong> Processed by Stripe. IKONBAI™, Inc. does not store payment card details.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">3. How We Use Your Data</h2>
          <ul className="list-disc list-inside space-y-1.5">
            <li>To provide, operate, and improve the KIOKU™ platform.</li>
            <li>To authenticate your sessions and secure your account.</li>
            <li>To process payments and manage subscriptions.</li>
            <li>To send transactional emails (magic links, receipts).</li>
            <li>To comply with legal obligations.</li>
          </ul>
          <p className="mt-3">
            <strong className="text-foreground">We do not sell your data.</strong> We do not use your prompts or memory data to train AI models
            without your explicit written consent.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">4. Data Retention</h2>
          <p>
            Your data is retained for the duration of your account. You may request deletion at any time by contacting{" "}
            <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
            Deletion requests are processed within 30 days (15 days for users subject to Brazil's LGPD).
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">5. Cookies & Tracking</h2>
          <p>
            KIOKU™ uses session cookies strictly for authentication. We do not use third-party advertising trackers.
            Analytics cookies are only set after you provide consent via the cookie banner.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">6. Your Rights</h2>
          <p>Depending on your location, you may have the right to:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Access the personal data we hold about you.</li>
            <li>Request correction or deletion of your data.</li>
            <li>Object to or restrict processing of your data.</li>
            <li>Data portability (receive your data in a machine-readable format).</li>
            <li>Withdraw consent at any time (where processing is based on consent).</li>
          </ul>
          <p className="mt-3">
            To exercise any right, email <a href="mailto:privacy@ikonbai.com" className="text-primary underline">privacy@ikonbai.com</a>.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">7. International Transfers</h2>
          <p>
            KIOKU™ is operated from the United States. If you access KIOKU™ from outside the US (including the EU, UK, or Brazil),
            your data may be transferred to and processed in the United States. We take appropriate safeguards to ensure your
            data is handled in compliance with applicable law.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">8. AI Disclosure</h2>
          <p>
            KIOKU™ War Room™ sessions may involve AI-generated responses from agents powered by large language models (LLMs).
            AI responses are not professional advice. You are always interacting with an AI agent when a non-human participant
            is active in a session.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">9. Children's Privacy</h2>
          <p>
            KIOKU™ is not directed at children under 13. We do not knowingly collect personal data from anyone under 13 years of age.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">10. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify registered users of material changes via email.
            Continued use of KIOKU™ after changes constitutes acceptance of the updated policy.
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>© {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/terms" className="hover:text-foreground underline">Terms of Service</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
