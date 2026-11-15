# FactBot AI — AI Fact Checker

A dark-themed web app that fact-checks statements and CSV files against Wikipedia.
Paste text, upload a `.txt` / `.csv` file, and get a **Truth Score** with every
claim marked **True**, **False** (with correct info), or **Skipped**.

> The fact-checking engine is a JavaScript port of the original Python
> `wikipedia`-based logic, so the whole site runs in the browser — no server
> needed. The original Python code is included in `backend/` as an optional
> Flask API.

---

## 🚀 Deploy to GitHub Pages (free, ~5 minutes)

### Option A — Upload files through the GitHub website (no terminal needed)

1. Go to [github.com](https://github.com) and log in (create a free account if needed).
2. Click the **+** icon (top right) → **New repository**.
3. Name it `factcheck-ai` (or anything you like), keep it **Public**, and click **Create repository**.
4. On the repo page, click **Add file → Upload files**.
5. Drag in these files from this project folder:
   - `index.html`
   - `style.css`
   - `script.js`
   - `README.md`
   - `.github/workflows/deploy.yml` — ⚠️ GitHub's web uploader can't create
     hidden folders, so for this one file use **Option B** below, **or** skip it
     and use Option C (manual Pages setup) instead.
6. Click **Commit changes**.

### Option B — Push with Git (recommended, includes auto-deploy)

Install Git from [git-scm.com](https://git-scm.com), then run these commands
inside this project folder:

```bash
git init
git add .
git commit -m "FactBot AI fact checker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/factcheck-ai.git
git push -u origin main
```

> Replace `YOUR-USERNAME` with your GitHub username and `factcheck-ai` with
> your repo name.

### Option C — Enable GitHub Pages (one-time setting)

1. Open your repo → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. That's it! The included workflow (`.github/workflows/deploy.yml`) deploys
   automatically on every push to `main`.
   - If you used Option A (no workflow file), choose **Deploy from a branch**,
     select `main` / `(root)`, and save instead.

### 🎉 Your site is live!

After 1–2 minutes, visit:

```
https://YOUR-USERNAME.github.io/factcheck-ai/
```

Every future `git push` redeploys automatically. To update the site, edit the
files, commit, and push.

---

## 💻 Run it locally (preview before deploying)

Any static file server works. From this folder:

```bash
# Python (already installed on most systems)
python -m http.server 8000
```

Then open http://localhost:8000 in your browser.

> Note: the fact-check calls the Wikipedia API directly from the browser, so
> you need an internet connection. No API keys or accounts required.

---

## 🐍 Optional: Python backend (Flask API)

Your original Python engine is in `backend/app.py`, wrapped as a REST API:

```bash
cd backend
pip install -r requirements.txt
python app.py
```

- `GET  /health` — health check
- `POST /api/check` — JSON body `{"text": "..."}` or a multipart file upload
  (`.txt` / `.csv`), returns the full report as JSON.

Deploy it free on [Render](https://render.com), [Railway](https://railway.app),
or [Fly.io](https://fly.io) if you ever want server-side checking.

---

## 📁 Project structure

```
factcheck-ai/
├── index.html                  ← the website
├── style.css                   ← dark theme (matches your screenshot)
├── script.js                   ← fact-check engine (JS port of your Python)
├── backend/
│   ├── app.py                  ← your original Python code as a Flask API
│   └── requirements.txt
├── .github/workflows/
│   └── deploy.yml              ← auto-deploy to GitHub Pages
└── README.md
```

## ⚙️ How the fact-checking works

For each sentence, FactBot:

1. Rejects short / personal / vague statements (not fact-check worthy).
2. Searches Wikipedia for the main subject and confirms the subject actually
   appears in your sentence.
3. Extracts the claim words (excluding stopwords and subject words).
4. Fetches the Wikipedia summary and checks what % of claim words appear in it.
5. **≥ 35% match → True**, otherwise **False** with the correct info shown.
