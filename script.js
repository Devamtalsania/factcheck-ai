/* ============================================================
   FactBot AI — Frontend engine
   JavaScript port of the original Python Wikipedia fact-checker,
   so the site runs 100% in the browser (GitHub Pages friendly).
   ============================================================ */

const STOPWORDS = new Set([
  "the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","a","an","and","but","if","or","because","as","until",
  "while","of","at","by","for","with","about","against","between","into",
  "through","during","before","after","above","below","to","from","up",
  "down","in","out","on","off","over","under","again","that","this",
  "these","those","very","just","only","also","actually"
]);
const GENERIC_TITLE_WORDS = new Set(["group","company","inc","corporation","limited","the","of","and"]);
const PRONOUNS = new Set(["my","your","his","her","our","their","i","we","you"]);
const MAX_WORDS = 3000;

const SAMPLE_TEXT = "The Eiffel Tower is located in Paris, France. The Eiffel Tower is 330 metres tall. The Great Wall of China is visible from space with the naked eye. My cat is very cute. The Earth is flat. Albert Einstein developed the theory of relativity. The Sahara is the largest desert in the world.";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function firstSentences(text, n) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, n).join(" ");
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

/* ---------- Word count ---------- */
function updateWordCount() {
  const text = $("inputText").value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const el = $("wordCount");
  el.textContent = `Words: ${words.toLocaleString()} / ${MAX_WORDS.toLocaleString()}`;
  el.classList.toggle("over", words > MAX_WORDS);
  $("checkBtn").disabled = words === 0 || words > MAX_WORDS;
}

/* ---------- Wikipedia helpers ---------- */
async function fetchJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- Core: verify one statement (port of verify_single_statement) ---------- */
async function verifySingleStatement(sentence) {
  const clean = sentence.trim();
  const words = clean.toLowerCase().match(/\w+/g) || [];

  if (words.length < 4) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Too short to be a verifiable claim." };
  }
  if (PRONOUNS.has(words[0])) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Personal or vague statement, not an encyclopedic fact." };
  }

  try {
    // 1. Search Wikipedia for the main topic
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&origin=*" +
      "&search=" + encodeURIComponent(clean);
    const searchData = await fetchJSON(searchUrl);
    if (!searchData[1] || searchData[1].length === 0) {
      return { statement: clean, status: "NOT_WORTHY", reason: "No recognizable encyclopedic subject found." };
    }
    const mainSubject = searchData[1][0];

    // 2. Subject words must actually appear in the user's sentence
    const subjectWords = new Set(
      (mainSubject.toLowerCase().match(/\w+/g) || []).filter((w) => w.length >= 3 && !GENERIC_TITLE_WORDS.has(w))
    );
    const wordSet = new Set(words);
    if (![...subjectWords].every((w) => wordSet.has(w))) {
      return { statement: clean, status: "NOT_WORTHY", reason: "Statement lacks a clear, specific subject to fact-check." };
    }

    // 3. Extract the user's claim words
    const claimWords = new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !subjectWords.has(w)));
    if (claimWords.size === 0) {
      return { statement: clean, status: "NOT_WORTHY", reason: "No specific factual claim detected about the subject." };
    }

    // 4. Fetch real facts (Wikipedia summary, first 3 sentences)
    const summaryUrl =
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(mainSubject.replace(/ /g, "_"));
    const summary = await fetchJSON(summaryUrl);
    if (summary.type === "disambiguation" || !summary.extract) {
      return { statement: clean, status: "NOT_WORTHY", reason: "Subject is too ambiguous or does not exist in the database." };
    }

    const realFacts = firstSentences(summary.extract, 3);
    const realWords = new Set(realFacts.toLowerCase().match(/\w+/g) || []);
    const matching = [...claimWords].filter((w) => realWords.has(w));
    const accuracy = matching.length / claimWords.size;

    if (accuracy >= 0.35) {
      return { statement: clean, status: "TRUE", subject: mainSubject };
    }
    return { statement: clean, status: "FALSE", subject: mainSubject, correct_info: realFacts };
  } catch (err) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Could not reach Wikipedia (network error). Please try again." };
  }
}

