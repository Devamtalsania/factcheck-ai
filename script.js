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
// Words at the start of a sentence that usually hold its real subject.
const LEAD_WORDS = 5;
const PRONOUNS = new Set(["my","your","his","her","our","their","i","we","you"]);
const MAX_WORDS = 3000;

const SAMPLE_TEXT = "The Eiffel Tower is located in Paris, France. The Eiffel Tower is 330 metres tall. The Great Wall of China is visible from space with the naked eye. Dhyan is the president of India. My cat is very cute. The Earth is flat. Albert Einstein developed the theory of relativity. The Sahara is the largest desert in the world.";

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
async function fetchJSON(url, timeoutMs = 20000) {
  // Wikipedia sometimes answers with a plain-text "too many requests" page
  // instead of JSON, so retry with a growing delay before giving up.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.text();
      if (!body.trim().startsWith("{") && !body.trim().startsWith("[")) {
        throw new Error("Rate limited");
      }
      return JSON.parse(body);
    } catch (err) {
      lastErr = err;
      await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/* ---------- Simple stemmer (handles plurals: presidents -> president) ---------- */
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/* ---------- Polite request queue: Wikipedia asks for slow, spaced-out requests ---------- */
let lastRequestAt = 0;
async function throttledFetchJSON(url) {
  const wait = Math.max(0, lastRequestAt + 600 - Date.now());
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
  return fetchJSON(url);
}

/* ---------- Wikipedia full-text search (same API the Python wikipedia library uses) ---------- */
async function searchWikipedia(query) {
  // Wikipedia caps search queries at 300 characters; long report sentences must
  // be trimmed or the request fails outright.
  const q = query.length > 280 ? query.slice(0, 280) : query;
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&origin=*" +
    "&srsearch=" + encodeURIComponent(q);
  const data = await throttledFetchJSON(url);
  return (data.query && data.query.search || []).map((r) => r.title);
}

/* ---------- Full article text (cached per title; null for disambiguation/missing pages) ---------- */
const articleCache = new Map();
async function fetchArticleText(title) {
  if (articleCache.has(title)) return articleCache.get(title);
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&explaintext=1&format=json&origin=*" +
    "&titles=" + encodeURIComponent(title);
  const data = await throttledFetchJSON(url);
  const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
  let text = null;
  if (pages.length && pages[0].extract && !(pages[0].pageprops && pages[0].pageprops.disambiguation !== undefined)) {
    text = deaccent(stripAppendix(pages[0].extract));
  }
  articleCache.set(title, text);
  return text;
}

/* ---------- Accent-insensitive matching ("Société" == "societe") ---------- */
function deaccent(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* ---------- Drop reference/appendix sections ----------
   Citations repeat words like "London" for unrelated books and papers, which
   would otherwise make a wrong claim look supported. Only prose is checked. */
const APPENDIX_HEADING = /^(references|notes|citations|sources|bibliography|further reading|external links|see also|footnotes)\b/i;
function stripAppendix(text) {
  const lines = text.split(/\n/);
  const out = [];
  for (const line of lines) {
    if (APPENDIX_HEADING.test(line.replace(/^=+\s*|\s*=+$/g, "").trim())) break;
    out.push(line);
  }
  return out.join("\n");
}

/* ---------- Sentence helpers ---------- */
function splitSentences(text) {
  // Headings/lines are their own units: "The Eiffel Tower: History" and
  // "The Eiffel Tower is a lattice tower." must not be glued together.
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Sentences that discuss myths/debunkings rather than stating facts — excluded
// from verification so e.g. "visible from space" myths don't count as true.
const MYTH_MARKERS = /\b(claim|claims|claimed|myth|myths|factoid|factoids|cannot|debunk|allegedly|supposedly|falsely|testifying)\b|popular culture/i;

/* ---------- Score a claim against the full article ----------
   best    = how many of the claim's words appear together in a single prose
             sentence (the strongest evidence for the claim)
   absent  = claim words the article never uses at all
   numbers = claim numbers the article never states
   A false claim leaves a proper noun or figure unmatched ("London", "1,665"). */
function claimDigits(text) {
  return (text.match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]/g, ""));
}

function claimSupport(claimWords, articleText, claimNumbers = [], nameWords = []) {
  const claimArr = [...claimWords];
  const sents = splitSentences(articleText);
  let best = 0;
  const nameBest = new Map(nameWords.map((n) => [n, 0]));
  sents.forEach((s, i) => {
    if (MYTH_MARKERS.test(s)) return;
    const sWords = new Set(s.toLowerCase().match(/\w+/g) || []);
    const overlap = claimArr.filter((w) => sWords.has(w)).length;
    if (overlap > best) best = overlap;
    for (const n of nameWords) {
      if (sWords.has(n) && overlap > (nameBest.get(n) || 0)) nameBest.set(n, overlap);
    }
  });
  // A name the claim hinges on ("Berlin", "Thomas Edison") that never shares a
  // sentence with the rest of the claim is a contradiction, not loose wording.
  const intro = new Set(firstSentences(articleText, 3).toLowerCase().match(/\w+/g) || []);
  const isolatedNames = nameWords.filter((n) => (nameBest.get(n) || 0) <= 1 && !intro.has(n));
  const articleWords = articleWordSet(articleText);
  const absent = claimArr.filter((w) => !articleWords.has(w));
  const articleNumbers = new Set(claimDigits(articleText));
  const missingNumbers = claimNumbers.filter((n) => !articleNumbers.has(n));
  return {
    best, absent, missingNumbers, isolatedNames,
    share: claimArr.length ? (claimArr.length - absent.length) / claimArr.length : 1,
  };
}

// Commentary/evaluative words: their absence from an article proves nothing.
const VAGUE_WORDS = new Set(["offers","considered","identity","popular","countless","awe","triumph",
  "innovation","masterpiece","monument","landmark","symbol","iconic","elegant","beautiful","famous",
  "important","significant","remarkable","various","several","numerous","widely","generally","often",
  "usually","approximately","roughly","similar","different","beautiful","amazing","stunning",
  "opposed","protests","project","practical","ensured","remained","standing","concerts","events","venue"]);

/* ---------- Decide TRUE / FALSE / skip from that score ---------- */
function judgeClaim(claimWords, articleText, originalWords, subjectStems, canAccuse, claimNumbers = []) {
  // Names (proper nouns) inside the claim, e.g. "Berlin", "Thomas Edison".
  const nameWords = [...claimWords].filter((w) => {
    if (/\d/.test(w) || subjectStems.has(stem(w)) || NOT_A_SUBJECT.has(w)) return false;
    const idx = originalWords.findIndex((ow) => ow.toLowerCase() === w);
    return idx > 0 && /^[A-Z]/.test(originalWords[idx]);
  });
  const support = claimSupport(claimWords, articleText, claimNumbers, nameWords);
  // Two of the claim's words in one sentence is direct support; a longer claim
  // whose every word the article uses is treated as supported too (the article
  // often paraphrases: "the summit offers panoramic views").
  // A figure the article never states, or a name it never connects with the
  // rest of the claim, sinks the claim outright.
  if (canAccuse && (support.missingNumbers.length > 0 || support.isolatedNames.length > 0)) return "FALSE";

  if (support.best >= 2) return "TRUE";
  // Loose wording ("a team of 25 painters... often hanging from the structure"):
  // if the article uses nearly all of the claim's words somewhere, and the
  // sentence's only unmatched words are vague ones, treat it as supported.
  const hardAbsent = support.absent.filter((w) => !VAGUE_WORDS.has(w) && w.length >= 4);
  if ([...claimWords].length >= 3 && hardAbsent.length === 0) return "TRUE";
  if (!canAccuse) return "SKIP";

  // A concrete contradiction: a missing figure, or a missing name/entity the
  // claim hinges on. Loose wording that only paraphrases the source stays
  // unverified rather than being called false.
  const absentNames = support.absent.filter((w) => {
    if (/\d/.test(w)) return true;
    const idx = originalWords.findIndex((ow) => ow.toLowerCase() === w);
    return idx > 0 && /^[A-Z]/.test(originalWords[idx]) && !subjectStems.has(stem(w)) && !NOT_A_SUBJECT.has(w);
  });
  if (support.missingNumbers.length > 0 || absentNames.length > 0) return "FALSE";
  // Weak support plus a missing key word ("invented the telephone" for Einstein).
  // Only concrete, distinctive words count here, not vague commentary words.
  const missingContent = support.absent.filter(
    (w) => w.length >= 5 && !VAGUE_WORDS.has(w) && !/^\d+$/.test(w)
  );
  if (support.best <= 1 && missingContent.length > 0) return "FALSE";
  return "SKIP";
}

// Lowercase word list of the article, reused by the verdict rules below.
function articleWordSet(articleText) {
  return new Set(articleText.toLowerCase().match(/\w+/g) || []);
}

/* ---------- Score one candidate article against the user's sentence ---------- */
function evaluateCandidate(candidate, words, stemmedWordSet, firstContentStem, originalWords) {
  const subjectWords = new Set(
    (candidate.toLowerCase().match(/\w+/g) || []).filter((w) => w.length >= 3 && !GENERIC_TITLE_WORDS.has(w))
  );
  if (subjectWords.size === 0) return null;
  // Year pages ("1887") are never a verifiable subject of a claim.
  if (/^\d{3,4}$/.test(candidate)) return null;
  // Single-word subjects must be capitalized in the original sentence (proper
  // nouns like "Sahara"/"Moon"), otherwise generic matches like "F&F Tower"
  // for the word "tower" slip through.
  if (subjectWords.size === 1) {
    const w = [...subjectWords][0];
    const ok = originalWords.some((ow) => ow.toLowerCase() === w && (/^[A-Z]/.test(ow) || /\d/.test(ow)));
    if (!ok) return null;
  }
  const subjectStems = new Set([...subjectWords].map(stem));
  const sharedCount = [...subjectStems].filter((s) => stemmedWordSet.has(s)).length;
  const isFullMatch = sharedCount === subjectStems.size;
  // Short sentences get a partial-match allowance (e.g. "Dhyan is president"
  // should still match "President of India"); longer ones stay strict.
  if (!isFullMatch && !(words.length <= 5 && sharedCount >= 1)) return null;

  // Extract the user's claim words
  const claimWords = new Set(
    words.filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !subjectStems.has(stem(w)))
  );
  if (claimWords.size === 0) return null;

  // Does the article title appear early in the sentence? The real subject is
  // usually named in the opening words ("The Eiffel Tower was ..."), so this
  // outranks a coincidental title match found later in the sentence.
  const earlyStems = new Set(originalWords.slice(0, LEAD_WORDS).map((w) => stem(w.toLowerCase())));
  const earlyHits = [...subjectStems].filter((st) => earlyStems.has(st)).length;

  return {
    candidate, claimWords, sharedCount, earlyHits,
    coverage: sharedCount / subjectStems.size,
    containsFirst: subjectStems.has(firstContentStem),
  };
}

