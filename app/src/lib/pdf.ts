// §15/§17 Settlement report for the admin: every round's scorecard and the complete ledger, as a PDF.
import type { SessionReport } from './net';

type Col = { h: string; w: number; right?: boolean };

const t2 = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const hm = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const sgn = (n: number) => (n > 0 ? `+${n}` : String(n));
// The built-in PDF fonts only cover Latin text; anything else is replaced so the file never breaks.
const safe = (s: unknown) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?');

export async function settlementPdf(r: SessionReport): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
  let y = M;

  const need = (h: number) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const text = (s: string, size = 10, bold = false, color: [number, number, number] = [30, 30, 30]) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    need(size + 6); doc.text(safe(s), M, y + size); y += size + 6;
  };
  const table = (cols: Col[], rows: (string | number)[][], size = 8) => {
    const total = cols.reduce((a, c) => a + c.w, 0), k = (W - 2 * M) / total, rh = size + 7;
    const head = () => {
      need(rh * 2);
      doc.setFillColor(18, 50, 56); doc.rect(M, y, W - 2 * M, rh, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(255, 255, 255);
      let x = M;
      for (const c of cols) { const cw = c.w * k; doc.text(safe(c.h), c.right ? x + cw - 3 : x + 3, y + size + 2, { align: c.right ? 'right' : 'left' }); x += cw; }
      y += rh;
    };
    head();
    doc.setFont('helvetica', 'normal');
    rows.forEach((row, n) => {
      if (y + rh > H - M) { doc.addPage(); y = M; head(); doc.setFont('helvetica', 'normal'); }
      if (n % 2) { doc.setFillColor(244, 239, 228); doc.rect(M, y, W - 2 * M, rh, 'F'); }
      doc.setTextColor(30, 30, 30); doc.setFontSize(size);
      let x = M;
      cols.forEach((c, i) => {
        const cw = c.w * k;
        const v = doc.splitTextToSize(safe(row[i]), cw - 6)[0] ?? '';
        doc.text(v, c.right ? x + cw - 3 : x + 3, y + size + 2, { align: c.right ? 'right' : 'left' });
        x += cw;
      });
      y += rh;
    });
    y += 8;
  };

  // Header
  doc.setFillColor(11, 18, 32); doc.rect(0, 0, W, 70, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(244, 163, 0); doc.text('DANKA CLUB', M, 34);
  doc.setFontSize(11); doc.setTextColor(245, 239, 227); doc.text('Settlement report', M, 52);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(`Room ${r.code}  |  Started ${t2(r.createdAt)}  |  Generated ${t2(Date.now())}`, W - M, 52, { align: 'right' });
  y = 86;
  text('Virtual coins only. Coins have no cash value and cannot be bought, sold or withdrawn.', 8, false, [110, 110, 110]);
  text(`Games ${r.games}   Total pot ${r.totalPot}   Bonuses ${r.totalBonus}   Well Cuts ${r.wellCuts}   Bank loans ${r.bankLoans}`, 11, true);
  y += 4;

  // Final balances
  text('Balances', 13, true, [18, 50, 56]);
  const everyone = [...r.players.map((p) => ({ ...p, left: false })), ...r.departed];
  table(
    [{ h: 'Player', w: 4 }, { h: 'Balance', w: 2, right: true }, { h: 'Initial', w: 2, right: true }, { h: 'Bank owed', w: 2, right: true },
      { h: 'Owes players', w: 2.4, right: true }, { h: 'Owed to them', w: 2.4, right: true }, { h: 'Net', w: 2, right: true }, { h: 'Status', w: 2.6 }],
    everyone.map((p) => [p.name, p.balance, p.initial, p.outstandingLoan, p.owesPlayers, p.owedByPlayers, sgn(p.net), p.left ? 'Left' : p.eliminated ? 'No coins' : 'Playing']),
    9,
  );
  text('Net = balance - 100 starting coins - bank loan - owed to players + owed by players.', 8, false, [110, 110, 110]);
  y += 6;

  // Player-to-player loans
  text('Player loans (who owes whom)', 13, true, [18, 50, 56]);
  if (r.loans.length) table([{ h: 'Borrower', w: 4 }, { h: 'Owes', w: 1.4 }, { h: 'Lender', w: 4 }, { h: 'Amount', w: 2, right: true }],
    r.loans.map((l) => [l.borrowerName, 'owes', l.lenderName, l.amount]), 9);
  else text('None.', 9);
  y += 4;
  if (r.loanLog.length) {
    text('Every player loan', 11, true, [18, 50, 56]);
    table([{ h: 'Time', w: 1.6 }, { h: 'Game', w: 1.2, right: true }, { h: 'Lender', w: 4 }, { h: 'Borrower', w: 4 }, { h: 'Amount', w: 2, right: true }],
      r.loanLog.map((l) => [hm(l.at), l.game, l.lender, l.borrower, l.amount]), 8);
  }
  y += 6;

  // Player statistics
  text('Player statistics (whole tournament)', 13, true, [18, 50, 56]);
  table(
    [{ h: 'Player', w: 4 }, { h: 'Games', w: 1.6, right: true }, { h: 'Received', w: 2, right: true }, { h: 'Paid', w: 2, right: true },
      { h: 'Won', w: 2, right: true }, { h: 'Lost', w: 2, right: true }, { h: 'Bonus+', w: 2, right: true }, { h: 'Bonus-', w: 2, right: true }, { h: 'Bank loans', w: 2.2, right: true }],
    everyone.map((p) => [p.name, p.games, p.received, p.paid, p.winnings, p.losses, p.bonusIn, p.bonusOut, p.loanTotal]),
  );

  // Every game
  const games = r.scorecards.filter((c) => c.kind === 'game').flatMap((c) => c.results);
  const breaks = r.scorecards.filter((c) => c.kind === 'placecut');
  need(80);
  text(`Game by game (${games.length})`, 13, true, [18, 50, 56]);
  table(
    [{ h: 'Game', w: 1.4 }, { h: 'Time', w: 1.6 }, { h: 'Cards', w: 2 }, { h: 'Winner', w: 4 }, { h: 'Pot', w: 1.6, right: true }, { h: 'Bonus', w: 1.6, right: true }, { h: 'How', w: 2.6 }],
    games.map((g) => [g.game, hm(g.at), g.wellCutGame ? `${g.cardsEach} (WC ${g.wellCutGame}/4)` : g.cardsEach, g.winner, g.pot, g.bonus || '', g.reason === 'show' ? 'Show' : 'Others packed']),
  );

  // Each Placecut
  for (const c of breaks) {
    need(120);
    text(`Placecut ${c.period} - after game ${c.round} - ${t2(c.at)}`, 12, true, [18, 50, 56]);
    table(
      [{ h: 'Player', w: 4 }, { h: 'Balance', w: 2, right: true }, { h: 'This period', w: 2.2, right: true }, { h: 'Bank owed', w: 2, right: true },
        { h: 'Owes players', w: 2.2, right: true }, { h: 'Owed to them', w: 2.2, right: true }, { h: 'Net', w: 2, right: true }],
      c.rows.map((p) => [p.name, p.balance, sgn(p.periodChange), p.outstandingLoan, p.owesPlayers, p.owedByPlayers, sgn(p.net)]),
    );
  }


  // Ledger
  doc.addPage(); y = M;
  text(`Complete ledger (${r.ledger.length} transactions)`, 13, true, [18, 50, 56]);
  table(
    [{ h: '#', w: 1.2, right: true }, { h: 'Time', w: 1.5 }, { h: 'Rd', w: 0.8, right: true }, { h: 'Game', w: 1, right: true }, { h: 'Player', w: 3 },
      { h: 'Type', w: 2 }, { h: 'Amount', w: 1.6, right: true }, { h: 'Balance', w: 1.6, right: true }, { h: 'Note', w: 6 }],
    r.ledger.map((t) => [t.id, hm(t.at), t.round, t.game, t.name, ({ p2p_in: 'borrowed', p2p_out: 'lent', pot_win: 'pot won', bonus_in: 'bonus in', bonus_out: 'bonus out', eliminated: 'sat out' } as Record<string, string>)[t.type] ?? t.type, t.amount ? sgn(t.amount) : '', t.balance, t.note ?? '']),
    7,
  );

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(7); doc.setTextColor(140, 140, 140);
    doc.text(`DANKA CLUB  |  Room ${r.code}  |  Page ${i} of ${pages}`, W / 2, H - 16, { align: 'center' });
  }
  return doc.output('blob');
}

/** Save or share the PDF (share sheet on phones, download on computers). */
export async function deliverPdf(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title: 'DANKA CLUB settlement' }); return; } catch { /* cancelled: fall back to download */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
