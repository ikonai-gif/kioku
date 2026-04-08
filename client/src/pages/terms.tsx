import { ArrowLeft, FileText } from "lucide-react";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10 max-w-3xl mx-auto">
      <div className="mb-8">
        <a href="#/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
          <ArrowLeft className="w-4 h-4" /> Back
        </a>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <FileText className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground">Terms of Service</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Effective: January 1, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      <div className="mb-8 p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-yellow-400">Note:</strong> This is a preliminary Terms of Service prepared by IKONBAI™, Inc. A legally
        reviewed version will be published before public launch. Questions:{" "}
        <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a>.
      </div>

      <div className="space-y-8 text-sm text-muted-foreground leading-relaxed">

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">1. Acceptance of Terms</h2>
          <p>
            By accessing or using KIOKU™, operated by <strong className="text-foreground">IKONBAI™, Inc.</strong> ("Company", "we", "us"),
            you agree to be bound by these Terms of Service. If you do not agree, do not use KIOKU™.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">2. Beta Product</h2>
          <p>
            KIOKU™ is currently in <strong className="text-foreground">Beta</strong>. The platform is provided "as-is" for evaluation purposes.
            Features, pricing, and APIs may change without notice. Beta users acknowledge that the product may have bugs,
            downtime, or data inconsistencies.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">3. Permitted Use</h2>
          <p>You may use KIOKU™ only for lawful purposes. You agree not to:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Use KIOKU™ to generate illegal, harmful, or abusive content.</li>
            <li>Attempt to reverse-engineer, scrape, or attack KIOKU™ infrastructure.</li>
            <li>Share your account credentials with unauthorized parties.</li>
            <li>Use KIOKU™ in ways that violate applicable AI regulations (including the EU AI Act).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">4. AI-Generated Content</h2>
          <p>
            KIOKU™ War Room™ sessions may produce AI-generated content. <strong className="text-foreground">All AI responses are for
            informational purposes only</strong> and do not constitute legal, financial, medical, or professional advice.
            You are responsible for verifying and acting on any AI-generated content.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">5. Subscriptions & Billing</h2>
          <p>
            Paid plans are billed monthly or annually. Payments are processed by Stripe. IKONBAI™, Inc. does not store
            payment card details. You may cancel your subscription at any time. Refunds are at the discretion of IKONBAI™, Inc.
            and will be evaluated case by case.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">6. Intellectual Property</h2>
          <p>
            KIOKU™ and IKONBAI™ are trademarks of IKONBAI™, Inc. All platform code, design, and branding are proprietary.
            The KIOKU™ platform is Patent Pending. You retain ownership of the data you input into KIOKU™.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">7. Data & Privacy</h2>
          <p>
            Use of KIOKU™ is also governed by our{" "}
            <a href="#/privacy" className="text-primary underline">Privacy Policy</a>, which is incorporated into these Terms by reference.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">8. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, IKONBAI™, Inc. shall not be liable for any indirect, incidental, special,
            consequential, or punitive damages arising from your use of KIOKU™. Our total liability shall not exceed the
            amount you paid us in the 12 months preceding the claim.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">9. Governing Law</h2>
          <p>
            These Terms are governed by the laws of the State of Delaware, United States, without regard to conflict of law principles.
            Disputes shall be resolved in the courts of Delaware.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">10. Changes to Terms</h2>
          <p>
            We may update these Terms at any time. We will notify users of material changes via email.
            Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-3">11. Contact</h2>
          <p>
            For legal inquiries: <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a><br />
            IKONBAI™, Inc. · United States
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>© {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/privacy" className="hover:text-foreground underline">Privacy Policy</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