/* ---------- Core: verify one statement (port of verify_single_statement) ---------- */
/* Sentences that open with a pronoun/article ("It is 330 metres tall", "The tower
   was built in 1889") keep talking about the previous sentence's subject. */
const GENERIC_OPENERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "they", "them", "their",
  "he", "she", "his", "her", "there", "both", "each", "such", "however", "meanwhile",
  "today", "originally", "locally", "after", "during", "by", "in", "on", "at", "with",
  "from", "as", "while", "when", "although", "because", "since", "constructed", "built",
  "designed", "work", "construction", "nicknamed", "known", "called",
]);

// Content words of a claim: 3+ letters that aren't stopwords, plus any number.
function claimWordsFor(words) {
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));
}

/* ---------- Find the article a whole document is about ----------
   Uses the first few sentences so pronoun/article sentences later on still
   check against the right subject. */
async function detectDocumentSubject(sentences) {
  // Use the first real statements as the sample: headings and sentences that
  // start with "it"/"the" say nothing about which article the text is about.
  const usable = sentences.filter((s) => !looksLikeHeading(s) && !PRONOUNS.has((s.match(/\w+/g) || [""])[0].toLowerCase()));
  const head = (usable.length ? usable : sentences).slice(0, 3).join(" ");
  const candidates = await searchWikipedia(head);
  if (!candidates.length) return null;
  const headStems = (head.toLowerCase().match(/\w+/g) || []).map(stem);
  let best = null;
  for (const title of candidates.slice(0, 8)) {
    const titleStems = (title.toLowerCase().match(/\w+/g) || [])
      .filter((w) => w.length >= 3 && !GENERIC_TITLE_WORDS.has(w)).map(stem);
    if (!titleStems.length) continue;
    const hits = titleStems.filter((t) => headStems.includes(t)).length;
    if (hits !== titleStems.length) continue; // every word of the title must appear
    const mentions = titleStems.reduce((n, t) => n + headStems.filter((h) => h === t).length, 0);
    if (!best || mentions > best.mentions || (mentions === best.mentions && titleStems.length > best.words)) {
      best = { title, mentions, words: titleStems.length };
    }
  }
  return best ? best.title : null;
}