/* ---------- CSV parsing (port of process_csv_file) ---------- */
function parseCSV(text) {
  const cells = [];
  let cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === "," || c === "\n") { cells.push(cell); cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  cells.push(cell);
  return cells.map((s) => s.trim()).filter(Boolean);
}

/* ---------- File handling ---------- */
function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || "");
    if (file.name.toLowerCase().endsWith(".csv")) {
      const cells = parseCSV(text);
      text = cells.join(". ");
      toast(`Loaded ${cells.length} statements from ${file.name}`);
    } else {
      toast(`Loaded ${file.name}`);
    }
    $("inputText").value = text;
    updateWordCount();
    $("inputText").focus();
  };
  reader.readAsText(file);
}

/* ---------- Analysis (port of analyze_text_or_list) ---------- */
async function runCheck() {
  const raw = $("inputText").value.trim();
  if (!raw) return;

  const sentences = raw.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) { toast("No statements found in your input."); return; }

  const btn = $("checkBtn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  $("progressWrap").hidden = false;
  $("results").hidden = true;

  const results = [];
  for (let i = 0; i < sentences.length; i++) {
    $("progressFill").style.width = Math.round(((i + 1) / sentences.length) * 100) + "%";
    $("progressText").textContent = `Checking statement ${i + 1} of ${sentences.length}…`;
    results.push(await verifySingleStatement(sentences[i]));
    await sleep(120); // be gentle with the Wikipedia API
  }

  $("progressWrap").hidden = true;
  btn.disabled = false;
  btn.textContent = "Fact Check";
  renderReport(results);
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- Report rendering (port of print_report) ---------- */
function countUp(el, target, dur = 900) {
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = (Math.round(target * p * 10) / 10) + "%";
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

let lastResults = [];

function renderReport(results) {
  lastResults = results;
  const trueItems = results.filter((r) => r.status === "TRUE");
  const falseItems = results.filter((r) => r.status === "FALSE");
  const skipItems = results.filter((r) => r.status === "NOT_WORTHY");
  const total = trueItems.length + falseItems.length;
  const pct = total ? Math.round((trueItems.length / total) * 1000) / 10 : 0;

  $("results").hidden = false;

  // Truth score ring
  const C = 2 * Math.PI * 52;
  const ring = $("ringFg");
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C;
  ring.style.stroke = pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--red)";
  requestAnimationFrame(() => {
    ring.style.transition = "stroke-dashoffset 1s ease";
    ring.style.strokeDashoffset = C * (1 - pct / 100);
  });
  countUp($("scorePct"), pct);

  $("scoreTitle").textContent =
    total === 0 ? "No fact-check-worthy statements"
    : pct >= 70 ? "Mostly accurate!"
    : pct >= 40 ? "Mixed accuracy"
    : "Mostly inaccurate";

  $("scoreSub").textContent =
    total === 0
      ? "This input does not contain any fact-check-worthy statements. Try a longer, more specific statement about a real topic."
      : `${trueItems.length} of ${total} verifiable claims checked out as true against Wikipedia.`;

  $("chipTrue").textContent = `✓ ${trueItems.length} True`;
  $("chipFalse").textContent = `✗ ${falseItems.length} False`;
  $("chipSkip").textContent = `– ${skipItems.length} Skipped`;

  // False claims with corrections
  $("falseList").innerHTML = falseItems.length
    ? `<h3 class="list-title">✗ False claims &amp; corrections <span class="count">(${falseItems.length})</span></h3>` +
      falseItems.map((item) => `
        <article class="claim-card false-card">
          <div class="claim-head">
            <span class="badge false-badge">FALSE</span>
            <span class="claim-subject">Subject: ${escapeHtml(item.subject)}</span>
          </div>
          <p class="claim-text">“${escapeHtml(item.statement)}”</p>
          <div class="correct"><span>Correct info</span><p>${escapeHtml(item.correct_info)}</p></div>
          <a class="source" href="https://en.wikipedia.org/wiki/${encodeURIComponent(item.subject.replace(/ /g, "_"))}" target="_blank" rel="noopener">Source: Wikipedia ↗</a>
        </article>`).join("")
    : "";

  // True claims
  $("trueList").innerHTML = trueItems.length
    ? `<h3 class="list-title">✓ Verified true <span class="count">(${trueItems.length})</span></h3>` +
      trueItems.map((item) => `
        <div class="true-row">
          <span class="icon">✓</span>
          <p>“${escapeHtml(item.statement)}”</p>
        </div>`).join("")
    : "";

  // Skipped statements
  $("skipList").innerHTML = skipItems.length
    ? `<h3 class="list-title">– Skipped (not fact-check worthy) <span class="count">(${skipItems.length})</span></h3>` +
      skipItems.map((item) => `
        <div class="skip-row">
          <span class="icon">–</span>
          <p>“${escapeHtml(item.statement)}”<span class="reason">${escapeHtml(item.reason)}</span></p>
        </div>`).join("")
    : "";
}

/* ---------- Copy report ---------- */
function copyReport() {
  if (!lastResults.length) return;
  const trueItems = lastResults.filter((r) => r.status === "TRUE");
  const falseItems = lastResults.filter((r) => r.status === "FALSE");
  const skipItems = lastResults.filter((r) => r.status === "NOT_WORTHY");
  const total = trueItems.length + falseItems.length;
  const pct = total ? (trueItems.length / total * 100).toFixed(1) : "0.0";

  let out = `FactBot AI Report\nTruth Score: ${pct}% (${trueItems.length} True, ${falseItems.length} False, ${skipItems.length} Skipped)\n`;
  if (falseItems.length) {
    out += "\nFalse claims & corrections:\n";
    falseItems.forEach((f, i) => {
      out += `\n${i + 1}. FALSE: "${f.statement}"\n   Correct info (${f.subject}): ${f.correct_info}\n`;
    });
  }
  if (trueItems.length) {
    out += "\nVerified true:\n";
    trueItems.forEach((t) => { out += `• "${t.statement}"\n`; });
  }
  if (skipItems.length) {
    out += "\nSkipped:\n";
    skipItems.forEach((s) => { out += `• "${s.statement}" — ${s.reason}\n`; });
  }

  navigator.clipboard.writeText(out)
    .then(() => toast("Report copied to clipboard"))
    .catch(() => toast("Could not copy — clipboard blocked by browser"));
}

/* ---------- Wire up UI ---------- */
$("inputText").addEventListener("input", updateWordCount);

$("inputText").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runCheck();
});

$("sampleBtn").addEventListener("click", () => {
  $("inputText").value = SAMPLE_TEXT;
  updateWordCount();
  $("inputText").focus();
  toast("Sample loaded — hit Fact Check!");
});

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("inputText").value = text;
      updateWordCount();
      toast("Pasted from clipboard");
    } else {
      toast("Clipboard is empty");
    }
  } catch {
    toast("Clipboard blocked — press Ctrl+V in the text box instead");
    $("inputText").focus();
  }
});

$("uploadBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => handleFile(e.target.files[0]));

$("checkBtn").addEventListener("click", runCheck);
$("copyBtn").addEventListener("click", copyReport);

/* Drag & drop file onto the card */
const card = $("checker");
["dragenter", "dragover"].forEach((ev) =>
  card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.remove("drag"); })
);
card.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

/* Terms modal */
$("termsLink").addEventListener("click", (e) => { e.preventDefault(); $("termsModal").hidden = false; });
$("termsClose").addEventListener("click", () => { $("termsModal").hidden = true; });
$("termsModal").addEventListener("click", (e) => { if (e.target === $("termsModal")) $("termsModal").hidden = true; });

updateWordCount();
