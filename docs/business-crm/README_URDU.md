# Business CRM — Owner Guide (Roman Urdu)

| Field | Value |
|---|---|
| **Purpose** | Owner aur operator ke liye Business CRM ka aasan guide. |
| **Scope** | Rozana istemaal, ahem usool, aur masla hone par kya karna hai. |
| **Status** | As-built. Yeh guide sirf samjhane ke liye hai. |
| **Last verified commit** | `8b76b617f67928e6454226d1861f9d35913a3981` |
| **Last verified date** | 2026-08-10 |
| **Source files inspected** | Wahi files jo [`README.md`](README.md) mein likhi hain. |
| **Related documents** | Technical tafseel ke liye asli documents: [`README.md`](README.md), [`troubleshooting.md`](troubleshooting.md), [`operations-runbook.md`](operations-runbook.md) |
| **Owner / maintainer** | Repository owner (`Toolstack7462`). |
| **What this document does not verify** | Kuch bhi naya verify nahi karta. Har technical baat ke liye English documents authoritative hain. |

> **Zaroori:** Yeh document sirf samajhne ke liye hai. Koi bhi technical faisla English documents se
> lein — wo asli reference hain.

## CRM kya hai

Business CRM aap ke **mojooda** Admin panel ke andar ek naya section hai. Ye **paison ka hisaab** rakhta
hai: sale price, cost, vendor, payments, invoice, profit, expenses.

Yeh koi alag website ya alag login **nahi** hai. Aap wahi `/admin/login` istemaal karte hain jo pehle
se hai. Login ke baad sidebar mein **Business CRM** par click karein.

## Sab se ahem do usool

1. **Tool access ka malik purana website system hai.**
   Kis client ko kaunsa tool mila, kab start hua, kab expire hoga, revoke hua ya nahi — yeh sab
   **Give Access / Assignments** se control hota hai. CRM sirf dekhta hai, badalta nahi.

2. **Paison ka malik CRM hai.**
   Price, cost, vendor, payment, invoice — yeh sirf CRM ke andar likhe jate hain. Give Access ki screen
   par paison ka koi field **nahi** hai, aur jaan bookjh kar nahi rakha gaya.

Is ka faida: agar CRM mein koi masla ho, client ka access kabhi kharab nahi hoga. Dono system alag
hain.

## Rozana kaam

### Website se diya gaya access

1. **Business CRM → Website Access** kholein.
2. Page khud reconcile karta hai — yani website se naye access records le aata hai.
3. Jis record par **"Needs Financial Details"** likha ho, us par **Complete Financial Details** dabayein.
4. Sirf paison ki tafseel bharein: sale price, currency, purchase cost, vendor, amount received.
5. Client, tool, start date aur expiry **khud aa jate hain** aur unhein aap yahan badal nahi sakte —
   yeh website system se aate hain. Yeh design hai, masla nahi.

Agar koi access bill karne ke qabil nahi, to **Mark Non-Billable** dabayein.

### Manual tool (jo website se nahi diya gaya)

Aise tools jo aap ne website ke bahar bech diye:

1. **Sales → New sale** kholein.
2. Client, tool ka naam, dates, price, cost, vendor bharein.
3. Save karein.

Yaad rakhein: manual sale se client ko **koi access nahi milta**. Access dene ke liye purana Give
Access flow hi istemaal karein. Yeh jaan bookjh kar aisa hai.

### Currency

Teen currency alag alag chalti hain: **PKR, INR, NGN**.

- Upar toolbar mein "Reporting currency" se badlein.
- System kabhi conversion **nahi** karta.
- PKR aur INR ke total kabhi jama nahi hote. Har currency ka hisaab alag rehta hai.

## Roles — kaun kya kar sakta hai

| Role | Kya kar sakta hai |
|---|---|
| **OWNER** | Sab kuch |
| **ADMIN** | Sab kuch |
| **MANAGER** | Sale, payment, reports, reconcile. Lekin sale delete, settings, team access aur backup nahi |
| **STAFF** | Sale banana aur client payment. Cost, profit, vendor, credentials, reports **nahi dekh sakta** |
| **VIEWER** | Sirf dekh sakta hai. Kuch bhi change nahi kar sakta |

Team roles yahan set hotay hain: **Business CRM → Team & Permissions**.

Ahem baat: CRM se naya login account **nahi** banaya ja sakta aur password reset **nahi** ho sakta.
Yeh jaan bookjh kar band hai, kyunke wo purane admin system ka kaam hai. Agar aap koshish karein to
system 405 error dega — yeh bug nahi hai.

## Agar masla ho

Pehle yeh dekhein. Har cheez ki tafseel [`troubleshooting.md`](troubleshooting.md) mein hai.

| Masla | Pehla qadam |
|---|---|
| Page khali safed aa raha hai | Page refresh karein. URL dekhein ke wo saaf hai. Phir sidebar se dobara kholein |
| URL lamba hota ja raha hai | Yeh purana masla tha aur **theek ho gaya hai**. Agar phir dikhe to report karein |
| Login baar baar mangta hai | Naya private window kholein aur dobara login karein |
| "You do not have permission" | Aap ke role mein wo permission nahi hai. Owner se kehin ke Team & Permissions se de dein |
| Credentials save nahi ho rahe (503) | Server ki vault key set nahi hai. Yeh configuration ka kaam hai, code ka nahi. Baaqi sab kaam karta rahega |
| Website Access mein record nahi aa raha | **Reconcile now** dabayein. Filter ko **All** karein |
| Invoice PDF nahi khul rahi | Us sale ka page kholein aur dobara koshish karein. Agar sirf credentials ke sath fail ho to vault key ka masla hai |
| Mobile par page side mein khisak raha hai | Kaunsa page aur kaunsa phone, yeh likh kar report karein |

**Kabhi bhi** yeh na karein: Give Access, Assignments, client portal, extension, proxy, StealthWriter
ya Claude gateway ko CRM ka masla theek karne ke liye na chhoo-en. Wo alag system hain.

## Jo cheezein ab tak test nahi hui

Iman-daari se: kuch cheezein **abhi tak asli data ke sath test nahi hui**. In par bharosa karne se
pehle khud check karein:

- Sale banana, payment, payment reversal, invoice PDF — asli database ke sath test nahi hua
- CSV import, JSON backup, offline queue — test nahi hua
- MANAGER / STAFF / VIEWER roles ka asli behaviour — test nahi hua
- Server par `BUSINESS_CRM_VAULT_KEY` maujood hai ya nahi — **maloom nahi**

Jo cheezein production mein test ho chuki hain: Dashboard aur Reports (teeno currency), routing,
mobile layout, aur yeh ke purane admin pages theek kaam karte hain.

Poori list: [`known-issues.md`](known-issues.md).

## Ahem hidayat

- Testing ke liye **asli customer** ka record istemaal na karein.
- Koi bhi schema change se pehle database ka **backup** lein.
- Password, cookie, token, database URL ya vault key kabhi kisi ko na bhejein aur kahin save na karein.
- Deploy ke baad sirf yeh na samjhein ke "push ho gaya to ho gaya" — Dashboard aur Reports khol kar
  check karein.

Deploy aur rollback ka tareeqa: [`operations-runbook.md`](operations-runbook.md).
