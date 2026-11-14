# KRD Stores — Kippa Ring Depot Stores

A phone app for the depot store room. It replaces the paper sign-out sheet.

- **Staff** tap their name, enter a 4-digit PIN, tap **+** on what they take, then **Log**. That takes about 10 seconds.
- **You (manager)** get par-level reorder emails, a 7am daily summary, blind stocktakes on your phone, reports, team chat and a **TRACKS entry** sheet that totals everything you still need to key into TRACKS.
- **TOI Broadcasts** send notices to everyone, with PDFs and photos attached. They can be marked urgent (a pop-up appears) and can ask for a "read & understood" acknowledgement, so you can see who has acknowledged.

It's free to run: GitHub Pages hosts the app, Supabase stores the data and Resend sends the emails. It's completely separate from QR systems.

```
 Phone (staff / manager)                     Supabase (your free account, Sydney)
 ┌─────────────────────────┐   HTTPS/RPC    ┌──────────────────────────────────┐
 │ KRD Stores web app      │ ─────────────▶ │ Postgres database                │
 │ (GitHub Pages, PWA)     │                │  • secured functions (PIN login) │
 │  • works like an app    │ ◀───────────── │  • tables locked to the public   │
 │  • saves takes offline  │                │  • pg_net  → Resend → your email │
 └─────────────────────────┘                │  • pg_cron → 7am daily summary   │
                                            └──────────────────────────────────┘
```

---

## Demo vs live: where is the data?

| | Demo mode (`config.js` blank) | Live (`config.js` has your Supabase details) |
|---|---|---|
| Where data lives | Only in that one phone's browser | In your Supabase database (Sydney) |
| Shared between phones? | ❌ No. Every phone has its own separate demo | ✅ Yes. Everyone sees the same stock, takes, chat and broadcasts |
| How quickly it updates | n/a | Takes and stock: instantly. Chat: within ~4 s. Badges and broadcasts: within ~25 s |
| Emails | Not sent | Sent through Resend |
| Survives a lost or new phone? | No | Yes. Just sign in again |

The only thing a live phone stores locally is who is signed in, plus any takes logged with **no signal**. Those send automatically when the signal comes back.

**To go live:** follow steps 1–4 below. Step 1 creates the database, step 2 puts the app online with your details in `config.js`, step 3 creates your manager account, and step 4 sets up email. Demo data does **not** carry over: you start clean and import your real items.

## 0. Try it first (2 minutes, no setup)

Open the app with `config.js` left blank. It runs in **demo mode**, where data stays on that one phone and nothing is shared.
Demo PINs: Manager **1234** · Sam **1111** · Alex **2222**.

---

## 1. Create the database (Supabase) — about 10 minutes

1. Go to **https://supabase.com**, sign up (free), and click **New project**.
   - Name: `krd-stores`
   - Database password: make one up and save it somewhere safe
   - Region: **Sydney (ap-southeast-2)**