/* ---------- Is a candidate title actually named in the sentence? ----------
   Inside a longer text, a title only counts when the sentence spells it as a
   name ("...the Chrysler Building..."), not when Wikipedia matched a generic
   phrase such as "March" or "Time served" found in passing. */
const NOT_A_SUBJECT = new Set(["january","february","march","april","may","june","july","august",
  "september","october","november","december","monday","tuesday","wednesday","thursday","friday",
  "saturday","sunday","french","english","american","british","european","history","list","time","world"]);

function isYearTitle(title) {
  return /^\d{3,4}$/.test(title) || /^\d{3,4} in \w+$/i.test(title);
}

function namesAsProperTitle(title, originalWords) {
  const content = (title.match(/\w+/g) || []).filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()) && !GENERIC_TITLE_WORDS.has(w.toLowerCase())
  );
  if (!content.length) return false;
  if (content.some((c) => NOT_A_SUBJECT.has(c.toLowerCase()))) return false; // "March", "Time served"...
  const named = (w) => originalWords.some((ow) => ow.toLowerCase() === w.toLowerCase() && /^[A-Z]/.test(ow));
  return content.every((c) => (/^\d+$/.test(c) ? originalWords.includes(c) : named(c)));
}

function carryOverSubject(originalWords, previousSubject, documentSubject) {
  const subject = previousSubject || documentSubject;
  if (!subject) return null;
  const first = (originalWords[0] || "").toLowerCase();
  // "Eiffel's permit allowed..." / "The tower..." keep the same subject.
  if (subject.toLowerCase().match(/\w+/g).some((w) => stem(w) === stem(first))) return subject;
  const openerVerb = /ing$/.test(first) && first.length > 5; // "Standing 330 metres tall, ..."
  if (!PRONOUNS.has(first) && !GENERIC_OPENERS.has(first) && !openerVerb) return null;
  // A new proper noun among the opening words means the subject changed
  // ("La dame de fer" is quoted French, so very short capitals are ignored,
  // and dates like "In February 1887" keep the previous subject).
  const earlyProper = originalWords.slice(1, 4).some(
    (w) => /^[A-Z]/.test(w) && w.length >= 3 && !NOT_A_SUBJECT.has(w.toLowerCase()) && !/^\d/.test(w)
  );
  return earlyProper ? null : subject;
}

