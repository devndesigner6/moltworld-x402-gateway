// Client script shared by every page. Each widget only runs when its root element exists.
export const SITE_JS = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ORIGIN = document.body.dataset.origin || location.origin;
  const EXPLORER = document.body.dataset.explorer || "https://lora.algokit.io/mainnet";
  let networkInfo = null;
  const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v; else if (k === "text") node.textContent = v; else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  };
  const toast = (msg) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 1800); };
  const fmtMicro = (m) => "$" + (Number(m) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const fmtTokenAtomic = (raw, decimals, symbol) => {
    try {
      const amount = BigInt(String(raw)), places = BigInt(Number(decimals) || 0), scale = 10n ** places;
      const whole = amount / scale;
      const fraction = places ? (amount % scale).toString().padStart(Number(places), "0").slice(0, 6).replace(/0+$/, "") : "";
      return String(whole) + (fraction ? "." + fraction : "") + " " + (symbol || "tokens");
    } catch { return String(raw) + " " + (symbol || "tokens"); }
  };
  const kv = (pairs) => { const dl = el("dl", { class: "kv" }); for (const [k, v] of pairs) { if (v === undefined || v === null || v === "") continue; dl.append(el("dt", { text: k }), typeof v === "string" ? el("dd", { text: v }) : el("dd", {}, v)); } return dl; };
  const txLink = (txid) => { const path = /blockscout|explorer\.testnet\.chain\.robinhood/i.test(EXPLORER) ? "/tx/" : "/transaction/"; const a = el("a", { href: EXPLORER + path + encodeURIComponent(txid), target: "_blank", rel: "noopener", text: txid.slice(0, 10) + "..." + txid.slice(-6) }); a.title = txid; return a; };
  const errorBox = (msg) => el("p", { class: "err", text: msg });
  const isAddress = (s) => /^[A-Z2-7]{58}$/.test(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(path, init) {
    const res = await fetch(path, init);
    let body = null;
    try { body = await res.json(); } catch {}
    return { res, body };
  }
  const catalogData = () => { const node = $("catalog"); return node ? JSON.parse(node.textContent) : []; };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgba = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]; };
  const onScheme = (fn) => matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => requestAnimationFrame(fn));

  // ---------------------------------------------------------------- header
  const header = $("siteHeader");
  const onScroll = () => header && header.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const nav = $("nav"), menuBtn = $("menuBtn");
  const triggers = $$(".nav-trigger");
  const desktop = () => matchMedia("(min-width: 961px)").matches;
  function setMenu(trigger, open) {
    trigger.setAttribute("aria-expanded", String(open));
    const menu = $(trigger.getAttribute("aria-controls"));
    menu.hidden = !open;
    menu.style.left = "";
    if (open && desktop()) {
      const r = menu.getBoundingClientRect(), over = r.right - (document.documentElement.clientWidth - 16);
      if (over > 0) menu.style.left = (parseFloat(getComputedStyle(menu).left) - over) + "px";
    }
  }
  function closeAll(except) { triggers.forEach((t) => t !== except && t.getAttribute("aria-expanded") === "true" && setMenu(t, false)); }
  triggers.forEach((t) => {
    let hoverOpenedAt = 0;
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      // A click right after hover opened the menu should keep it open, not toggle it shut.
      if (desktop() && Date.now() - hoverOpenedAt < 500) return;
      const open = t.getAttribute("aria-expanded") !== "true";
      closeAll(t);
      setMenu(t, open);
    });
    const item = t.closest(".nav-item");
    let timer;
    item.addEventListener("mouseenter", () => {
      if (!desktop()) return;
      clearTimeout(timer);
      if (t.getAttribute("aria-expanded") !== "true") { hoverOpenedAt = Date.now(); closeAll(t); setMenu(t, true); }
    });
    item.addEventListener("mouseleave", () => { if (!desktop()) return; timer = setTimeout(() => setMenu(t, false), 160); });
  });
  document.addEventListener("click", (e) => { if (desktop() && !e.target.closest(".nav-item")) closeAll(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = triggers.find((t) => t.getAttribute("aria-expanded") === "true");
    if (open) { setMenu(open, false); open.focus(); }
    else if (nav && nav.classList.contains("open")) { toggleNav(false); menuBtn.focus(); }
  });
  function toggleNav(open) {
    nav.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.querySelector(".menu-text").textContent = open ? "Close" : "Menu";
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (menuBtn) menuBtn.addEventListener("click", () => toggleNav(!nav.classList.contains("open")));

  // ---------------------------------------------------------------- network label
  const netLabel = $("netLabel");
  if (netLabel) {
    const status = $("netStatus");
    api("/health").then(({ res, body }) => {
      networkInfo = body;
      const ok = res.ok && body && body.ready;
      const name = body && body.payment_chain === "robinhood"
        ? "Robinhood Chain " + (body.network === "mainnet" ? "Mainnet" : "Testnet")
        : "Algorand " + (body && body.network === "mainnet" ? "Mainnet" : "Testnet");
      netLabel.textContent = name + (ok ? "" : " (unavailable)");
      status.classList.toggle("down", !ok);
    }).catch(() => status.classList.add("down"));
  }

  // ---------------------------------------------------------------- copy + tabs
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy], [data-copy-tabs]");
    if (!btn) return;
    let text = btn.dataset.copy;
    if (btn.dataset.copyTabs) {
      const panel = $$('[id^="p-' + btn.dataset.copyTabs + '-"]').find((p) => !p.hidden);
      text = panel ? panel.textContent : "";
    }
    try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed"); }
  });
  $$('[role="tablist"]').forEach((list) => {
    const tabs = $$('[role="tab"]', list);
    const select = (tab, focus) => {
      tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; $(t.getAttribute("aria-controls")).hidden = !on; });
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t, true));
      t.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") select(tabs[(i + 1) % tabs.length], true);
        if (e.key === "ArrowLeft") select(tabs[(i - 1 + tabs.length) % tabs.length], true);
      });
    });
  });

  // ---------------------------------------------------------------- motion: reveal, split headlines, counters
  $$("[data-split]").forEach((node) => {
    let i = 0;
    const wrap = (n) => {
      for (const child of Array.from(n.childNodes)) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.append(part); return; }
            const w = el("span", { class: "w" }, el("span", { text: part }));
            w.firstChild.style.setProperty("--i", String(i++));
            frag.append(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1) wrap(child);
      }
    };
    wrap(node);
    node.classList.add("split");
  });
  const revealTargets = $$("[data-reveal], [data-split], .steps, [data-term], [data-chat], [data-meter], [data-receipt]");
  const fire = (node) => { node.classList.add("in"); node.dispatchEvent(new CustomEvent("reveal")); };
  if ("IntersectionObserver" in window && !REDUCE) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { fire(e.target); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
    revealTargets.forEach((n) => io.observe(n));
  } else revealTargets.forEach(fire);
  const onReveal = (node, fn) => { if (node.classList.contains("in")) fn(); else node.addEventListener("reveal", fn, { once: true }); };

  // Counts a number up to its final text, keeping the prefix and decimals of that text.
  function countTo(node, finalText) {
    const m = /^([^0-9]*)([0-9][0-9,]*\.?[0-9]*)(.*)$/.exec(finalText);
    if (!m || REDUCE) { node.textContent = finalText; return; }
    const target = parseFloat(m[2].replace(/,/g, "")), decimals = (m[2].split(".")[1] || "").length, start = performance.now(), dur = 1400;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur), v = target * (1 - Math.pow(1 - k, 4));
      node.textContent = k < 1 ? m[1] + v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[3] : finalText;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  $$("[data-count]").forEach((n) => onReveal(n.closest("[data-reveal]") || n, () => countTo(n, n.dataset.count)));

  // ---------------------------------------------------------------- motion: pointer
  if (!REDUCE && matchMedia("(hover: hover)").matches) {
    $$("[data-magnetic]").forEach((b) => {
      b.addEventListener("pointermove", (e) => { const r = b.getBoundingClientRect(); b.style.transform = "translate(" + ((e.clientX - r.left - r.width / 2) * 0.18) + "px," + ((e.clientY - r.top - r.height / 2) * 0.3) + "px)"; });
      b.addEventListener("pointerleave", () => { b.style.transform = ""; });
    });
    $$("[data-tilt]").forEach((c) => {
      c.addEventListener("pointermove", (e) => { const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5; c.style.transform = "perspective(900px) rotateX(" + (-y * 4) + "deg) rotateY(" + (x * 5) + "deg) translateY(-3px)"; });
      c.addEventListener("pointerleave", () => { c.style.transform = ""; });
    });
  }

  // ---------------------------------------------------------------- motion: product demos
  // Terminal: lines appear in order, then the run repeats.
  $$("[data-term]").forEach((term) => onReveal(term, async () => {
    const lines = $$(".l", term);
    for (;;) {
      lines.forEach((l) => l.classList.remove("on"));
      for (const l of lines) { await sleep(Number(l.dataset.wait || 500)); l.classList.add("on"); }
      if (REDUCE) return;
      await sleep(4200);
    }
  }));
  // Agent session: messages and tool calls arrive one by one with a typing indicator.
  $$("[data-chat]").forEach((chat) => onReveal(chat, async () => {
    const steps = $$("[data-step]", chat), typing = chat.querySelector(".typing");
    for (;;) {
      steps.forEach((s) => s.classList.remove("on"));
      for (const s of steps) {
        if (typing && s.classList.contains("bot")) { s.before(typing); typing.classList.remove("hidden"); await sleep(REDUCE ? 0 : 900); typing.classList.add("hidden"); }
        else await sleep(REDUCE ? 0 : Number(s.dataset.wait || 700));
        s.classList.add("on");
      }
      if (REDUCE) return;
      await sleep(5200);
    }
  }));
  // Mandate meter: calls spend against the daily cap; the switch revokes the mandate.
  $$("[data-meter]").forEach((meter) => {
    const cells = $$(".meter-bar i", meter), spent = meter.querySelector("[data-spent]"), sw = meter.querySelector(".switch"), state = meter.querySelector("[data-state]");
    const cap = Number(meter.dataset.cap || 5), per = cap / cells.length;
    let n = 0, active = true;
    const paint = () => { cells.forEach((c, i) => { c.className = i < n ? (n >= cells.length ? "cap" : "on") : ""; }); spent.textContent = "$" + (n * per).toFixed(2); };
    sw.addEventListener("click", () => { active = !active; sw.setAttribute("aria-checked", String(active)); state.textContent = active ? "active" : "revoked: every payment refused"; });
    onReveal(meter, async () => {
      for (;;) {
        await sleep(REDUCE ? 99999999 : 700);
        if (!active) continue;
        n = n >= cells.length ? 0 : n + 1;
        if (n === cells.length) { paint(); state.textContent = "daily cap reached"; await sleep(1800); state.textContent = "active"; continue; }
        paint();
      }
    });
  });
  // Receipt: hashes resolve from noise, then the signature check stamps it.
  $$("[data-receipt]").forEach((card) => onReveal(card, async () => {
    const fields = $$("[data-scramble]", card), chars = "abcdef0123456789";
    for (;;) {
      card.classList.remove("verified");
      await Promise.all(fields.map(async (f) => {
        const finalText = f.dataset.scramble;
        for (let k = 0; k <= 14; k++) {
          f.textContent = finalText.split("").map((ch, i) => (i < (finalText.length * k) / 14 ? ch : chars[(Math.random() * 16) | 0])).join("");
          await sleep(REDUCE ? 0 : 45);
        }
      }));
      await sleep(300);
      card.classList.add("verified");
      if (REDUCE) return;
      await sleep(5200);
    }
  }));

  // ---------------------------------------------------------------- WebGPU scenes (loaded on demand)
  const worldCanvas = $("world");
  if (worldCanvas && document.body.dataset.threeSrc) {
    const box = worldCanvas.parentElement;
    const colors = () => ({ ink: cssVar("--text"), dim: cssVar("--line-2"), accent: cssVar("--signal"), mint: cssVar("--signal"), bg: cssVar("--bg") });
    const models = catalogData();
    const start = () => import(document.body.dataset.worldSrc).then((mod) => mod.mount(worldCanvas, {
      lib: document.body.dataset.threeSrc,
      colors,
      onRequest(p) {
        const m = models.length ? models[(Math.random() * models.length) | 0] : null;
        const chip = el("div", { class: "world-chip" }, el("i"), m ? m.name + " " : "request ", el("b", { text: m ? "from " + m.from : "quoted" }));
        chip.style.left = p.x + "px"; chip.style.top = p.y + "px";
        box.append(chip);
        setTimeout(() => chip.remove(), 2500);
      },
    })).then((scene) => {
      box.classList.add("world-ready");
      box.dataset.backend = scene.backend;
      onScheme(() => scene.setColors(colors()));
    }).catch(() => {});
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 1200 }); else setTimeout(start, 300);
  }
  const flowCanvas = $("flow");
  if (flowCanvas && document.body.dataset.tgpuSrc) {
    const box = flowCanvas.parentElement;
    const colors = () => ({ ink: rgba(cssVar("--muted")), accent: rgba(cssVar("--signal")), lanes: ["--chat", "--image", "--voice", "--video"].map((v) => rgba(cssVar(v))) });
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      import(document.body.dataset.flowSrc).then((mod) => mod.mount(flowCanvas, { lib: document.body.dataset.tgpuSrc, colors })).then((scene) => {
        if (!scene) return;
        box.classList.add("flow-ready");
        onScheme(() => scene.setColors(colors()));
      }).catch(() => {});
    }, { rootMargin: "200px" });
    io.observe(flowCanvas);
  }

  // ---------------------------------------------------------------- playground
  const quoteForm = $("quoteForm");
  if (quoteForm) {
    const payConfig = (() => { const n = $("payConfig"); return n ? JSON.parse(n.textContent) : null; })();
    const MODELS = catalogData();
    const qModel = $("qModel"), out = $("quoteOut"), runOut = $("runOut");
    for (const modality of ["chat", "image", "voice", "video"]) {
      const group = el("optgroup", { label: modality[0].toUpperCase() + modality.slice(1) });
      for (const m of MODELS.filter((x) => x.modality === modality)) group.append(el("option", { value: m.slug, text: m.name + " (from " + m.from + ")" }));
      if (group.children.length) qModel.append(group);
    }
    const wanted = new URLSearchParams(location.search).get("model");
    if (wanted && MODELS.some((m) => m.slug === wanted)) qModel.value = wanted;
    const fill = (select, values, labeler = String) => { select.replaceChildren(...values.map((v) => el("option", { value: String(v), text: labeler(v) }))); };
    const current = () => MODELS.find((m) => m.slug === qModel.value) || MODELS[0];
    const bodyFor = (m) => {
      switch (m.modality) {
        case "chat": return { messages: [{ role: "user", content: $("qMessage").value }], max_tokens: Number($("qMaxTokens").value) };
        case "image": return { prompt: $("qPrompt").value, n: Number($("qN").value), size: $("qSize").value };
        case "voice": return m.voices ? { input: $("qInput").value, voice: $("qVoice").value } : { input: $("qInput").value };
        case "video": return { prompt: $("qVideoPrompt").value, duration: Number($("qDuration").value), aspect_ratio: $("qRatio").value };
      }
    };
    const method = { chat: "chat", image: "image", voice: "speech", video: "video" };
    const mcpTool = { chat: "moltworld_chat", image: "moltworld_image", voice: "moltworld_speech", video: "moltworld_video" };
    function renderSnippets() {
      const m = current(), body = bodyFor(m), json = JSON.stringify(body);
      const args = m.modality === "video" ? { model: m.slug, prompt: body.prompt, duration: body.duration, wait: true } : { model: m.slug, ...body };
      if ($("snipMcp")) {
        const isRobinhood = payConfig && payConfig.paymentChain === "robinhood";
        $("snipMcp").textContent = isRobinhood
          ? "// Local MCP setup (example; no call is simulated)\n// moltworld-mcp evm-keygen\n// key file: ~/.moltworld/robinhood-agent.key\n// MOLTWORLD_URL=" + ORIGIN + "\n// MOLTWORLD_MAX_PER_REQUEST_USD=0.25\n// MOLTWORLD_BUDGET_USD=5\n\nmoltworld_chat(" + JSON.stringify(args, null, 2) + ")"
          : "// Tool call through moltworld-mcp; it quotes, pays within your mandate and returns the result\n" + mcpTool[m.modality] + "(" + JSON.stringify(args, null, 2) + ")";
      }
      if ($("snipCurl")) {
        if (payConfig && payConfig.paymentChain === "robinhood") {
          const requestJson = JSON.stringify({ model: m.slug, ...body }).replace(/'/g, "'\\''");
          $("snipCurl").textContent = "curl -i -X POST '" + ORIGIN + m.endpoint + "' -H 'Content-Type: application/json' -d '" + requestJson + "'\n\n# A 402 response contains the exact WIF payment requirement. Use an EVM x402 client to authorize it.";
        } else {
          $("snipCurl").textContent = "curl -s " + ORIGIN + "/v1/quote -H 'Content-Type: application/json' \\\n  -d '" + JSON.stringify({ model: m.slug, ...body }).replace(/'/g, "'\\''") + "'\n\n# Pay with any x402 client that supports Algorand:\nPOST " + ORIGIN + m.endpoint;
        }
      }
      if ($("snipTs")) $("snipTs").textContent = payConfig && payConfig.paymentChain === "robinhood"
        ? 'import { MoltworldClient } from "moltworld-sdk";\n\n// evmSigner is an EIP-1193/viem-compatible Robinhood Chain signer.\nconst client = new MoltworldClient({ baseUrl: "' + ORIGIN + '", evmSigner, maxPerRequestUsd: 0.25, budgetUsd: 5 });\nconst res = await client.chat("' + m.slug + '", ' + JSON.stringify(body, null, 2) + ");\nconsole.log(res.data.choices[0].message.content);"
        : 'import { MoltworldClient } from "moltworld-sdk";\n\nconst client = new MoltworldClient({ mnemonic: process.env.ALGORAND_MNEMONIC, maxPerRequestUsd: 1 });\nconst res = await client.' + method[m.modality] + '("' + m.slug + '", ' + JSON.stringify(body, null, 2) + ");\nconsole.log(res.data, res.receipt?.txid);";
      if ($("snipPy")) $("snipPy").textContent = payConfig && payConfig.paymentChain === "robinhood"
        ? "import os\nfrom moltworld import MoltworldClient\n\nclient = MoltworldClient(evm_private_key=os.environ[\"MOLTWORLD_EVM_PRIVATE_KEY\"], base_url=\"" + ORIGIN + "\", max_per_request_usd=0.25, budget_usd=5)\nres = client.chat(\"" + m.slug + "\", " + json.replace(/true/g, "True").replace(/false/g, "False") + ")\nprint(res.data[\"choices\"][0][\"message\"][\"content\"])"
        : "from moltworld import MoltworldClient\n\nclient = MoltworldClient(mnemonic=\"...\", max_per_request_usd=1)\nres = client.call(\"" + m.endpoint + "\", " + json.replace(/true/g, "True").replace(/false/g, "False") + ")\nprint(res.data, res.receipt[\"txid\"])";
    }
    function syncForm() {
      const m = current();
      $$("[data-for]").forEach((n) => n.classList.toggle("hidden", n.dataset.for !== m.modality));
      if (m.modality === "chat") { $("qMaxTokens").max = m.maxOutput; $("qMaxNote").textContent = "(max " + m.maxOutput + ")"; if (Number($("qMaxTokens").value) > m.maxOutput) $("qMaxTokens").value = m.maxOutput; }
      if (m.modality === "image") { fill($("qN"), Array.from({ length: m.maxImages }, (_, i) => i + 1)); fill($("qSize"), m.sizes || ["1024x1024"]); }
      if (m.modality === "voice") { $("qVoiceWrap").classList.toggle("hidden", !m.voices); if (m.voices) fill($("qVoice"), m.voices); }
      if (m.modality === "video") { fill($("qDuration"), m.durations || [5], (d) => d + " s"); fill($("qRatio"), m.ratios || ["16:9"]); }
      renderSnippets();
    }
    // Every render bumps the sequence, so a slow response never overwrites newer output.
    let quoteSeq = 0, runSeq = 0, debounce = 0;
    const autoQuote = () => { clearTimeout(debounce); debounce = setTimeout(() => quote(false), 350); };
    qModel.addEventListener("change", syncForm);
    quoteForm.addEventListener("input", () => { renderSnippets(); autoQuote(); });
    quoteForm.addEventListener("change", () => { renderSnippets(); autoQuote(); });
    syncForm();

    async function quote(fromButton) {
      clearTimeout(debounce);
      const m = current(), btn = $("quoteBtn"), mine = ++quoteSeq;
      if (fromButton) { btn.disabled = true; out.replaceChildren(); }
      try {
        const { res, body } = await api("/v1/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.slug, ...bodyFor(m) }) });
        if (mine !== quoteSeq) return;
        if (!res.ok) { $("runPrice").textContent = ""; out.replaceChildren(errorBox((body && body.error && body.error.message) || "Quote failed")); return; }
        const q = body.quote, u = q.units;
        $("runPrice").textContent = q.formattedPrice;
        const units = [u.estimatedInputTokens && u.estimatedInputTokens + " input tokens (estimated)", u.maxOutputTokens && u.maxOutputTokens + " max output tokens", u.images && u.images + " image(s)", u.characters && u.characters + " characters", u.seconds && u.seconds + " seconds"].filter(Boolean).join(", ");
        out.replaceChildren(
          el("div", { class: "note", text: body.name + ": " + (body.payment_flow === "authorization" ? "charged after the answer" : "charged first, refunded if it fails") }),
          el("div", { class: "big-price", text: q.formattedPrice }),
          kv([["Payment amount", q.amountAtomic ? fmtTokenAtomic(q.amountAtomic, q.decimals, q.symbol) : undefined], ["Units", units], ["Upstream cost", "$" + q.upstreamCostUsd.toFixed(6) + " (" + q.costSource + ")"], ["Margin", q.marginPercent + "%"], ["Quoted USD micro-units", String(q.microUsdc)], ["Endpoint", "POST " + body.endpoint]])
        );
      } catch { if (mine === quoteSeq) out.replaceChildren(errorBox("Network error.")); } finally { btn.disabled = false; }
    }
    quoteForm.addEventListener("submit", (e) => { e.preventDefault(); quote(true); });
    quote(false);

    $("challengeBtn").addEventListener("click", async () => {
      clearTimeout(debounce);
      const m = current(), btn = $("challengeBtn"), mine = ++quoteSeq;
      btn.disabled = true;
      try {
        const res = await fetch(m.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyFor(m)) });
        if (mine !== quoteSeq) return;
        const header = res.headers.get("payment-required");
        if (res.status !== 402 || !header) {
          let msg = "HTTP " + res.status; try { const b = await res.json(); msg = (b.error && b.error.message) || msg; } catch {}
          out.replaceChildren(errorBox(msg)); return;
        }
        const required = JSON.parse(atob(header)), a = required.accepts[0];
        const isRobinhood = (networkInfo && networkInfo.payment_chain === "robinhood") || (payConfig && payConfig.paymentChain === "robinhood");
        const tokenAmount = isRobinhood
          ? fmtTokenAtomic(a.amount, (networkInfo && networkInfo.payment_decimals) || payConfig.paymentAssetDecimals, (networkInfo && networkInfo.payment_symbol) || payConfig.paymentAssetSymbol)
          : fmtMicro(a.amount);
        out.replaceChildren(
          el("div", { class: "note", text: "HTTP 402 Payment Required (x402 v" + required.x402Version + ")" }),
          el("div", { class: "big-price", text: tokenAmount }),
          kv([["Scheme", a.scheme], ["Network", a.network], ["Asset", a.asset], ["Quoted USD", a.extra && a.extra.quotedUsdMicro ? fmtMicro(a.extra.quotedUsdMicro) : undefined], ["Pay to", a.payTo], ["Flow", (a.extra && a.extra.paymentFlow) || "authorization"], ["Fee payer", a.extra && a.extra.feePayer]]),
          el("pre", { class: "code", style: "margin-top:16px" }, el("code", { text: JSON.stringify(required, null, 2) }))
        );
      } catch { if (mine === quoteSeq) out.replaceChildren(errorBox("Network error.")); } finally { btn.disabled = false; }
    });

    // -------------------------------------------------------------- paid runs (real x402 payments)
    let payMod = null, wallets = null, mandate = null, mandateKey = undefined, browserAgent = null, mode = "wallet";
    const loadPay = async () => (payMod ||= await import(document.body.dataset.paySrc));
    const short = (a) => a.slice(0, 6) + "..." + a.slice(-4);
    const cfg = () => ({ origin: ORIGIN, ...payConfig });

    // This browser acts as an agent with its own key, kept only here. Mandates bind to its address.
    const AGENT_STORE = "moltworld.agentKey";
    async function ensureBrowserAgent() {
      if (browserAgent) return browserAgent;
      const mod = await loadPay();
      let secret = null;
      try { secret = localStorage.getItem(AGENT_STORE); } catch {}
      try { browserAgent = secret ? mod.agentKeyFromSecret(secret) : null; } catch { browserAgent = null; }
      if (!browserAgent) {
        browserAgent = mod.generateAgentKey();
        try { localStorage.setItem(AGENT_STORE, browserAgent.secretKeyB64); } catch {}
      }
      $("agentAddr").textContent = "Agent " + short(browserAgent.address);
      $("agentAddr").title = browserAgent.address;
      $("agentCopy").dataset.copy = browserAgent.address;
      return browserAgent;
    }

    $$("[data-payer-mode]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.payerMode;
      $$("[data-payer-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $$(".payer-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== mode));
      if (mode === "mandate" && payConfig) ensureBrowserAgent().catch(() => {});
    }));

    async function refreshWallet() {
      const addr = wallets && wallets.address;
      $("walletList").classList.toggle("hidden", !!addr);
      $("walletActive").classList.toggle("hidden", !addr);
      if (!addr) return;
      $("walletAddr").textContent = short(addr);
      $("walletAddr").title = addr;
      $("walletBal").textContent = "";
      if (payConfig && payConfig.paymentChain === "robinhood") {
        const amount = await wallets.paymentBalanceAtomic();
        if (wallets.address === addr) $("walletBal").textContent = amount === null ? "WIF balance unavailable" : fmtTokenAtomic(amount, payConfig.paymentAssetDecimals, payConfig.paymentAssetSymbol);
      } else {
        const micro = await wallets.usdcBalanceMicro();
        if (wallets.address === addr) $("walletBal").textContent = micro === null ? "no USDC" : fmtMicro(micro) + " USDC";
      }
    }
    async function loadWallets() {
      if (wallets) return wallets;
      const list = $("walletList");
      list.replaceChildren(el("span", { class: "note", text: "Loading wallets" }));
      try {
        const mod = await loadPay();
        wallets = await mod.createWallets(cfg());
      } catch (err) { list.replaceChildren(errorBox("Wallets unavailable: " + (err && err.message))); throw err; }
      if (!wallets.options.length) {
        const message = payConfig && payConfig.reownProjectId
          ? "No compatible EVM wallet was detected. Open this page in a wallet browser or install a wallet extension."
          : "No browser wallet detected. Add a public Reown project ID for mobile wallet access, or open this page in a wallet browser/extension.";
        list.replaceChildren(el("span", { class: "note", text: message }));
        return wallets;
      }
      const renderWalletOptions = () => list.replaceChildren(...wallets.options.map((w) => {
        const b = el("button", { class: "btn btn-ghost btn-small wallet-btn", type: "button", "data-wallet": w.id });
        if (w.id === "walletconnect") b.title = "Choose MetaMask or another compatible wallet in the WalletConnect modal";
        if (w.icon) b.append(el("img", { src: w.icon, alt: "", width: "18", height: "18" }));
        b.append(w.name);
        b.addEventListener("click", async () => {
          b.disabled = true;
          try { await wallets.connect(w.id); await refreshWallet(); } catch (err) { toast((err && err.message) || "Wallet connection failed"); } finally { b.disabled = false; }
        });
        return b;
      }));
      wallets.onChange(() => refreshWallet());
      const metaMask = wallets.options.find((w) => w.id === "injected" && w.name === "MetaMask");
      if (metaMask) {
        list.replaceChildren(el("span", { class: "note", text: "MetaMask detected. Confirm the connection in the wallet." }));
        try {
          await wallets.connect(metaMask.id);
          await refreshWallet();
        } catch (err) {
          renderWalletOptions();
          toast((err && err.message) || "MetaMask connection was not approved.");
        }
        return wallets;
      }
      renderWalletOptions();
      await refreshWallet();
      return wallets;
    }
    if (payConfig) {
      loadPay().catch(() => {});
      $("walletLoad").addEventListener("click", () => loadWallets().catch(() => {}));
      $("walletOff").addEventListener("click", async () => { await wallets.disconnect(); await refreshWallet(); });
    }

    async function useMandate(text, agentSecret) {
      try {
        const mod = await loadPay();
        const credential = mod.parseMandate(text);
        const boundTo = mod.mandateAgent(credential);
        const key = agentSecret || (await ensureBrowserAgent()).secretKeyB64;
        if (boundTo && mod.agentKeyFromSecret(key).address !== boundTo) {
          throw new Error("This mandate is bound to agent " + short(boundTo) + ", not to this browser's agent.");
        }
        mod.checkMandate(credential, boundTo ? key : undefined);
        const id = mod.mandateId(credential);
        const { res, body } = await api("/v1/mandates/" + id);
        if (!res.ok) throw new Error("This mandate is not registered with the gateway.");
        const m = body.mandate;
        if (m.status !== "active") throw new Error("This mandate is " + m.status + ".");
        mandate = credential;
        mandateKey = boundTo ? key : undefined;
        $("mandateEntry").classList.add("hidden");
        $("mandateActive").classList.remove("hidden");
        $("mandateOwner").textContent = short(credential.owner);
        $("mandateOwner").title = credential.owner;
        $("mandateLimits").textContent = m.max_per_call + " per call · " + m.spent_24h + " of " + m.daily_cap + " today" + (m.on_chain_cap ? " · cap on-chain" : "");
      } catch (err) { toast((err && err.message) || "Invalid mandate"); }
    }
    if (payConfig && $("mandateUse")) {
      $("mandateUse").addEventListener("click", () => useMandate($("mandateCred").value));
      if ($("mandateDev")) $("mandateDev").addEventListener("click", () => useMandate(payConfig.devMandate, payConfig.devAgentKey));
      $("mandateOff").addEventListener("click", () => { mandate = null; mandateKey = undefined; $("mandateCred").value = ""; $("mandateEntry").classList.remove("hidden"); $("mandateActive").classList.add("hidden"); });
    }

    const showRunOutput = (...nodes) => {
      runOut.classList.remove("hidden");
      runOut.replaceChildren(...nodes);
    };
    const status = (text) => showRunOutput(el("div", { class: "run-status" }, el("span", { class: "spinner", "aria-hidden": "true" }), text));
    function renderResult(m, data) {
      const box = el("div", { class: "run-result" });
      if (m.modality === "chat") box.append(el("div", { class: "answer-text", text: data.choices && data.choices[0] ? data.choices[0].message.content : JSON.stringify(data) }));
      else if (m.modality === "image") box.append(el("div", { class: "image-grid" }, ...(data.data || []).map((d) => el("img", { src: d.url || ("data:image/png;base64," + d.b64_json), alt: "Generated image", loading: "lazy" }))));
      else if (m.modality === "voice") box.append(el("audio", { controls: "", src: "data:" + (data.mime_type || "audio/mpeg") + ";base64," + data.audio_b64 }));
      else box.append(el("div", { class: "note", text: "Video job " + data.id + ": " + data.status }));
      return box;
    }
    function renderReceipt(r) {
      const v = r.verification, rc = r.receipt;
      const ok = !!(v && v.ok);
      return el("div", { class: "run-receipt" },
        el("p", {}, el("span", { class: "badge " + (ok ? "good" : "bad"), text: ok ? "Receipt valid" : "Receipt invalid" }), r.replayed ? " replayed" : ""),
        kv([["Paid", rc && rc.amountAtomic ? fmtTokenAtomic(rc.amountAtomic, rc.assetDecimals, rc.assetSymbol) : fmtMicro(r.paidMicro)], ["USD quote", rc && rc.quotedUsdMicro ? fmtMicro(rc.quotedUsdMicro) : undefined], ["Rebate", rc && rc.rebateMicro ? fmtMicro(rc.rebateMicro) : undefined], ["Payer", rc && rc.payer], ["Transaction", rc ? txLink(rc.txid) : undefined], ["Upstream", rc ? (rc.upstreamProvider || "") + " / " + (rc.upstreamModel || "") : undefined], ["Signature", v ? String(v.signatureValid) : undefined], ["Request hash", v ? String(v.requestMatches) : undefined], ["Response hash", v ? String(v.responseMatches) : undefined], ["Request", r.requestId]]));
    }

    $("runBtn").addEventListener("click", async () => {
      if (!payConfig || !document.body.dataset.paySrc) { showRunOutput(errorBox("Paid runs are unavailable on this deployment.")); return; }
      const m = current(), btn = $("runBtn"), mine = ++runSeq, cap = Number($("capInput").value) || 1;
      clearTimeout(debounce);
      let payer;
      if (mode === "mandate") {
        if (!mandate) { $("mandateCred").focus(); showRunOutput(errorBox("Add a mandate credential to pay.")); return; }
        payer = { mandate, agentKey: mandateKey };
      } else {
        if (!wallets || !wallets.address) { await loadWallets().catch(() => {}); showRunOutput(errorBox("Connect a wallet to pay.")); return; }
        const signer = wallets.signer();
        if (payConfig.paymentChain === "robinhood") {
          payer = {
            evmSigner: signer,
            ensureEvmAllowance: async ({ asset, amount }) => wallets.ensureEvmAllowance(asset, amount, (message) => { if (mine === runSeq) status(message); }),
          };
        } else {
          payer = { signer: { address: signer.address, signTransactions: async (txns, idx) => { if (mine === runSeq) status("Approve the payment in your wallet"); const signed = await signer.signTransactions(txns, idx); if (mine === runSeq) status("Settling on Algorand"); return signed; } } };
        }
      }
      btn.disabled = true;
      status(mode === "mandate" ? "Paying under the mandate" : payConfig.paymentChain === "robinhood" ? "Preparing x402 payment in WIF" : "Preparing the payment");
      try {
        const mod = await loadPay();
        const client = mod.createClient(cfg(), payer, cap);
        const result = await client.call(m.endpoint, bodyFor(m));
        if (mine !== runSeq) return;
        showRunOutput(renderResult(m, result.data), renderReceipt(result));
        if (m.modality === "video" && result.data && result.data.id) {
          const job = await client.waitForJob(result.data.id, { intervalMs: 3000 });
          if (mine !== runSeq) return;
          const slot = runOut.querySelector(".run-result");
          slot.replaceChildren(job.status === "completed" ? el("video", { controls: "", src: job.video_url }) : errorBox("Video failed" + (job.refund ? "; refund " + job.refund.status : "")));
        }
        if (mode === "wallet") refreshWallet();
        if (mode === "mandate") useMandate(JSON.stringify(mandate), mandateKey);
      } catch (err) {
        const msg = (err && err.message) || "Payment failed";
        if (mine === runSeq) showRunOutput(errorBox(/maxAmountPerPayment/.test(msg) ? "Costs more than your max per request ($" + cap + ")." : msg));
      } finally { btn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------- catalog
  const modelList = $("modelList");
  if (modelList) {
    const cards = $$(".model", modelList);
    const PAGE = Number(modelList.dataset.page || 12);
    const wantedType = new URLSearchParams(location.search).get("type");
    let filter = $$("[data-filter]").some((b) => b.dataset.filter === wantedType) ? wantedType : "all", query = "", limit = PAGE;
    $$("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.filter === filter)));
    function renderCatalog() {
      const matches = cards.filter((c) => (filter === "all" || c.dataset.modality === filter) && (!query || c.dataset.search.includes(query)));
      cards.forEach((c) => c.classList.add("hidden"));
      matches.slice(0, limit).forEach((c) => c.classList.remove("hidden"));
      $("noModels").classList.toggle("hidden", matches.length > 0);
      $("moreBtn").parentElement.classList.toggle("hidden", matches.length <= limit);
      $("moreBtn").textContent = "Show more (" + (matches.length - limit) + ")";
    }
    $$("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      $$("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      filter = b.dataset.filter; limit = PAGE; renderCatalog();
      const url = new URL(location.href);
      if (filter === "all") url.searchParams.delete("type"); else url.searchParams.set("type", filter);
      history.replaceState(null, "", url);
    }));
    $("search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); limit = PAGE; renderCatalog(); });
    $("moreBtn").addEventListener("click", () => { limit += PAGE * 2; renderCatalog(); });
    renderCatalog();
  }

  // ---------------------------------------------------------------- mandates
  const mandateForm = $("mandateForm");
  if (mandateForm) {
    mandateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("mandateQuery").value.trim(), target = $("mandateOut");
      if (!isAddress(q)) { target.replaceChildren(errorBox("Enter a 58-character Algorand address.")); return; }
      let { res, body } = await api("/v1/mandates?owner=" + q);
      let list = res.ok && body.data.length ? body.data : null;
      if (!list) { ({ res, body } = await api("/v1/mandates/" + q)); list = res.ok ? [body.mandate] : null; }
      if (!list || !list.length) { target.replaceChildren(el("p", { class: "note", text: "No mandates found for this id or owner." })); return; }
      target.replaceChildren(...list.map((m) => el("div", { class: "card", style: "margin-top:10px" },
        el("strong", { text: m.label + " " }), el("span", { class: "badge " + (m.status === "active" ? "good" : "bad"), text: m.status }),
        kv([["Id", m.id], ["Owner", m.owner], ["Per call", m.max_per_call], ["Daily cap", m.daily_cap], ["Spent (24h)", m.spent_24h], ["Models", m.allowed_models ? m.allowed_models.join(", ") : "any"], ["Expires at round", String(m.expiry_round)]]))));
    });
  }

  // ---------------------------------------------------------------- marketplace
  const marketOut = $("marketOut");
  if (marketOut) {
    api("/v1/market").then(({ res, body }) => {
      if (!res.ok) { marketOut.replaceChildren(errorBox("Could not load listings.")); return; }
      if (!body.data.length) { marketOut.replaceChildren(el("p", { class: "note", text: "No live listings yet." })); return; }
      marketOut.replaceChildren(...body.data.map((l) => el("div", { class: "card", style: "margin-top:12px;padding:18px" },
        el("div", { class: "model-top" }, el("strong", { text: l.name }), el("span", { class: "price", text: l.price })),
        el("p", { class: "note", style: "margin:6px 0 10px", text: l.description }),
        el("code", { class: "endpoint", text: "POST " + l.endpoint }))));
    }).catch(() => marketOut.replaceChildren(errorBox("Could not load listings.")));
  }
  const earnForm = $("earnForm");
  if (earnForm) {
    earnForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const addr = $("earnAddr").value.trim(), target = $("earnOut");
      if (!isAddress(addr)) { target.replaceChildren(errorBox("Enter a 58-character Algorand address.")); return; }
      const { res, body } = await api("/v1/market/creators/" + addr + "/earnings");
      if (!res.ok) { target.replaceChildren(errorBox((body && body.error && body.error.message) || "Lookup failed")); return; }
      target.replaceChildren(kv([["Paid calls", String(body.paid_calls)], ["Unpaid", body.unpaid], ["Paid out", body.paid_out], ["Payout threshold", body.payout_threshold]]));
    });
  }

  // ---------------------------------------------------------------- receipts
  const receiptForm = $("receiptForm");
  if (receiptForm) {
    let keysPromise = null;
    const keys = () => (keysPromise ||= api("/.well-known/moltworld-receipts.json").then(({ body }) => body.keys));
    const canonical = (v) => {
      if (v === null || typeof v !== "object") return JSON.stringify(v);
      if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
      return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    };
    const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
    async function verifyLocally(receipt) {
      const key = (await keys()).find((k) => k.kid === receipt.kid);
      if (!key) return { ok: false, why: "Unknown signing key " + receipt.kid };
      try {
        const pub = await crypto.subtle.importKey("raw", b64(key.publicKey), { name: "Ed25519" }, false, ["verify"]);
        const { sig, ...payload } = receipt;
        const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, b64(sig), new TextEncoder().encode(canonical(payload)));
        return { ok, why: ok ? "Signature valid (checked in your browser)" : "Signature does not match" };
      } catch { return { ok: null, why: "This browser can't verify Ed25519 signatures, so the gateway's check is shown instead." }; }
    }
    receiptForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = $("receiptInput").value.trim(), target = $("receiptOut");
      if (!raw) return;
      let receipt = null, server = null;
      if (raw.startsWith("{")) { try { receipt = JSON.parse(raw); } catch { target.replaceChildren(errorBox("That is not valid JSON.")); return; } }
      else if (/^req_[A-Za-z0-9_-]+$/.test(raw)) {
        const { res, body } = await api("/v1/receipts/" + raw);
        if (!res.ok) { target.replaceChildren(errorBox((body && body.error && body.error.message) || "Not found")); return; }
        server = body; receipt = body.receipt;
      } else { target.replaceChildren(errorBox("Enter a request id (req_...) or receipt JSON.")); return; }
      if (!receipt) { target.replaceChildren(kv([["Status", server.status], ["Note", "No receipt: the request was not completed."]])); return; }
      const local = await verifyLocally(receipt);
      const verdict = local.ok === null ? (server && server.signature_valid) : local.ok;
      target.replaceChildren(
        el("p", {}, el("span", { class: "badge " + (verdict ? "good" : "bad"), text: verdict ? "Valid" : "Invalid" }), " " + local.why),
        kv([["Request", receipt.id], ["Status", server ? server.status : undefined], ["Model", receipt.model], ["Upstream", (receipt.upstreamProvider || "") + " / " + (receipt.upstreamModel || "")], ["Paid", fmtMicro(receipt.amountMicro)], ["Rebate", receipt.rebateMicro ? fmtMicro(receipt.rebateMicro) : undefined], ["Payer", receipt.payer], ["Transaction", txLink(receipt.txid)], ["Refund", server && server.refund ? server.refund.status + (server.refund.txid ? ", " + server.refund.txid : "") : undefined], ["Request sha256", receipt.requestSha256], ["Response sha256", receipt.responseSha256], ["Key id", receipt.kid]])
      );
    });
  }

  // ---------------------------------------------------------------- usage
  if ($("sPaid") || $("recentRows")) {
    const set = (id, v, animate) => { const n = $(id); if (!n) return; if (animate) countTo(n, String(v)); else n.textContent = v; };
    const fmtUsd = (raw) => {
      if (!raw || raw === "-") return "-";
      const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
      if (isNaN(num)) return String(raw);
      if (num === 0) return "$0.00";
      const digits = Math.abs(num) >= 1 ? 2 : 6;
      return "$" + num.toLocaleString(undefined, { minimumFractionDigits: Math.abs(num) >= 1 ? 2 : 0, maximumFractionDigits: digits });
    };
    const num = (v) => (typeof v === "number" ? v.toLocaleString() : v);

    const usd = (v, digits = 2) => "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const TYPE_LABEL = { chat: "Chat", image: "Image", voice: "Voice", video: "Video", market: "Marketplace", other: "Other" };
    let endpointFilter = "all";

    const renderEndpoints = (endpoints) => {
      const body = $("topModelRows"), bar = $("endpointFilters");
      if (!body) return;
      const types = ["all", ...Object.keys(TYPE_LABEL).filter((t) => endpoints.some((e) => e.modality === t))];
      if (bar && types.length > 2) {
        bar.hidden = false;
        bar.replaceChildren(...types.map((t) => {
          const n = t === "all" ? endpoints.length : endpoints.filter((e) => e.modality === t).length;
          const b = el("button", { class: "tab", type: "button", "aria-pressed": String(t === endpointFilter), text: (t === "all" ? "All" : TYPE_LABEL[t]) + " (" + n + ")" });
          b.addEventListener("click", () => { endpointFilter = t; renderEndpoints(endpoints); });
          return b;
        }));
      }
      const rows = endpoints.filter((e) => endpointFilter === "all" || e.modality === endpointFilter);
      body.replaceChildren(...rows.map((e) => el("tr", {},
        el("td", { "data-label": "Model", text: e.model }),
        el("td", { "data-label": "Type", text: TYPE_LABEL[e.modality] || e.modality }),
        el("td", { "data-label": "Settles", text: Number(e.settles).toLocaleString() }),
        el("td", { "data-label": "Volume", text: usd(e.volume_usdc) }),
        el("td", { "data-label": "Price", text: "$" + e.price_usdc }))));
    };

    const renderFacilitator = (f) => {
      if (f.success_rate != null) set("sSuccessRate", f.success_rate + "%");
      if (f.avg_settle_ms != null) set("sAvgLatency", f.avg_settle_ms + " ms");
      if (f.avg_ticket_usd != null) set("sAvgTicket", usd(f.avg_ticket_usd));

      const nets = f.networks || [], total = nets.reduce((a, n) => a + n.volume_usdc, 0) || 1, netBody = $("networkRows");
      if (netBody) netBody.replaceChildren(...nets.map((n) => el("tr", {},
        el("td", { "data-label": "Network", text: n.name + (n.testnet ? " (testnet)" : "") }),
        el("td", { "data-label": "Settles", text: Number(n.settles).toLocaleString() }),
        el("td", { "data-label": "Volume", text: usd(n.volume_usdc) }),
        el("td", { "data-label": "Share" }, el("span", { class: "share" }, el("i", { style: "width:" + Math.round((n.volume_usdc / total) * 100) + "%" })), Math.round((n.volume_usdc / total) * 100) + "%"))));

      renderEndpoints(f.endpoints || []);

      const list = $("listingList");
      if (list) {
        const rows = [["Bazaar", f.listed && f.listed.bazaar ? "Listed" : "Not listed"], ["402 challenge", f.listed && f.listed.challenge ? "Verified" : "Not verified"], ["Merchant", f.merchant_id]];
        for (const a of f.accounts || []) rows.push([a.network, a.address]);
        list.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { class: String(v).length > 30 ? "mono" : "", text: v })]));
      }
      for (const id of ["facilitatorOnly", "listingOnly"]) { const n = $(id); if (n) n.hidden = false; }
    };

    // The server serves its last good facilitator answer and refreshes in the background, so a cold
    // start can come back empty once; ask again before giving up.
    const load = (attempt) => api("/v1/stats").then(({ res, body }) => {
      if (!res.ok) return;
      const s = body.metrics;
      set("sPaid", num(s.paid_requests), true);
      set("sGross", fmtUsd(s.gross_usd_quote)); set("sRebated", fmtUsd(s.rebated_usd_quote)); set("sNet", fmtUsd(s.net_revenue_usd_quote ?? s.net_revenue_usdc), true);
      set("sRefunds", body.payment_chain === "robinhood" ? num(s.pending_refund_reviews) : fmtUsd(s.refunded_usd_quote ?? s.refunded_usdc), true);

      if (body.payment_chain === "robinhood") {
        if (s.success_rate != null) set("sSuccessRate", Number(s.success_rate).toFixed(2) + "%", true);
        if (s.avg_settle_ms != null) set("sAvgLatency", num(s.avg_settle_ms) + " ms");
        else set("sAvgLatency", "—");
        if (s.avg_ticket_usd_quote != null) set("sAvgTicket", fmtUsd(s.avg_ticket_usd_quote), true);
        else set("sAvgTicket", "—");
        const completed = Number(s.completed_requests || 0);
        const quoteVolume = fmtUsd(s.gross_usd_quote);
        set("networkSettles", num(completed));
        set("networkVolume", quoteVolume);
        set("networkShare", completed > 0 ? "100%" : "0%");
        const chatSettles = Number((s.completed_by_modality && s.completed_by_modality.chat) ?? completed);
        const endpointBody = $("topModelRows");
        if (endpointBody) endpointBody.replaceChildren(el("tr", {},
          el("td", { "data-label": "Endpoint group", text: "All eligible chat models" }),
          el("td", { "data-label": "Type", text: "Chat" }),
          el("td", { "data-label": "Settles", text: num(chatSettles) }),
          el("td", { "data-label": "Quoted volume", text: quoteVolume }),
          el("td", { "data-label": "Price detail", text: "Per-model split unavailable" })));
      } else if (body.facilitator) renderFacilitator(body.facilitator);
      else if (attempt < 2) setTimeout(() => load(attempt + 1), 2500);
      else { const t = $("topModelRows"); if (t) t.replaceChildren(el("tr", {}, el("td", { colspan: "5", text: "Facilitator figures are unavailable right now." }))); }

      const tbody = $("recentRows");
      if (!tbody) return;
      const rows = body.recent_settlements.map((r) => el("tr", {},
        el("td", { "data-label": "When", text: new Date(r.at).toLocaleString() }),
        el("td", { "data-label": "Model", text: r.model || r.modality || "market" }),
        el("td", { "data-label": "Amount", text: r.amount }),
        el("td", { "data-label": "Transaction", class: "mono" }, r.txid ? txLink(r.txid) : "-")));
      tbody.replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: "4", text: "No settlements yet." }))]));
    }).catch(() => {});
    load(0);
  }

  const mandateRoot = document.querySelector("[data-wif-mandate-root]");
  const marketRoot = document.querySelector("[data-wif-market-root]");
  if (marketRoot && document.body.dataset.marketSrc) {
    import(document.body.dataset.marketSrc).then(mod => mod.mountWifMarketplace(marketRoot)).catch(error => {
      marketRoot.querySelector("[data-market-status]").textContent = "Marketplace could not load: " + (error?.message || String(error));
    });
  }
  if (mandateRoot && document.body.dataset.mandateSrc) {
    import(document.body.dataset.mandateSrc)
      .then((mod) => mod.mountWifMandateSetup(mandateRoot))
      .catch((error) => {
        const status = mandateRoot.querySelector("[data-mandate-status]");
        if (status) status.textContent = "Mandate setup module failed to load: " + (error?.message || String(error));
      });
  }
})();
`;