2. Wait about a minute for it to build. In the left menu, open **SQL Editor** and click **New query**.
3. Open `supabase/schema.sql` from this folder, copy **all** of it, paste it in and press **Run**.
   You should see *Success*. (It's safe to run again later, because it keeps your data.)
4. In the left menu, go to **Project Settings → API** (or **Connect**) and copy:
   - **Project URL**, which looks like `https://abcdefghijkl.supabase.co`
   - The **anon public** key (or the **publishable** key, `sb_publishable_…`)

   ⚠️ Never use the **service_role / secret** key in the app.
5. Open `config.js` and paste them in:
   ```js
   window.KRD_CONFIG = {
     SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...'
   };
   ```

## 2. Put the app online (GitHub Pages) — about 5 minutes

1. On **github.com**, click **New repository**.
   - Name: `krd-stores`
   - Visibility: **Public**. Free GitHub Pages needs a public repo. That's fine here: the repo holds only the app code. No staff data or passwords are in it, and the key in `config.js` is designed to be public.
2. Click **uploading an existing file**, drag in **everything in this folder** (keep the `js`, `icons` and `supabase` folders), then click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**, Branch to **main**, folder to **/ (root)**, then click **Save**.
4. After about a minute, your app is live at **`https://YOUR-GITHUB-NAME.github.io/krd-stores/`**

## 3. First sign-in (you)

1. Open the link on your phone. It asks you to **create the manager account**: enter your name and a 4-digit PIN.
2. Add it to your home screen:
   - **iPhone:** in Safari, tap Share, then **Add to Home Screen**
   - **Android:** in Chrome, tap ⋮, then **Install app**

## 4. Reorder emails (Resend) — about 5 minutes

1. Go to **https://resend.com** and sign up **with the email address you want the alerts sent to**.
2. Go to **API Keys → Create API key** (Sending access), then copy the key (`re_…`).
3. In the app, go to **More → Settings**:
   - **Send alerts to:** your email
   - **Resend API key:** paste it
   - Leave **From** as `onboarding@resend.dev`
   - Press **Save**, then **Send test email**. Check your junk folder the first time and mark it *Not junk*.

> On Resend's free plan without your own domain, emails can only go to the address you signed up to Resend with. That's fine for alerts to yourself. If you want alerts going to several people, verify a domain in Resend, then change **From** to an address at that domain.

What you'll get:
- **Instant alert**: one email the moment an item drops **to or below its par level**. You won't get repeat emails about that item until it's restocked above par.
- **Daily summary, 7:00am**: everything at or below par, with a suggested order quantity, plus what was taken yesterday.

## 5. Load your items and staff

- **Items:** go to **More → Import items**. In Excel, select your list including the heading row, copy, paste it into the box, then press **Preview → Import**.
  Headings it understands: `Item, Category, Unit, Code, On hand, Par, Order up to, Max per take`. Only **Item** is required.
  There's a template in `items-template.csv`.
- **Staff:** go to **More → Staff → Add person**, type their name and press **Save**. They start with the **default PIN** (`0000` unless you change it in **Settings → Staff sign-in**). Send them the app link. The first time they sign in, the app makes them choose their own 4-digit PIN; easy ones like `1234` and the default PIN aren't allowed.
- **Forgotten PIN or locked out?** Go to **Staff → their name → Reset PIN**. It goes back to the default PIN, they're signed out and unlocked, and they choose a new PIN at their next sign-in.

---

## How things work

| Feature | Details |
|---|---|
| **Taking items** | Search or filter by category, tap **+**, then **Review → Log**. An optional note covers things like vehicle or job. If there's no signal, the take is saved on the phone and sent automatically later. |
| **Mistakes** | Staff can **undo** their own entry for 15 minutes. After that, you can adjust stock from **Stock → item**. |
| **Par level** | Stock **at or below par** goes on the reorder list. *Order up to* sets the suggested order quantity (blank means 2 × par). *Max per take* is optional. |
| **Blind stocktake** | Go to **Count → Start**. System quantities are hidden while you count, and counts save as you type. **Finish** shows the variances and updates stock. Staff can keep taking items during the count, and the app allows for those takes. Uncounted items are left unchanged. |
| **Receiving stock** | Go to **More → Receive a delivery** and enter quantities. An optional docket number can be added. |
| **TRACKS entry** | Shows the totals per item that you haven't entered into TRACKS yet. Use **Copy for Excel**, **CSV** or **Print**. Pressing **Mark as entered** clears them, but anything logged after you opened the page stays for next time. Put each item's TRACKS code in the item's **Code** field so it appears on the sheet. |
| **Reports** | Covers Today, 7 days, 30 days, this month or a custom range. You can view by item, by person or all activity, and export to CSV. |
| **TOI Broadcasts** | Go to **Messages → 📣 TOI Broadcasts → New**. Add a title and message, plus up to 6 PDFs or photos (10 MB each; photos are shrunk automatically). Tick **Require "read & understood"** to track acknowledgements, and tick **Urgent** to pop it up on everyone's screen until they've read it. The sender and managers can see live read receipts (acknowledged / opened / not opened) and can delete a broadcast for everyone. Managers can always send. To let a depot supervisor send without manager access, go to **Staff → their name → Can send TOI broadcasts**. Unread broadcasts show a banner on the home and Take screens. |
| **Chat** | The **Team** channel is for everyone. Staff can message managers directly, and managers can message anyone. Unread messages show as red badges. |
| **Roles** | **Staff** can take items, see their own history, chat and change their PIN. **Manager** can do all of that plus see stock, run stocktakes, manage items and staff, view reports and change settings. |

## Security

- The public key can **only** call the app's functions. Every table is locked with Row Level Security and has no public policies.
- Every function checks the signed-in session. Manager-only functions also check the role.
- PINs are stored as bcrypt hashes. Five wrong PINs locks that person out for 5 minutes, and a manager can reset a PIN to unlock them.
- Anyone signed in with a default or reset PIN can't do anything until they've chosen their own. The database enforces this, not just the screen.
- Sessions last 120 days on that phone. Signing out, deactivating someone or resetting their PIN ends their sessions.
- Staff never see stock quantities, and only managers can see everyone's activity.

## Looking after it

- **Supabase free plan:** a project with **no activity for 7 days** gets paused. Normal daily use keeps it awake. If it ever pauses, log in to Supabase and press **Restore**. No data is lost.
- **Storage:** the free database holds 500 MB. Broadcast attachments are the only big things stored. A 2 MB PDF a week is about 100 MB a year, so delete old broadcasts you no longer need to free the space. **Settings → Usage** in Supabase shows how much you're using.
- **Backups:** once a month, go to **Reports → 30 days → Download all activity (CSV)** and **Stock → Download items CSV**. Supabase also lets you export each table from **Table Editor**.
- **Updating the app:** edit or replace files in GitHub. Phones pick up the new version the next time they open the app.
- **Changing the database:** edit `supabase/schema.sql` and run it again in the SQL Editor. It updates the functions and keeps your data.

## Files

```
index.html              App shell
styles.css              Look & feel (TRACKS style: Atkinson Hyperlegible, teal/navy, sand)
config.js               ← your Supabase URL + public key go here
js/api.js               Talks to Supabase (or the demo)
js/app.js               All screens
js/demo.js              Demo-mode backend (runs in the browser)
sw.js, manifest.webmanifest, icons/   Installable app + offline support
supabase/schema.sql     The whole database: tables, security, functions, emails, schedule, broadcasts
items-template.csv      Template for importing your item list
```
