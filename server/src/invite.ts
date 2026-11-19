/** The page a WhatsApp invite link opens. It tries the app first, then shows the code to type in. */
export function invitePage(code: string | null): string {
  const title = code ? `Join my DANKA CLUB table: ${code}` : 'DANKA CLUB invite';
  const body = code
    ? `<p class="lead">You're invited to a private table.</p>
       <div class="code">${code}</div>
       <a class="btn" href="dankaclub://join/${code}">Open in DANKA CLUB</a>
       <p class="small">If the app doesn't open, open DANKA CLUB, tap <b>Join Room</b> and type the code above.</p>`
    : `<p class="lead">This invite link isn't valid. Ask your friend to share the room code again.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="Private 7-player table. Coins have no cash value.">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B1220;color:#F5EFE3;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:360px;padding:32px 24px;text-align:center}
h1{font-size:34px;letter-spacing:.06em;margin:0 0 8px;color:#E2B865}
.lead{color:#9AA6BC;margin:0 0 20px}
.code{font-size:44px;font-weight:800;letter-spacing:.14em;color:#F4A300;margin:0 0 22px}
.btn{display:block;padding:16px;border-radius:16px;background:linear-gradient(135deg,#F4A300,#C8963E);color:#1A1206;font-weight:800;text-decoration:none}
.small{font-size:13px;color:#9AA6BC;margin-top:18px;line-height:1.5}
</style></head><body><main><h1>DANKA CLUB</h1>${body}<p class="small">Coins have no cash value.</p></main>
${code ? `<script>setTimeout(function(){location.href="dankaclub://join/${code}"},300)</script>` : ''}
</body></html>`;
}
