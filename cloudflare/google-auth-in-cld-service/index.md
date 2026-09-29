---
title: "Google Login in Front of Cloudflare Workers, Pages, and Other Services"
date: 2026-09-29
draft: true 
tags: ["auth", "google", "cloudflare"]
categories: ["Tech"]
viewMode: docs
---


This guide documents a practical setup for putting **Google authentication in front of Cloudflare-hosted applications** using **Cloudflare Zero Trust / Access**.

The important idea is that **Google handles authentication, while Cloudflare Access handles authorization**.

You do not need to implement Google OAuth inside every Worker or frontend application.

> **Architecture:**
> Google → Cloudflare Access → Worker / Pages / application

Cloudflare Access can act as an identity-aware proxy in front of web applications, and Access policies determine which authenticated users are allowed through. ([Cloudflare Docs][1])

---

## 1. What we are building

Suppose you have:

```text
stats.inxeoz.com
```

and want only selected Google accounts to access it.

The final architecture is:

```text
                    ┌─────────────────────┐
                    │     Google OAuth    │
                    │                     │
                    │ Google account      │
                    │ authentication      │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Cloudflare Access  │
                    │                     │
                    │ Identity Provider   │
                    │ + Access Policies   │
                    └──────────┬──────────┘
                               │
                    Allowed user?
                       /           \
                     YES            NO
                      │              │
                      ▼              ▼
             ┌──────────────┐    BLOCK
             │ Worker/Pages │
             │ Application  │
             └──────────────┘
```

For example:

```text
Google account:
pk9009895om@gmail.com

        ↓

Cloudflare Access

        ↓

Policy:
Email = pk9009895om@gmail.com
AND
Login Method = Google

        ↓

ALLOW

        ↓

stats.inxeoz.com
```

Cloudflare's Google integration works without requiring Google Workspace; users authenticate with Google accounts, and Cloudflare Access policies determine whether they can reach the protected resource. ([Cloudflare Docs][2])

---

# 2. Why use Cloudflare Access instead of implementing Google OAuth yourself?

Without Access, you might build:

```text
Frontend
   ↓
Your OAuth implementation
   ↓
Google
   ↓
Callback
   ↓
Session management
   ↓
Cookies/JWT
   ↓
Authorization
```

You would then need to maintain:

* OAuth configuration
* callback handling
* session cookies
* token validation
* user authorization
* login/logout behavior
* session expiration
* access revocation
* security fixes

With Cloudflare Access:

```text
Browser
   ↓
Cloudflare Access
   ↓
Google
   ↓
Cloudflare Access policy
   ↓
Your application
```

Your application can therefore concentrate on application logic.

Cloudflare describes Access as an identity-aware proxy that checks requests against Access policies before forwarding them to the application. ([Cloudflare Docs][1])

---

# 3. Prerequisites

You need:

* A Cloudflare account
* A domain managed by Cloudflare
* Cloudflare Zero Trust enabled
* A Google account
* A Google Cloud project
* A Cloudflare Access application
* An application to protect

The application could be:

```text
Cloudflare Worker
Cloudflare Pages
Worker + custom domain
Cloudflare Tunnel application
Self-hosted application
```

Cloudflare's self-hosted application model can protect public hostnames, private applications, and Workers. ([Cloudflare Docs][3])

---

# 4. Create the Google OAuth application

Open Google Cloud Console:

