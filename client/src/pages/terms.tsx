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
          KIOKU™ by IKONBAI™, Inc. &nbsp;·&nbsp; Last Updated: April 14, 2026 &nbsp;·&nbsp; Patent Pending
        </p>
      </div>

      <div className="mb-8 p-4 rounded-xl border border-yellow-400/20 bg-yellow-400/5 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-yellow-400">Note:</strong> This is a preliminary Terms of Service prepared by IKONBAI™, Inc. A legally
        reviewed version will be published before public launch. Questions:{" "}
        <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a>.
      </div>

      {/* Table of Contents */}
      <nav className="mb-10 p-4 rounded-xl border border-border bg-muted/30">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-3">Table of Contents</h2>
        <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
          <li><a href="#tos-acceptance" className="hover:text-primary underline-offset-2 hover:underline">Acceptance of Terms</a></li>
          <li><a href="#tos-beta" className="hover:text-primary underline-offset-2 hover:underline">Beta Product</a></li>
          <li><a href="#tos-data-ownership" className="hover:text-primary underline-offset-2 hover:underline">Data Ownership</a></li>
          <li><a href="#tos-license" className="hover:text-primary underline-offset-2 hover:underline">License to KIOKU</a></li>
          <li><a href="#tos-data-export" className="hover:text-primary underline-offset-2 hover:underline">Data Export</a></li>
          <li><a href="#tos-data-deletion" className="hover:text-primary underline-offset-2 hover:underline">Data Deletion</a></li>
          <li><a href="#tos-ai-content" className="hover:text-primary underline-offset-2 hover:underline">AI-Generated Content</a></li>
          <li><a href="#tos-ip" className="hover:text-primary underline-offset-2 hover:underline">Intellectual Property</a></li>
          <li><a href="#tos-acceptable-use" className="hover:text-primary underline-offset-2 hover:underline">Acceptable Use</a></li>
          <li><a href="#tos-billing" className="hover:text-primary underline-offset-2 hover:underline">Subscriptions &amp; Billing</a></li>
          <li><a href="#tos-availability" className="hover:text-primary underline-offset-2 hover:underline">Service Availability</a></li>
          <li><a href="#tos-liability" className="hover:text-primary underline-offset-2 hover:underline">Limitation of Liability</a></li>
          <li><a href="#tos-privacy" className="hover:text-primary underline-offset-2 hover:underline">Data &amp; Privacy</a></li>
          <li><a href="#tos-governing" className="hover:text-primary underline-offset-2 hover:underline">Governing Law</a></li>
          <li><a href="#tos-changes" className="hover:text-primary underline-offset-2 hover:underline">Changes to Terms</a></li>
          <li><a href="#tos-contact" className="hover:text-primary underline-offset-2 hover:underline">Contact</a></li>
        </ol>
      </nav>

      <div className="space-y-8 text-sm text-muted-foreground leading-relaxed">

        <section id="tos-acceptance">
          <h2 className="text-base font-semibold text-foreground mb-3">1. Acceptance of Terms</h2>
          <p>
            By accessing or using KIOKU™, operated by <strong className="text-foreground">IKONBAI Inc.</strong> ("Company", "we", "us"),
            you agree to be bound by these Terms of Service. If you do not agree, do not use KIOKU™.
          </p>
        </section>

        <section id="tos-beta">
          <h2 className="text-base font-semibold text-foreground mb-3">2. Beta Product</h2>
          <p>
            KIOKU™ is currently in <strong className="text-foreground">Beta</strong>. The platform is provided "as-is" for evaluation purposes.
            Features, pricing, and APIs may change without notice. Beta users acknowledge that the product may have bugs,
            downtime, or data inconsistencies.
          </p>
        </section>

        <section id="tos-data-ownership">
          <h2 className="text-base font-semibold text-foreground mb-3">3. Data Ownership</h2>
          <p className="p-3 rounded-lg border border-primary/20 bg-primary/5 text-foreground font-medium">
            You own your data. Export anytime.
          </p>
          <p className="mt-3">
            You retain full ownership of all data you upload, create, or generate through KIOKU™, including but not limited to:
            memories, agent configurations, deliberation results, consensus decisions, and all derived analytics.
            IKONBAI Inc. claims no ownership of your data.
          </p>
        </section>

        <section id="tos-license">
          <h2 className="text-base font-semibold text-foreground mb-3">4. License to KIOKU</h2>
          <p>
            You grant KIOKU™ a limited, non-exclusive license to process your data solely for the purpose of providing the service.
            We do not sell, share, or use your data for training AI models.
          </p>
        </section>

        <section id="tos-data-export">
          <h2 className="text-base font-semibold text-foreground mb-3">5. Data Export</h2>
          <p>
            You may export all your data at any time in <strong className="text-foreground">KMEF (KIOKU Memory Exchange Format)</strong>,
            JSON, or CSV format at no additional cost. Upon account termination, you have{" "}
            <strong className="text-foreground">90 days</strong> to export your data before permanent deletion.
          </p>
        </section>

        <section id="tos-data-deletion">
          <h2 className="text-base font-semibold text-foreground mb-3">6. Data Deletion</h2>
          <p>
            You may request complete deletion of your account and all associated data at any time via{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">DELETE /api/account</code> or
            through the dashboard. Deletion is permanent and irreversible. We will provide written confirmation within 30 days.
          </p>
        </section>

        <section id="tos-ai-content">
          <h2 className="text-base font-semibold text-foreground mb-3">7. AI-Generated Content</h2>
          <p>
            Deliberation outputs (agent positions, consensus decisions) are generated using AI models.
            While you own these outputs for commercial use, they may not be eligible for copyright protection under
            current U.S. law (<em>Thaler v. Perlmutter</em>). We recommend applying human editorial judgment to
            AI-generated content before relying on it for legal or regulatory purposes.
          </p>
          <p className="mt-3">
            KIOKU™ War Room™ sessions may produce AI-generated content.{" "}
            <strong className="text-foreground">All AI responses are for informational purposes only</strong> and do not
            constitute legal, financial, medical, or professional advice. You are responsible for verifying and acting on
            any AI-generated content.
          </p>
        </section>

        <section id="tos-ip">
          <h2 className="text-base font-semibold text-foreground mb-3">8. Intellectual Property</h2>
          <p>
            KIOKU™ platform, including its deliberation engine, memory system, algorithms, and user interface, is the
            intellectual property of IKONBAI Inc. Your use of the service does not grant any rights to our intellectual property.
          </p>
          <p className="mt-3">
            KIOKU™ and IKONBAI™ are trademarks of IKONBAI Inc. All platform code, design, and branding are proprietary.
            The KIOKU™ platform is Patent Pending. You retain ownership of the data you input into KIOKU™.
          </p>
        </section>

        <section id="tos-acceptable-use">
          <h2 className="text-base font-semibold text-foreground mb-3">9. Acceptable Use</h2>
          <p>You may use KIOKU™ only for lawful purposes. You agree not to:</p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Use KIOKU™ to generate illegal, harmful, or abusive content.</li>
            <li>Attempt to reverse-engineer, decompile, or disassemble any part of KIOKU™.</li>
            <li>Scrape, crawl, or attack KIOKU™ infrastructure.</li>
            <li>Share your account credentials with unauthorized parties.</li>
            <li>Use KIOKU™ in ways that violate applicable AI regulations (including the EU AI Act).</li>
            <li>Use automated means to access KIOKU™ except through our published APIs.</li>
          </ul>
        </section>

        <section id="tos-billing">
          <h2 className="text-base font-semibold text-foreground mb-3">10. Subscriptions &amp; Billing</h2>
          <p>
            Paid plans are billed monthly or annually and <strong className="text-foreground">auto-renew</strong> at the end of each billing cycle
            unless cancelled. Payments are processed by Stripe. IKONBAI Inc. does not store payment card details.
          </p>
          <p className="mt-3">
            You may cancel your subscription at any time. Cancellation takes effect at the end of the current billing period.
            Refunds are at the discretion of IKONBAI Inc. and will be evaluated case by case. See our{" "}
            <a href="#/billing" className="text-primary underline">Pricing page</a> for current plan details.
          </p>
        </section>

        <section id="tos-availability">
          <h2 className="text-base font-semibold text-foreground mb-3">11. Service Availability</h2>
          <p>
            IKONBAI Inc. strives to maintain high availability of the KIOKU™ platform but does not guarantee uninterrupted service.
            We may perform scheduled maintenance with reasonable advance notice. We are not liable for service interruptions caused by:
          </p>
          <ul className="list-disc list-inside space-y-1.5 mt-2">
            <li>Force majeure events (natural disasters, pandemics, war, government action).</li>
            <li>Third-party service outages (cloud providers, AI model providers, payment processors).</li>
            <li>Scheduled maintenance with prior notice.</li>
            <li>Your internet connection or device issues.</li>
          </ul>
        </section>

        <section id="tos-liability">
          <h2 className="text-base font-semibold text-foreground mb-3">12. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, IKONBAI Inc. shall not be liable for any indirect, incidental, special,
            consequential, or punitive damages arising from your use of KIOKU™. Our total liability shall not exceed the
            amount you paid us in the 12 months preceding the claim.
          </p>
        </section>

        <section id="tos-privacy">
          <h2 className="text-base font-semibold text-foreground mb-3">13. Data &amp; Privacy</h2>
          <p>
            Use of KIOKU™ is also governed by our{" "}
            <a href="#/privacy" className="text-primary underline">Privacy Policy</a>, which is incorporated into these Terms by reference.
          </p>
        </section>

        <section id="tos-governing">
          <h2 className="text-base font-semibold text-foreground mb-3">14. Governing Law</h2>
          <p>
            These Terms are governed by the laws of the State of Delaware, United States, without regard to conflict of law principles.
            Disputes shall be resolved in the courts of Delaware.
          </p>
        </section>

        <section id="tos-changes">
          <h2 className="text-base font-semibold text-foreground mb-3">15. Changes to Terms</h2>
          <p>
            We may update these Terms at any time. We will notify users of material changes via email.
            Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section id="tos-contact">
          <h2 className="text-base font-semibold text-foreground mb-3">16. Contact</h2>
          <p>
            For legal inquiries: <a href="mailto:legal@ikonbai.com" className="text-primary underline">legal@ikonbai.com</a><br />
            General contact: <a href="mailto:kotkave@gmail.com" className="text-primary underline">kotkave@gmail.com</a><br />
            IKONBAI Inc. · United States
          </p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 items-center justify-between text-xs text-muted-foreground/50">
        <span>&copy; {new Date().getFullYear()} IKONBAI™, Inc. · Patent Pending · All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#/privacy" className="hover:text-foreground underline">Privacy Policy</a>
          <a href="#/" className="hover:text-foreground underline">Back to App</a>
        </div>
      </div>
    </div>
  );
}