// A heading such as "The Eiffel Tower: History, Design, and Legacy" is a label,
// not a claim: no verb, no closing punctuation, mostly capitalised words.
const VERB_HINT = /\b(is|are|was|were|has|have|had|be|been|being|can|could|will|would|may|might|must|does|do|did|stands|holds|became|become|remains|contains|lies|located|built|designed)\b/i;
function looksLikeHeading(text) {
  const words = text.match(/\w+/g) || [];
  if (/[.!?]$/.test(text) || words.length < 3) return false;
  if (VERB_HINT.test(text)) return false;
  const capitals = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitals / words.length >= 0.6;
}

async function verifySingleStatement(sentence, previousSubject, documentSubject) {
  const clean = sentence.trim();
  if (looksLikeHeading(clean)) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Heading, not a factual claim." };
  }
  const matched = deaccent(clean);
  const words = matched.toLowerCase().match(/\w+/g) || [];
  const originalWords = matched.match(/\w+/g) || [];

  // 1. Too short / too vague to verify (short factual claims like "Dhyan is
  //    president" are still allowed, as long as they name something specific)
  if (words.length < 3) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Too short to be a verifiable claim." };
  }
  if (words.length === 3 && !originalWords.some((w) => /^[A-Z]/.test(w) || /\d/.test(w))) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Too vague to be a verifiable claim." };
  }
  if (PRONOUNS.has(words[0])) {
    return { statement: clean, status: "NOT_WORTHY", reason: "Personal or vague statement, not an encyclopedic fact." };
  }

  try {
    // 2. Ask Wikipedia which articles this claim is about, then keep the ones
    //    whose title really is named in the sentence. Inside a longer text, a
    //    sentence that names no new entity simply continues the main subject —
    //    no search needed (faster, and much gentler on the API).
    const carriedEarly = carryOverSubject(originalWords, previousSubject, documentSubject);
    // A capitalised name in the sentence may mean it is about something else, so
    // look it up rather than blindly continuing the text's subject.
    const foreignNames = originalWords.slice(1).filter(
      (w) => /^[A-Z]/.test(w) && w.length >= 3 && !NOT_A_SUBJECT.has(w.toLowerCase())
    );
    const needsSearch = !carriedEarly || foreignNames.length > 0;
    const candidates = needsSearch ? await searchWikipedia(clean) : [];
    const seenTitles = new Set(candidates);
    const stemmedWordSet = new Set(words.map(stem));
    const contentWords = words.filter((w) => !STOPWORDS.has(w));
    const firstContentStem = contentWords.length ? stem(contentWords[0]) : "";

    const rank = (list) =>
      list
        .map((c) => evaluateCandidate(c, words, stemmedWordSet, firstContentStem, originalWords))
        .filter(Boolean)
        .sort((a, b) =>
          b.coverage - a.coverage ||
          b.earlyHits - a.earlyHits ||
          (b.containsFirst ? 1 : 0) - (a.containsFirst ? 1 : 0) ||
          b.sharedCount - a.sharedCount
        );

    let ranked = rank(candidates);
    if (!ranked.some((e) => e.sharedCount >= 2) && contentWords.length >= 3) {
      // The subject may be a phrase the full-sentence search missed: retry with
      // "president india right now" and "albert einstein" style queries.
      for (const q of [contentWords.slice(1).join(" "), contentWords.slice(0, 2).join(" ")]) {
        for (const c of await searchWikipedia(q)) {
          if (!seenTitles.has(c)) { seenTitles.add(c); candidates.push(c); }
        }
      }
      ranked = rank(candidates);
    }

    // 3. Choose the subject of this sentence.
    //    - an article named in the sentence wins (longest name first)
    //    - the subject the whole text is about wins over a one-off mention
    //    - otherwise a pronoun/"The tower…" sentence inherits the document's subject
    const named = ranked
      .filter((e) => e.coverage === 1 && e.earlyHits >= 1)
      // Longest title first, but never a bare year page over a real subject.
      .sort((a, b) =>
        (isYearTitle(b.candidate) ? 0 : 1) - (isYearTitle(a.candidate) ? 0 : 1) ||
        (b.candidate.match(/\w+/g) || []).length - (a.candidate.match(/\w+/g) || []).length
      );

    let subject = null;
    const carried = carriedEarly;
    // Article of the current subject, used to decide whether a sentence really
    // belongs to it ("The tower..." does, "dhyan is the president..." does not).
    const docWords = new Set(
      ((await fetchArticleText(documentSubject).catch(() => null)) || "").toLowerCase().match(/\w+/g) || []
    );
    const relatedToDoc = contentWords.some((w) => w.length >= 4 && docWords.has(w));

    // A sentence that clearly names a different article (e.g. "The Chrysler
    // Building ...") switches subject even mid-report.
    const docContent = new Set((documentSubject || "").toLowerCase().match(/\w+/g) || []);
    const properOther = named.find((e) => {
      if (e.candidate === documentSubject || isYearTitle(e.candidate)) return false;
      if (!namesAsProperTitle(e.candidate, originalWords)) return false;
      // "Eiffel 65" is not a new subject when the text is already about the
      // Eiffel Tower: its only real word is part of the current subject.
      const content = (e.candidate.toLowerCase().match(/\w+/g) || []).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
      return content.some((w) => !docContent.has(w));
    });

    if (properOther) subject = properOther.candidate;
    else if (carried && !foreignNames.length) subject = carried;
    else if (named.length) subject = named[0].candidate;
    else if (documentSubject && relatedToDoc) subject = documentSubject;
    else if (carried) subject = carried;
    else subject = null;

    if (!subject) {
      return { statement: clean, status: "NOT_WORTHY", reason: "No recognizable encyclopedic subject found." };
    }

    // 4. Check the claim against that article's full text.
    const articleText = await fetchArticleText(subject).catch(() => null);
    if (!articleText) {
      return { statement: clean, status: "NOT_WORTHY", reason: "No Wikipedia article found for this subject." };
    }

    // The claim is the sentence minus the subject's own words ("The Eiffel
    // Tower" -> "located london england").
    const subjectStems = new Set((subject.toLowerCase().match(/\w+/g) || []).map(stem));
    const claim = new Set([...claimWordsFor(words)].filter((w) => !subjectStems.has(stem(w))));
    if (claim.size === 0) {
      return { statement: clean, status: "NOT_WORTHY", reason: "No factual detail to check in this sentence." };
    }

    // A sentence that names its own subject (or a standalone statement) can be
    // judged on its own; an inherited "It was..." sentence only when that
    // subject is also what the whole text is about.
    const namesOwnSubject = ranked.some((e) => e.candidate === subject && e.coverage === 1 && e.earlyHits >= 1);
    const canAccuse = namesOwnSubject || subject === documentSubject || !documentSubject;
    // Figures the claim asserts, excluding numbers that belong to the subject
    // ("Exposition Universelle (1889)").
    const subjectDigits = new Set(claimDigits(subject));
    const claimNumbers = claimDigits(clean).filter(
      (n) => !subjectDigits.has(n) && !subject.toLowerCase().includes(n)
    );
    let verdict = judgeClaim(claim, articleText, originalWords, subjectStems, canAccuse, claimNumbers);

    if (verdict === "TRUE") return { statement: clean, status: "TRUE", subject };
    if (verdict === "FALSE") {
      return { statement: clean, status: "FALSE", subject, correct_info: firstSentences(articleText, 3) };
    }

    // A report sentence that wanders onto another topic gets one last chance
    // against the text's main article before being called unverifiable.
    if (documentSubject && subject !== documentSubject) {
      const docText = await fetchArticleText(documentSubject).catch(() => null);
      const docSubjectStems = new Set((documentSubject.toLowerCase().match(/\w+/g) || []).map(stem));
      const docClaim = new Set([...claimWordsFor(words)].filter((w) => !docSubjectStems.has(stem(w))));
      if (docText && docClaim.size > 0) {
        // Only accuse the main article when the sentence names no other entity.
        const docVerdict = judgeClaim(docClaim, docText, originalWords, docSubjectStems, !properOther, claimNumbers);
        if (docVerdict === "TRUE") return { statement: clean, status: "TRUE", subject: documentSubject };
        if (docVerdict === "FALSE") {
          return { statement: clean, status: "FALSE", subject: documentSubject, correct_info: firstSentences(docText, 3) };
        }
      }
    }

    return { statement: clean, status: "NOT_WORTHY", reason: "Could not verify this claim against Wikipedia." };
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

  // Split on lines and sentence ends only — "2.5 million" must stay intact.
  const sentences = splitSentences(raw);
  if (sentences.length === 0) { toast("No statements found in your input."); return; }

  const btn = $("checkBtn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  $("progressWrap").hidden = false;
  $("results").hidden = true;

  const results = [];
  let lastSubject = null;
  // What is the whole text about? Knowing this keeps pronoun sentences
  // ("It was completed in 1889") pointed at the right article.
  let docSubject = null;
  if (sentences.length > 2) {
    $("progressText").textContent = "Identifying the main subject…";
    try { docSubject = await detectDocumentSubject(sentences); } catch (err) { docSubject = null; }
  }
  for (let i = 0; i < sentences.length; i++) {
    $("progressFill").style.width = Math.round(((i + 1) / sentences.length) * 100) + "%";
    $("progressText").textContent = `Checking statement ${i + 1} of ${sentences.length}…`;
    const verdict = await verifySingleStatement(sentences[i], lastSubject, docSubject);
    results.push(verdict);
    // Remember the subject so pronoun/article sentences ("The tower...", "It...")
    // keep checking against the same article.
    if (verdict.subject) lastSubject = verdict.subject;
    await sleep(250); // be gentle with the Wikipedia API
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
      : `${trueItems.length} of ${total} verifiable claims checked out as true against Wikipedia` +
        (skipItems.length ? ` — the other ${skipItems.length} could not be verified automatically.` : ".");

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