[Google Cloud Console](https://console.cloud.google.com/?utm_source=chatgpt.com)

Create a project.

For example:

```text
Project name:
inxeoz-cloudflare-auth
```

Then open:

```text
APIs & Services
    ↓
Credentials
```

Configure the OAuth consent screen.

---

# 5. Configure OAuth consent screen

Choose:

```text
Audience:
External
```

Cloudflare's current Google IdP documentation uses an **External** OAuth application for this integration. ([Cloudflare Docs][2])

Enter your application information:

```text
App name:
Inxeoz Cloudflare Access

User support email:
your-email@gmail.com

Developer/contact email:
your-email@gmail.com
```

Then create/save the consent configuration.

---

# 6. Create the OAuth Client

Go to:

```text
APIs & Services
    ↓
Credentials
    ↓
Create OAuth client
```

Select:

```text
Application type:
Web application
```

Cloudflare's current instructions specifically require a Web application OAuth client. ([Cloudflare Docs][2])

For example:

```text
Name:
Cloudflare Access
```

---

# 7. Authorized JavaScript origins

This part is important.

Do **not** put your application hostname here.

For Cloudflare Access, use your **Cloudflare Access team domain**.

For example, if your team domain is:

```text
inxeoz.cloudflareaccess.com
```

use:

```text
Authorized JavaScript origins:

https://inxeoz.cloudflareaccess.com
```

Cloudflare's current Google documentation explicitly specifies:

```text
https://<your-team-name>.cloudflareaccess.com
```

as the authorized JavaScript origin. ([Cloudflare Docs][2])

---

# 8. Authorized redirect URI

Add:

```text
https://inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
```

The general format is:

```text
https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback
```

Cloudflare documents this exact callback format for the Google integration. ([Cloudflare Docs][2])

So your Google configuration looks like:

```text
Authorized JavaScript origins

https://inxeoz.cloudflareaccess.com
```

and:

```text
Authorized redirect URIs

https://inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
```

### Important

Your application might be:

```text
stats.inxeoz.com
```

but the OAuth configuration is:

```text
inxeoz.cloudflareaccess.com
```

That's intentional.

The browser flow is:

```text
stats.inxeoz.com
       ↓
Cloudflare Access
       ↓
Google
       ↓
inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
       ↓
stats.inxeoz.com
```

---

# 9. Get Client ID and Client Secret

After creating the OAuth client, Google provides:

```text
Client ID
Client Secret
```

Example:

```text
Client ID:
1234567890-xxxxx.apps.googleusercontent.com

Client Secret:
GOCSPX-xxxxxxxxxxxx
```

**Never publish the Client Secret.**

Cloudflare explicitly describes the client secret as functioning like a password. ([Cloudflare Docs][2])

---

# 10. Add Google to Cloudflare Access

Go to:

```text
Cloudflare Dashboard
    ↓
Zero Trust
    ↓
Integrations
    ↓
Identity providers
    ↓
Add new identity provider
    ↓
Google
```

Enter:

```text
Client ID:
<Google Client ID>

Client Secret:
<Google Client Secret>
```

Save it.

Cloudflare also provides a **Test** option beside the Google identity provider. ([Cloudflare Docs][2])

---

# 11. Google OAuth testing mode

If your Google OAuth application is:

```text
External
Testing
```

Google allows you to explicitly specify test users.

For example:

```text
Test users:

pk9009895om@gmail.com
divyanshpratapsingh2004@gmail.com
patelharshithp404@gmail.com
```

This gives you a controlled setup while developing.

The important distinction is:

```text
Google Test users
```

controls who can authorize the OAuth application.

Whereas:

```text
Cloudflare Access policy
```

controls who can access your actual application.

You can therefore have two layers:

```text
Google
  ↓
Can this account use the OAuth application?

Cloudflare Access
  ↓
Can this authenticated account access stats.inxeoz.com?
```

---

# 12. Create the Cloudflare Access application

Go to:

```text
Zero Trust
    ↓
Access controls
    ↓
Applications
    ↓
Create application
```

For a normal website/application, use:

```text
Self-hosted
```

Cloudflare's current application documentation describes self-hosted applications as the general mechanism for resources you control, including public web applications and Workers. ([Cloudflare Docs][3])

---

# 13. Protect a custom hostname

For example:

```text
stats.inxeoz.com
```

Create a self-hosted application with:

```text
Application name:
Stats

Domain:
stats.inxeoz.com
```

Cloudflare then sits in front of that hostname.

The request becomes:

```text
Browser
   ↓
stats.inxeoz.com
   ↓
Cloudflare
   ↓
Access authentication
   ↓
Google
   ↓
Access policy
   ↓
Application
```

---

# 14. Create the Access policy

For your setup, you used:

```text
Action:
Allow
```

### Include

```text
Emails

pk9009895om@gmail.com
divyanshpratapsingh2004@gmail.com
patelharshithp404@gmail.com
```

### Require

```text
Login Method
    Google
```

Conceptually:

```text
ALLOW IF

email ∈ {
    pk9009895om@gmail.com,
    divyanshpratapsingh2004@gmail.com,
    patelharshithp404@gmail.com
}

AND

login_method == Google
```

This is different from:

```text
Authentication Method = SMS
```

The latter is an authentication/MFA requirement; **Login Method → Google** specifies the identity provider used to authenticate.

---

# 15. Result

Now:

### User A

```text
Google:
pk9009895om@gmail.com
```

→ Google authentication succeeds
→ Cloudflare policy matches
→ **Access granted**

### User B

```text
Google:
someone@gmail.com
```

→ Google authentication succeeds
→ Cloudflare email policy does not match
→ **Access denied**

### User C

```text
Allowed email
but another configured login provider
```

→ Email may match
→ Login Method requirement does not match
→ **Access denied**

That's why your policy:

```text
Include:
    3 emails

Require:
    Login Method = Google
```

is useful when you want both restrictions.

---

# 16. Protecting a Cloudflare Worker

Cloudflare now supports directly protecting a Worker with Access.

Go to:

```text
Workers & Pages
    ↓
Your Worker
    ↓
Access
    ↓
Protect this Worker behind Access
```

Cloudflare documents Worker-level Access protection for production, previews, or both. ([Cloudflare Docs][4])

You can choose:

```text
Previews only
```

or:

```text
All traffic
```

For example:

```text
my-worker
    ↓
Access
    ↓
All traffic
    ↓
Google
```

This is different from simply protecting a hostname.

---

# 17. Worker-level protection vs hostname protection

This distinction is important.

Suppose your Worker is:

```text
my-api
```

and has:

```text
my-api.example.workers.dev
api.inxeoz.com
admin.inxeoz.com
```

### Worker-level Access

Protecting the Worker protects the Worker itself across its associated domains/routes.

Cloudflare describes Worker-level protection as covering the Worker's routes, custom domains, `workers.dev` hostname, and previews. ([Cloudflare Docs][4])

### Hostname-level Access

You can instead protect:

```text
admin.inxeoz.com
```

without necessarily protecting:

```text
api.inxeoz.com
```

Cloudflare describes hostname/path-based Access as the appropriate model when only a particular hostname or path should require authentication. ([Cloudflare Docs][4])

---

# 18. Protecting a Worker by hostname

Another useful architecture is:

```text
admin.inxeoz.com
       ↓
Cloudflare Access
       ↓
Worker
```

Create:

```text
Zero Trust
→ Access controls
→ Applications
→ Create application
→ Self-hosted
```

Then:

```text
Application domain:

admin.inxeoz.com
```

This gives you granular control.

For example:

```text
admin.inxeoz.com
    → Google required

api.inxeoz.com
    → public

stats.inxeoz.com
    → Google required
```

This is often useful when one Worker serves multiple routes or hostnames.

---

# 19. Cloudflare Pages

Pages applications can also be protected with Cloudflare Access.

A typical architecture is:

```text
stats.inxeoz.com
       ↓
Cloudflare Access
       ↓
Google
       ↓
Cloudflare Pages
```

You can create an Access application for the Pages hostname.

For example:

```text
stats.inxeoz.com
```

and apply the same reusable Access policy:

```text
allow-just-stats
```

Cloudflare Access policies can be reused across applications. ([Cloudflare Docs][3])

---

# 20. Pages Functions: accessing the logged-in user

There is another layer available when you actually need the user's identity **inside your Pages application**.

Cloudflare provides an official Pages Access plugin:

```text
@cloudflare/pages-plugin-cloudflare-access
```

The plugin validates Cloudflare Access JWT assertions and can expose additional user information. ([Cloudflare Docs][5])

Install:

```bash
bun add @cloudflare/pages-plugin-cloudflare-access
```

Then:

```ts
import cloudflareAccessPlugin from
  "@cloudflare/pages-plugin-cloudflare-access";

export const onRequest =
  cloudflareAccessPlugin({
    domain: "https://inxeoz.cloudflareaccess.com",
    aud: "<ACCESS_APPLICATION_AUDIENCE>",
  });
```

The plugin requires the Cloudflare Access domain and the application's audience (`aud`). ([Cloudflare Docs][5])

This is useful when your application needs to know:

```text
Who is logged in?
```

rather than merely:

```text
Is this user allowed through Access?
```

---

# 21. Worker: getting the logged-in user

Cloudflare has a particularly convenient mechanism for Workers.

When Access authenticates a request directly invoking a Worker, the Worker can access:

```text
ctx.access
```

and:

```text
ctx.access.getIdentity()
```

No manual JWT parsing is required. ([Cloudflare Docs][6])

Example:

```ts
export default {
  async fetch(request, env, ctx) {

    if (!ctx.access) {
      return new Response("Access required", {
        status: 403
      });
    }

    const identity = await ctx.access.getIdentity();

    return Response.json({
      email: identity?.email,
      name: identity?.name
    });
  }
};
```

A successful authenticated request might produce:

```json
{
  "email": "pk9009895om@gmail.com",
  "name": "..."
}
```

Cloudflare states that the identity object can contain information such as email, groups, and device posture. ([Cloudflare Docs][6])

---

# 22. This means you can build user-aware Workers

For example:

```ts
export default {
  async fetch(request, env, ctx) {

    if (!ctx.access) {
      return new Response("Unauthorized", {
        status: 401
      });
    }

    const identity =
      await ctx.access.getIdentity();

    const email = identity?.email;

    if (email === "pk9009895om@gmail.com") {
      return new Response("Admin dashboard");
    }

    return new Response("User dashboard");
  }
};
```

However, there's an architectural distinction:

### Cloudflare Access

handles:

```text
Authentication
Authorization
Session
Identity
```

### Your Worker

handles:

```text
Application-level authorization
Business rules
Data access
Application behavior
```

You can therefore have:

```text
Access:
Who can enter?

Worker:
What can this authenticated person do?
```

---

# 23. Example: role-based application

Suppose you have:

```text
admin.inxeoz.com
```

and:

```text
stats.inxeoz.com
```

You could create:

```text
Google
   ↓
Cloudflare Access
   ↓
┌──────────────────────────────┐
│ Access policies              │
│                              │
│ admin:                       │
│   admin1@gmail.com           │
│                              │
│ stats:                       │
│   admin1@gmail.com           │
│   analyst@gmail.com          │
└──────────────────────────────┘
```

Then your Worker can implement more detailed permissions.

---

# 24. Reusing the same policy

Instead of creating a new policy for every application:

```text
stats.inxeoz.com
admin.inxeoz.com
wiki.inxeoz.com
monitor.inxeoz.com
```

you can create a reusable policy:

```text
allow-google-team
```

containing:

```text
Include:
    team members

Require:
    Login Method = Google
```

Then associate it with multiple Access applications.

Cloudflare explicitly supports reusable Access policies across applications. ([Cloudflare Docs][3])

For example:

```text
allow-google-team
       │
       ├── stats.inxeoz.com
       ├── wiki.inxeoz.com
       ├── admin.inxeoz.com
       └── monitor.inxeoz.com
```

---

# 25. A cleaner setup for your environment

For your `inxeoz.com` infrastructure, you could organize it like this:

```text
Google
   │
   ▼
Cloudflare Access
   │
   ├── stats.inxeoz.com
   │       └── Google + Stats Users
   │
   ├── wiki.inxeoz.com
   │       └── Google + Wiki Users
   │
   ├── admin.inxeoz.com
   │       └── Google + Admin Users
   │
   ├── api.inxeoz.com
   │       └── Service Auth / API authentication
   │
   └── internal.inxeoz.com
           └── Google + Internal Users
```

This separates authentication from each application.

---

# 26. Browser users vs API users

One particularly important concept is that **human login and machine authentication are different problems**.

For a browser:

```text
Browser
   ↓
Google
   ↓
Cloudflare Access
```

For a backend service:

```text
Backend service
   ↓
Cloudflare Access Service Token
   ↓
Worker/API
```

Cloudflare provides **Service Tokens** specifically for automated systems. They use a Client ID and Client Secret rather than an interactive identity-provider login. ([Cloudflare Docs][7])

Example:

```bash
curl \
  -H "CF-Access-Client-Id: $CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
  https://api.inxeoz.com
```

This allows you to have:

```text
Human:
Google → Access

Machine:
Service Token → Access
```

without forcing backend services to perform browser-based Google authentication.

---

# 27. Example complete architecture

For a larger system:

```text
                         INTERNET
                             │
                             ▼
                  ┌────────────────────┐
                  │ Cloudflare         │
                  │                    │
                  │ DNS / CDN / WAF    │
                  └─────────┬──────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │ Cloudflare Access  │
                  │                    │
                  │ Authentication     │
                  │ Authorization      │
                  │ Session            │
                  └───────┬─────┬──────┘
                          │     │
                 Google   │     │ Service Token
                          │     │
                          ▼     ▼
                     Human     Machine
                       │         │
                       └────┬────┘
                            ▼
                   ┌─────────────────┐
                   │ Cloudflare      │
                   │ Workers / Pages │
                   └─────────────────┘
                            │
                            ▼
                     Application
                       backend
```

---

# 28. What Access protects

Think of Cloudflare Access as a gate:

```text
                    ACCESS
                      │
             ┌────────┴────────┐
             │                 │
          Browser           API client
             │                 │
        Google login       Service Token
             │                 │
             └────────┬────────┘
                      ▼
                 Application
```

The application doesn't have to implement the initial authentication mechanism.

---

# 29. Access session

When a user successfully authenticates, Cloudflare maintains an Access session.

Cloudflare uses a `CF_Authorization` cookie for protected HTTP applications. The cookie contains the user's identity as a JWT, and Access checks the cookie on subsequent requests. ([Cloudflare Docs][8])

Conceptually:

```text
First request:

Browser
  ↓
No Access session
  ↓
Google
  ↓
Cloudflare
  ↓
Access session created


Later request:

Browser
  ↓
CF_Authorization
  ↓
Cloudflare Access
  ↓
Application
```

This is why the user doesn't necessarily have to perform the Google login on every request.

---

# 30. Session duration

You can configure the Access policy session duration.

For example:

```text
Session duration:
2 weeks
```

This controls the Access session lifetime according to your Access configuration.

You can use shorter durations for sensitive applications:

```text
Admin:
1 hour / several hours

Internal tools:
1 day

Normal dashboard:
1 week / 2 weeks
```

The appropriate value depends on the sensitivity and operational requirements of the application.

---

# 31. Instant authentication

If an Access application uses only one identity provider, Cloudflare supports **instant authentication**.

Instead of:

```text
Cloudflare login page

[ Google ]
[ GitHub ]
[ Microsoft ]
...
```

the user can be sent directly into the configured identity provider flow.

Cloudflare recommends this when an application is intended to use a single IdP. ([Cloudflare Docs][9])

For your Google-only application:

```text
stats.inxeoz.com
       ↓
Google
       ↓
Cloudflare Access
       ↓
Stats
```

can therefore provide a very clean login experience.

---

# 32. Google OAuth and Cloudflare Access are two separate layers

This is one of the most important concepts.

### Google

Answers:

> "Who is this Google account?"

### Cloudflare Access

Answers:

> "Is this identity allowed to access this application?"

For example:

```text
Google:

email = alice@gmail.com
```

then:

```text
Cloudflare Access:

alice@gmail.com
    ↓
Policy?
    ↓
YES
    ↓
ALLOW
```

Google itself doesn't need to know which Cloudflare application the user is authorized to access.

---

# 33. Common mistake: putting your application URL in JavaScript origins

For example, you might think:

```text
Authorized JavaScript origins:

https://stats.inxeoz.com
```

But Cloudflare's Google IdP setup specifies:

```text
https://<team-name>.cloudflareaccess.com
```

instead. ([Cloudflare Docs][2])

For your setup:

```text
https://inxeoz.cloudflareaccess.com
```

and:

```text
https://inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
```

---

# 34. Common mistake: using SMS as the Google requirement

Don't confuse:

```text
Login Method → Google
```

with:

```text
Authentication Method → SMS
```

If your intention is:

> Users must log in using Google

your policy should use:

```text
Require:

Login Method
    Google
```

not:

```text
Authentication Method
    SMS
```

---

# 35. Common mistake: protecting the application but leaving another route public

Suppose:

```text
stats.inxeoz.com
```

is protected, but you also expose:

```text
stats.example.workers.dev
```

directly.

Depending on how you configured Access, users might have another route to the Worker.

Worker-level Access can be useful when you want the Worker itself protected across its associated routes/domains rather than protecting only one hostname. Cloudflare documents the distinction between hostname/path-based and Worker-level protection. ([Cloudflare Docs][6])

---

# 36. WebSockets

There is an important Worker-specific limitation.

Cloudflare currently notes that **Worker-level Access policies do not support WebSocket connections**. WebSocket upgrade requests can return `403`.

For Workers using WebSockets, Cloudflare recommends hostname-based Access instead. ([Cloudflare Docs][4])

So:

```text
Worker + normal HTTP
    → Worker-level Access is possible

Worker + WebSocket
    → Consider hostname-based Access
```

This matters for applications using:

* Durable Objects
* real-time applications
* WebSocket APIs
* RDP over WebSocket

---

# 37. Local development

You don't necessarily have to perform a real Google login every time you test Worker identity logic.

Cloudflare Workers supports a local `access.dev` configuration for simulating an authenticated Access identity. ([Cloudflare Docs][6])

For example:

```json
{
  "access": {
    "dev": {
      "aud": "my-app",
      "identity": {
        "email": "admin@example.com"
      }
    }
  }
}
```

Then your Worker can test:

```ts
const identity =
  await ctx.access.getIdentity();
```

locally.

Cloudflare documents this as a way to simulate authenticated identities with `wrangler dev`. ([Cloudflare Docs][6])

---

# 38. Security model

The final security model becomes:

```text
                   Google
                     │
                Authentication
                     │
                     ▼
             Cloudflare Access
                     │
             Authorization
                     │
             ┌───────┴────────┐
             │                │
          Browser           Machine
             │                │
        Access cookie    Service Token
             │                │
             └───────┬────────┘
                     ▼
              Worker / Pages
                     │
                     ▼
                 Your app
```

This gives you a clean separation:

| Layer             | Responsibility                    |
| ----------------- | --------------------------------- |
| Google            | User authentication               |
| Cloudflare Access | Access authorization              |
| Access session    | Browser session                   |
| Worker/Pages      | Application logic                 |
| Application       | Fine-grained business permissions |
| Service Tokens    | Machine-to-machine access         |

---

# 39. Recommended structure for `inxeoz.com`

A scalable structure could be:

```text
                         Google
                           │
                           ▼
                   Cloudflare Access
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
 stats.inxeoz.com    wiki.inxeoz.com    admin.inxeoz.com
        │                  │                  │
        ▼                  ▼                  ▼
     Worker              Pages              Worker
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                    Internal APIs
                           │
                           ▼
                    Service Tokens
```

And your policies could be:

```text
policy: stats-users

Include:
    stats users

Require:
    Login Method = Google
```

```text
policy: admins

Include:
    admin users

Require:
    Login Method = Google
```

```text
policy: internal-api

Action:
    Service Auth
```

This lets Cloudflare handle the perimeter while your applications handle their own internal authorization.

---

# 40. Final checklist

For your current Google + Cloudflare setup:

### Google Cloud

```text
OAuth application:
    External

Application type:
    Web application

Authorized JavaScript origins:
    https://inxeoz.cloudflareaccess.com

Authorized redirect URI:
    https://inxeoz.cloudflareaccess.com/cdn-cgi/access/callback
```

These values match Cloudflare's current Google IdP documentation. ([Cloudflare Docs][2])

### Cloudflare

```text
Zero Trust
  ↓
Integrations
  ↓
Identity providers
  ↓
Google
```

Configured with:

```text
Client ID
Client Secret
```

### Access application

```text
Application type:
Self-hosted
```

Example:

```text
stats.inxeoz.com
```

### Policy

```text
Action:
Allow

Include:
    allowed Google emails

Require:
    Login Method → Google
```

### Result

```text
https://stats.inxeoz.com
            │
            ▼
     Cloudflare Access
            │
            ▼
        Google Login
            │
            ▼
      Access Policy
            │
       ┌────┴────┐
       │         │
     match     no match
       │         │
       ▼         ▼
     ALLOW      BLOCK
       │
       ▼
 Worker / Pages / App
```

---

## Official references

* [Cloudflare — Google Identity Provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/?utm_source=chatgpt.com)
* [Cloudflare — Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/?utm_source=chatgpt.com)
* [Cloudflare — Access for Pages](https://developers.cloudflare.com/pages/functions/plugins/cloudflare-access/?utm_source=chatgpt.com)
* [Cloudflare — Choose an Access application type](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/?utm_source=chatgpt.com)
* [Cloudflare — Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/?utm_source=chatgpt.com)

**In short:** you only configure Google OAuth **once** as a Cloudflare Access identity provider. After that, you can put the same Google-backed Access model in front of Workers, Pages, custom hostnames, Tunnel applications, and other web services, while keeping application-level authorization inside your Workers/Pages code. ([Cloudflare Docs][3])

[1]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/?utm_source=chatgpt.com "Add web applications · Cloudflare One docs"
[2]: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/ "Google · Cloudflare One docs"
[3]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/?utm_source=chatgpt.com "Choose an application type · Cloudflare One docs"
[4]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/?utm_source=chatgpt.com "Cloudflare Access · Cloudflare Workers docs"
[5]: https://developers.cloudflare.com/pages/functions/plugins/cloudflare-access/?utm_source=chatgpt.com "Cloudflare Access · Cloudflare Pages docs"
[6]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/ "Cloudflare Access · Cloudflare Workers docs"
[7]: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/?utm_source=chatgpt.com "Service tokens · Cloudflare One docs"
[8]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/?utm_source=chatgpt.com "Authorization cookie · Cloudflare One docs"
[9]: https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/?utm_source=chatgpt.com "Create an Access application · Cloudflare Learning Paths"
