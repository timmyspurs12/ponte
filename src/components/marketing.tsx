"use client";
import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ShieldCheck,
  Globe2,
  Zap,
  Code2,
  Menu,
  X,
  CheckCircle2,
  GitBranch,
  FileText,
} from "lucide-react";
import { Invoice } from "@/lib/models";
import { quote } from "@/lib/demo-service";
import { Mark, Logo, Cta } from "./ui";
import { Developers } from "./developers";
function RouteAtlas() {
  const reduced = useReducedMotion();
  return (
    <div className="atlas">
      <div className="atlas-top">
        <span>
          <span className="live-dot" /> The Brazil → global corridor
        </span>
        <span className="mono">DEMO ROUTE</span>
      </div>
      <svg
        className="atlas-svg"
        viewBox="0 0 600 350"
        role="img"
        aria-label="Brazilian Pix payment flows through PONTE and optimized liquidity to an international supplier"
      >
        <defs>
          <pattern
            id="grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r=".8" fill="#b7c9bd" />
          </pattern>
        </defs>
        <rect width="600" height="350" fill="url(#grid)" />
        <path
          d="M-20 270C100 270 72 100 220 100S370 245 620 80M-20 300C130 300 80 125 220 125S380 270 620 110M-20 330C150 330 88 150 220 150S390 295 620 140"
          fill="none"
          stroke="#cfdbd0"
          strokeWidth="1"
        />
        <path
          d="M65 237H160Q185 237 185 212V175Q185 150 210 150H285Q310 150 310 175V210Q310 235 335 235H430Q455 235 455 210V120H540"
          fill="none"
          stroke="#167a70"
          strokeWidth="2"
        />
        <motion.path
          d="M65 237H160Q185 237 185 212V175Q185 150 210 150H285Q310 150 310 175V210Q310 235 335 235H430Q455 235 455 210V120H540"
          fill="none"
          stroke="#167a70"
          strokeWidth="5"
          strokeDasharray="8 650"
          initial={{ strokeDashoffset: 650 }}
          animate={{ strokeDashoffset: 0 }}
          transition={{ duration: reduced ? 0 : 4, ease: "easeOut" }}
        />
        <circle cx="65" cy="237" r="6" fill="#167a70" />
        <circle cx="540" cy="120" r="6" fill="#167a70" />
        <g transform="translate(216 115)">
          <rect width="68" height="68" rx="14" fill="#102a2b" />
          <path
            d="M16 48V30a12 12 0 0 1 24 0v18M28 48V30a12 12 0 0 1 24 0v18"
            stroke="#dcebe3"
            strokeWidth="4"
            fill="none"
          />
        </g>
        <text
          x="250"
          y="210"
          textAnchor="middle"
          fontSize="11"
          fill="#49625a"
          fontFamily="monospace"
        >
          PONTE ENGINE
        </text>
      </svg>
      <div className="route-ticket origin">
        <div className="currency-symbol brazil">R$</div>
        <div>
          <small>You pay locally</small>
          <strong>
            25,000.00 <em>BRL</em>
          </strong>
          <span>Pix · Brazil</span>
        </div>
        <CheckCircle2 size={17} />
      </div>
      <div className="route-ticket destination">
        <div className="currency-symbol">$</div>
        <div>
          <small>Your supplier receives</small>
          <strong>
            4,745.23 <em>USDG</em>
          </strong>
          <span>Digital dollars · Arbitrum</span>
        </div>
        <ArrowUpRight size={18} />
      </div>
      <div className="route-note">
        <GitBranch size={13} /> Optimised liquidity{" "}
        <span>3 routes compared</span>
      </div>
      <div className="atlas-bottom">
        <ShieldCheck size={14} />
        <span>Local in. Global out. Every step visible.</span>
        <span className="mono">01 → 04</span>
      </div>
    </div>
  );
}
function Reveal({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className: string;
  id?: string;
}) {
  return (
    <motion.section
      id={id}
      data-reveal
      className={className}
      initial={{ opacity: 1, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      {children}
    </motion.section>
  );
}
export function Marketing() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="marketing-header wrap">
        <Logo />
        <nav className={open ? "open" : ""} aria-label="Main navigation">
          <a href="#product" onClick={() => setOpen(false)}>
            Product
          </a>
          <a href="#how-it-works" onClick={() => setOpen(false)}>
            How it works
          </a>
          <a href="#developers" onClick={() => setOpen(false)}>
            Developers
          </a>
          <a href="#security" onClick={() => setOpen(false)}>
            Security
          </a>
        </nav>
        <div className="header-actions">
          <Link href="/app" className="sign-in">
            Sign in <ArrowUpRight size={14} />
          </Link>
          <Cta href="/app">Get started</Cta>
          <button
            className="icon-button mobile-menu"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <main id="main">
        <motion.section
          className="hero wrap"
          initial="hidden"
          animate="show"
          variants={{
            hidden: { opacity: 0 },
            show: { opacity: 1, transition: { staggerChildren: 0.12 } },
          }}
        >
          <motion.div
            className="hero-copy"
            variants={{
              hidden: { opacity: 0, y: 16 },
              show: { opacity: 1, y: 0 },
            }}
          >
            <div className="eyebrow">
              <span className="tiny-bridge">↗</span> Built for business beyond
              borders
            </div>
            <h1>
              Local payments.
              <br />
              Global possibility.
            </h1>
            <p>
              A clearer way from Brazilian reais to digital dollars. Connect Pix
              payments with intelligent USDG settlement, and keep your business
              moving.
            </p>
            <div className="hero-actions">
              <Cta href="/app/invoices/new">Create an invoice</Cta>
              <a className="text-link" href="#how-it-works">
                See how it works <ArrowRight size={16} />
              </a>
            </div>
            <div className="hero-disclaimer">
              <span className="live-dot" /> Interactive prototype{" "}
              <span className="divider">/</span> No real funds moved
            </div>
          </motion.div>
          <motion.div
            className="hero-visual"
            variants={{
              hidden: { opacity: 0, y: 22 },
              show: { opacity: 1, y: 0 },
            }}
          >
            <RouteAtlas />
          </motion.div>
        </motion.section>
        <div className="corridor-strip">
          <div className="wrap">
            <span>One connected payment journey.</span>
            <div>
              <span className="pix-mark">◇</span> Pix <ArrowRight />
              <strong>
                <Mark /> PONTE
              </strong>
              <ArrowRight />
              <span>
                USDG <small>on Arbitrum</small>
              </span>
            </div>
            <span>Designed for the next generation of trade.</span>
          </div>
        </div>
        <Reveal className="section wrap" id="how-it-works">
          <div className="section-heading">
            <div>
              <span className="section-label">From local to global</span>
              <h2>
                Cross borders.
                <br />
                Not your fingers.
              </h2>
            </div>
            <p>
              One invoice. A familiar way to pay.
              <br />A transparent path to your supplier.
            </p>
          </div>
          <div className="process">
            {[
              {
                title: "Create your invoice",
                text: "Set the amount in reais, add your supplier and choose digital dollar settlement.",
                icon: FileText,
              },
              {
                title: "Pay the local way",
                text: "Share a payment link and follow a familiar Pix payment experience.",
                icon: Zap,
              },
              {
                title: "Find a clearer route",
                text: "Compare sample liquidity routes, fees and expected output before execution.",
                icon: GitBranch,
              },
              {
                title: "Close the loop",
                text: "Follow settlement from start to finish, with a clear receipt for your records.",
                icon: CheckCircle2,
              },
            ].map((item, i) => (
              <article key={item.title}>
                <div className="process-top">
                  <item.icon size={24} />
                  <span className="mono">0{i + 1}</span>
                </div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </Reveal>
        <section className="product-section" id="product">
          <div className="wrap product-split">
            <div>
              <span className="section-label">Intelligence, not guesswork</span>
              <h2>
                A better route.
                <br />
                In plain sight.
              </h2>
              <p>
                Payments shouldn’t disappear into a black box. PONTE makes the
                journey visible—from the first real to the final digital dollar.
              </p>
              <ul className="check-list">
                <li>
                  <Check /> Compare liquidity before you commit
                </li>
                <li>
                  <Check /> See fees and minimum output upfront
                </li>
                <li>
                  <Check /> Track every step in one workspace
                </li>
              </ul>
              <Cta href="/app/invoices/demo-1">Explore a demo payment</Cta>
            </div>
            <div className="routing-preview">
              <div className="row">
                <span>
                  <GitBranch size={18} /> Route comparison
                </span>
                <span className="dark-pill">Sample quote</span>
              </div>
              <div className="quote-summary">
                <small>Funding amount</small>
                <strong className="mono">R$ 25,000.00</strong>
                <span>BRL → USDG</span>
              </div>
              {quote(25000).routes.map((r, i) => (
                <div
                  className={`preview-route ${i === 0 ? "selected" : ""}`}
                  key={r.id}
                >
                  <span>
                    {i === 0 ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <GitBranch size={18} />
                    )}
                    <span>
                      {r.name}
                      <small>
                        {(r.fee * 100).toFixed(2)}% fee · {r.slippage}% slippage
                      </small>
                    </span>
                  </span>
                  <strong className="mono">
                    {r.output.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })}
                    <small>USDG {i === 0 ? "· Best output" : ""}</small>
                  </strong>
                </div>
              ))}
              <p>
                Illustrative fixtures. No live liquidity or contract execution.
              </p>
            </div>
          </div>
        </section>
        <Reveal className="section wrap transparency">
          <div className="receipt-mini">
            <div className="success-symbol">
              <Check size={25} />
            </div>
            <span className="section-label">Simulated settlement complete</span>
            <strong className="big-number">
              4,745.23 <small>USDG</small>
            </strong>
            <div className="receipt-line">
              <span>Invoice</span>
              <b>PNT-2026-1048</b>
            </div>
            <div className="receipt-line">
              <span>Recipient</span>
              <b>Meridian Supply Co.</b>
            </div>
            <div className="receipt-line">
              <span>Route</span>
              <b>Direct liquidity</b>
            </div>
            <div className="receipt-stamp">
              <ShieldCheck size={15} /> Clear records. Complete visibility.
            </div>
          </div>
          <div>
            <span className="section-label">Nothing lost in translation</span>
            <h2>
              From payment
              <br />
              to peace of mind.
            </h2>
            <p>
              Know what was paid, how it was routed, and what your supplier
              receives. Every demo settlement ends with a detailed, exportable
              receipt.
            </p>
            <Link href="/app" className="text-link">
              Step inside the workspace <ArrowRight size={16} />
            </Link>
          </div>
        </Reveal>
        <section className="infrastructure" id="developers">
          <div className="wrap infrastructure-grid">
            <div>
              <span className="section-label">
                Local experience. Programmable foundations.
              </span>
              <h2>
                Built to bridge
                <br />
                two financial worlds.
              </h2>
              <p>
                A frontend vision for Pix funding, USDG settlement and efficient
                execution on Arbitrum. Open interfaces. Clear integration
                boundaries.
              </p>
              <Link className="text-link" href="/developers">
                Explore the architecture <ArrowUpRight size={16} />
              </Link>
              <div className="tech-tags">
                <span>Arbitrum</span>
                <span>USDG</span>
                <span>Stylus-ready design</span>
              </div>
            </div>
            <div className="code-window">
              <div>
                <Code2 size={16} /> ponte / settlement.ts{" "}
                <span>Phase 2 interface</span>
              </div>
              <pre>
                <code>
                  <span>{"// Local payment. Global intent."}</span>
                  {"\n"}const payment = {"{"}
                  {"\n"} funding: <b>{'"BRL / Pix"'}</b>,{"\n"} settlement:{" "}
                  <b>{'"USDG"'}</b>,{"\n"} network: <b>{'"Arbitrum"'}</b>,{"\n"}{" "}
                  execution: <b>{'"simulated"'}</b>
                  {"\n"}
                  {"}"};{"\n\n"}
                  <span>{"// Real integrations come next."}</span>
                </code>
              </pre>
            </div>
          </div>
        </section>
        <Reveal className="section wrap" id="security">
          <div className="section-heading">
            <div>
              <span className="section-label">Trust is in the details</span>
              <h2>Clarity at every layer.</h2>
            </div>
            <p>
              Designed with responsible financial
              <br />
              infrastructure in mind.
            </p>
          </div>
          <div className="security-grid">
            <article>
              <ShieldCheck />
              <h3>Control before execution</h3>
              <p>
                Review recipients, fees and minimum output before advancing the
                simulated payment.
              </p>
            </article>
            <article>
              <Globe2 />
              <h3>Transparent by design</h3>
              <p>
                Visible lifecycle states and detailed receipts keep every
                payment understandable.
              </p>
            </article>
            <article>
              <Code2 />
              <h3>Honest about what’s next</h3>
              <p>
                No live wallets or funds. Compliance, provider controls and
                contract security belong to Phase 2.
              </p>
            </article>
          </div>
        </Reveal>
        <section className="final-cta wrap">
          <div>
            <span className="section-label">
              Your next market is closer than you think.
            </span>
            <h2>Make the connection.</h2>
          </div>
          <Cta href="/app/invoices/new">Create your first demo invoice</Cta>
        </section>
      </main>
      <footer className="wrap footer">
        <div>
          <Logo />
          <p>A better way across borders.</p>
        </div>
        <div>
          <Link href="/app">Explore the demo</Link>
          <Link href="/developers">Developer overview</Link>
          <a href="#security">Security approach</a>
        </div>
        <div>
          <small>Built for Arbitrum Open House São Paulo.</small>
          <small>Frontend concept · All payments are simulated.</small>
          <small>© 2026 PONTE</small>
        </div>
      </footer>
    </>
  );
}
