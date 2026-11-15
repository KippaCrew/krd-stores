# Kippa Crew — the Kippa Ring Depot crew app

A phone app for the Kippa Ring Depot crew. Use it for the store room (it replaces the paper sign-out sheet), TOI broadcasts, group chats and app updates.

- **Staff** tap their name, enter a 4-digit PIN, tap **+** on what they take, then **Log**. That takes about 10 seconds.
- **You (manager)** get par-level reorder emails, a 7am daily summary, blind stocktakes on your phone, reports, team chat and a **TRACKS entry** sheet that totals everything you still need to key into TRACKS.
- **Uniform collections:** when TRACKS dispatches a uniform order to Kippa Ring, a ticket appears here. Tick it when the parcel arrives and the person gets a "ready to collect" notification.
- **TOI Broadcasts** send notices to everyone, with PDFs and photos attached. They can be marked urgent (a pop-up appears) and can ask for a "read & understood" acknowledgement, so you can see who has acknowledged.

It's free to run: GitHub Pages hosts the app, Supabase stores the data and Resend sends the emails. It's separate from QR systems. The only connection is optional and one-way: TRACKS can **send** Kippa Crew a uniform order number and the person's name (see section 7). Kippa Crew can't see or change anything in TRACKS.

```
 Phone (staff / manager)                     Supabase (your free account, Sydney)
 ┌─────────────────────────┐   HTTPS/RPC    ┌──────────────────────────────────┐
 │ Kippa Crew web app      │ ─────────────▶ │ Postgres database                │
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

## 6. Phone notifications (about 10 minutes)

Banner notifications on phones for **new TOI broadcasts**, **new chat messages** (Team, your groups, and direct messages) and, for managers, **items dropping to par**.

**a) Add the sending function in Supabase**
1. In Supabase's left menu, go to **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly **`kippa-push`**.
3. Delete the sample code, then paste in **all** of `supabase/kippa-push.ts` and click **Deploy**.
4. Open the function's **Details** (or settings) and switch **OFF** "Verify JWT" (sometimes called "Enforce JWT verification"). Save.
   *(It checks a private secret held by your database instead, so it's still protected.)*

**b) Connect it.** In Kippa Crew, go to **More → Settings → 🔔 Phone notifications → Connect notifications**. It should say **✅ Connected**.
This creates your project's own notification keys and stores them in your database. You don't need to copy any keys.

**c) Each person turns them on**, from the prompt on their home screen or under **Me → 🔔 Turn on notifications**, then taps **Allow**.
- **Android (Samsung, Pixel, etc.):** works in Chrome or Samsung Internet, installed or not.
- **iPhone (iOS 16.4 or newer):** Kippa Crew must be added to the Home Screen first (Safari → Share → Add to Home Screen) and opened from there. Then turn notifications on.
- Use **Me → Send me a test** to check.
- **Signing out** turns notifications off for that phone, so the next person on a shared phone doesn't get someone else's messages.

If a test notification doesn't arrive, check that "Verify JWT" is off and press **Re-check connection** in Settings. Supabase's **Edge Functions → kippa-push → Logs** also shows each send.

---

## 7. TRACKS link: uniform orders (about 5 minutes, optional)

When the uniform store sets an order to **Dispatched to Depot** for Kippa Ring, TRACKS tells Kippa Crew. A ticket appears under **Uniform collections** with the person's name, order number and item count. When the parcel arrives, tap **It's arrived**. The person gets a notification (and a banner in the app) saying it's ready to collect. When they pick it up, tap **Handed over**, or they can tap **I've picked it up** themselves.

**a) Run the new `supabase/schema.sql`** in the SQL Editor (as for any update).

**b) Turn it on in Kippa Crew.** Go to **More → Settings → 👕 TRACKS link → Turn on TRACKS link**. It shows a small block of code with your link key. Press **Copy**.

**c) Paste it into TRACKS.** Use the supplied `admin.aspx`, which already has the TRACKS side added. Find `KIPPA_CREW:` near the top (inside `var CONFIG = {`), replace that whole block with what you copied, and upload `admin.aspx` back to SharePoint.

**d) Test it.** Dispatch a test order to Kippa Ring in TRACKS. The TRACKS message should end with "Kippa Crew has been told", and Settings should show **✅ Last heard from TRACKS**.

**Matching people.** TRACKS sends names only, with no service numbers. Kippa Crew matches the name to a person in **Staff** and understands "Quirk, Keith" as well as "Keith Quirk". Using the same first and last name in both systems makes it work best. If a name doesn't match (say TRACKS has "Samuel" and Kippa Crew has "Sam"), the ticket says **Choose person**. Pick them once and Kippa Crew remembers, so that name goes straight to them from then on.

**What TRACKS sends:** the order number, the person's name, the depot and the number of items. It sends nothing else, and only for orders going to the depots in `DEPOTS`. If an order is cancelled in TRACKS, its open ticket is closed. If Kippa Crew can't be reached, TRACKS still saves the status normally and warns that you'll need to add the order by hand (**Uniform collections → + Add**).

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
| **TOI Broadcasts & Depot Announcements** | They work the same way: Managers (and staff ticked "Can send TOI broadcasts") send **TOI Broadcasts**, and Administrators send **Depot Announcements**. Go to **Messages → 📣 Broadcasts → New**. Add a title and message, plus up to 6 PDFs or photos (10 MB each; photos are shrunk automatically). Tick **Require "read & understood"** to track acknowledgements, and tick **Urgent** to pop it up on everyone's screen until they've read it. The sender and managers can see live read receipts (acknowledged / opened / not opened) and can delete a broadcast for everyone. Managers can always send. To let a depot supervisor send without manager access, go to **Staff → their name → Can send TOI broadcasts**. Unread broadcasts show a banner on the home and Take screens. |
| **Item photos** | Go to **Stock → item → Add photo** and take a photo or choose one. It's shrunk automatically. Staff see it next to the item when taking stock and can tap it to see it bigger. Photos also show during stocktakes. |
| **Positions, unions & groups** | Each person has a **Union affiliation**: **None** (default), **RTBU** or **AFULE**. RTBU and AFULE members are put in that union's chat automatically, whatever their position, and the union's logo is the chat icon. Changing the affiliation moves them; None means no union chat. Each person is also a **Driver**, **Guard** or **Other**. Drivers are put in the **Drivers** chat and Guards in the **Guards** chat automatically, and changing their position moves them. Managers aren't added unless their own position is Driver or Guard. Anyone can make their own group under **Messages → Chat → New group**. Only members can see a group. The person who made it, or a manager in it, can rename it, change its members or delete it. |
| **What's New** | Go to **More → What's New**, write a title and points (one per line), or tap **Fill in this version's app changes**. Then **Preview** and **Post to everyone**. Each person sees it as a pop-up once and taps **Got it**. You can see "Seen by X of Y". |
| **Someone leaves the depot** | Go to **Staff → their name → Remove (left depot)**. They're signed out straight away, disappear from the sign-in list, chats and groups, and stop counting in read receipts. Their history stays in reports and TRACKS. You can bring them back from **Former staff**. |
| **Uniform collections** | Managers and Administrators: **Home → Uniforms** or **More → Uniform collections**. **To do** lists *Waiting for pickup* and *On the way*; tap **It's arrived** to notify the person, then **Handed over**. Both have an undo. An order not here after 7 days is flagged red, and the 7am email lists orders to chase. People are reminded after 2 days if they haven't collected (at most 3 reminders). The **Collected** tab has a **Marked Collected in TRACKS** switch so you know what still needs updating in TRACKS. Use **+ Add** for anything TRACKS didn't send. Staff see their orders under **Me → My uniform orders**. |
| **Report a fault** | An orange button on every home screen (and **Me / More → Report a fault**) opens QR's Building Faults page on SharePoint. To change the link, edit `FAULT_FORMS` in `js/app.js`. |
| **Suggestion box** | Staff and Administrators: **Me → Suggestion box**. It's anonymous: no name, staff ID or time is saved, only the date, and each person can send up to 5 a day. Only Managers can read them (**More → Suggestion box**, plus a banner on Home and a count in the 7am email). There's no instant notification, because the timing could give away who sent it. Set a status, write a reply and tick **Share with the crew** to post it under **You said, we did**. |
| **Chat** | The **Team** channel is for everyone. Staff can message managers directly, and managers can message anyone. Unread messages show as red badges. |
| **Roles** | **Staff:** take items, see their own history, read broadcasts, chat, change their PIN. **Administrator:** everything Staff can do, plus receive deliveries, run stocktakes, manage Staff & Administrators (not Managers), send **Depot Announcements** and share the app link. Administrators don't see stock levels, Items & par levels, Import, Reports, TRACKS entry, What's New posting or Settings. **Manager:** everything, and sends **TOI Broadcasts**. Only a Manager can make someone a Manager. |

## Security

- The public key can **only** call the app's functions. Every table is locked with Row Level Security and has no public policies.
- Every function checks the signed-in session. Manager-only functions also check the role.
- PINs are stored as bcrypt hashes. Five wrong PINs locks that person out for 5 minutes, and a manager can reset a PIN to unlock them.
- Anyone signed in with a default or reset PIN can't do anything until they've chosen their own. The database enforces this, not just the screen.
- Sessions last 120 days on that phone. Signing out, deactivating someone or resetting their PIN ends their sessions.
- Staff never see stock quantities, and only managers can see everyone's activity.
- Suggestions are stored with no link to the sender. Supabase's own server logs record that a phone contacted the server, but not what it sent, and only the account owner can see them.
- TRACKS uses a separate **link key** that can only create or cancel uniform tickets. It can't read anything. If the key ever gets out, use **Settings → TRACKS link → Make a new key** and paste the new code into TRACKS.

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
supabase/kippa-push.ts  Phone-notification sender (paste into a Supabase Edge Function)
items-template.csv      Template for importing your item list
```
