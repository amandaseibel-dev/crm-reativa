import { useEffect, useState, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";
import jsPDF from "jspdf";
import { supabase } from "../supabaseClient";
import { cartao } from "../ui/cards";

const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const NUM = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const DIA = (d) => {
  if (!d) return "-";
  const [, m, dd] = String(d).slice(0, 10).split("-");
  return `${dd}/${m}`;
};

export default function MensalidadesSemNegociacao() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const areaRef = useRef(null);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase.rpc("relatorio_mensalidades_2026_1_sem_negociacao");
    if (error) setErro(error.message || "Erro ao carregar o relatório.");
    else { setDados(data); setErro(""); }
    setCarregando(false);
  }

  async function atualizar() {
    setAtualizando(true);
    const { error } = await supabase.rpc("relatorio_mensalidades_2026_1_capturar");
    if (error) setErro(error.message || "Erro ao atualizar.");
    await carregar();
    setAtualizando(false);
  }

  useEffect(() => { carregar(); }, []);

  async function carregarLogo() {
    try {
      const resp = await fetch("/logo_padrao_email.png");
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res(null);
        fr.readAsDataURL(blob);
      });
    } catch { return null; }
  }

  async function exportarPDF() {
    if (!dados) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
    const BLUE = [37, 99, 235], INK = [31, 41, 55], MUT = [107, 114, 128], LINE = [229, 231, 235], SOFT = [244, 246, 250], SOFTBLUE = [232, 238, 246];
    let y = 0;
    const need = (h) => { if (y + h > PH - 46) { doc.addPage(); y = 48; } };

    // Cabeçalho
    doc.setFillColor(...BLUE); doc.rect(0, 0, PW, 5, "F");
    y = 30;
    const logo = await carregarLogo();
    let logoH = 0;
    if (logo) { const lw = 128, lh = (128 * 150) / 356; logoH = lh; try { doc.addImage(logo, "PNG", M, y, lw, lh); } catch { /* sem logo */ } }
    y += (logoH || 40) + 16;
    doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(...INK);
    doc.text("Mensalidades de 2026/1 ainda sem negociação", M, y);
    y += 15;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUT);
    doc.text("Alunos com mensalidades vencidas entre janeiro e junho de 2026 (por data de vencimento).", M, y);
    y += 22;

    // KPIs
    const gap = 10;
    const kpis = [
      ["ALUNOS ÚNICOS", NUM(dados.alunos_unicos_semestre)],
      ["CPFs", NUM(dados.cpfs_semestre)],
      ["MENSALIDADES", NUM(dados.mensalidades_total)],
      ["SALDO TOTAL", BRL(dados.saldo_total)],
    ];
    const kw = (CW - 3 * gap) / 4, kh = 54;
    kpis.forEach((k, i) => {
      const x = M + i * (kw + gap);
      doc.setFillColor(...(i === 0 ? SOFTBLUE : SOFT)); doc.roundedRect(x, y, kw, kh, 7, 7, "F");
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...MUT);
      doc.text(k[0], x + 10, y + 17);
      doc.setFont("helvetica", "bold"); doc.setFontSize(k[1].length > 12 ? 11 : 14); doc.setTextColor(...INK);
      doc.text(k[1], x + 10, y + 38);
    });
    y += kh + 22;

    // Gráfico (barras com valores visíveis)
    const meses = dados.meses || [];
    const totS = Number(dados.saldo_total) || 0;
    const pct = (v) => (totS ? ((Number(v) || 0) / totS * 100).toFixed(1) + "%" : "-");
    const chH = 196; need(chH + 10);
    doc.setDrawColor(...LINE); doc.roundedRect(M, y, CW, chH, 8, 8, "S");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK);
    doc.text("Alunos únicos por mês (vencimento jan–jun/2026)", M + 14, y + 22);
    const cx = M + 16, cw = CW - 32, cTop = y + 40, cBottom = y + chH - 42, cArea = cBottom - cTop;
    const maxA = Math.max(1, ...meses.map((m) => Number(m.alunos_unicos) || 0));
    const n = meses.length || 6, slot = cw / n, bw = slot * 0.5;
    meses.forEach((m, i) => {
      const a = Number(m.alunos_unicos) || 0, h = (a / maxA) * cArea;
      const x = cx + i * slot + (slot - bw) / 2, yb = cBottom - h;
      doc.setFillColor(...BLUE); doc.roundedRect(x, yb, bw, Math.max(h, 1.5), 3, 3, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...INK);
      doc.text(NUM(a), x + bw / 2, yb - 5, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...INK);
      doc.text(m.mes_nome, x + bw / 2, cBottom + 14, { align: "center" });
      doc.setFontSize(7); doc.setTextColor(...MUT);
      doc.text(BRL(m.saldo_sem_negociacao), x + bw / 2, cBottom + 23, { align: "center" });
      doc.setFont("helvetica", "bold"); doc.setTextColor(...BLUE);
      doc.text(pct(m.saldo_sem_negociacao), x + bw / 2, cBottom + 32, { align: "center" });
    });
    doc.setDrawColor(...LINE); doc.line(cx, cBottom, cx + cw, cBottom);
    y += chH + 20;

    // Destaques (chips)
    const d = dados.destaques || {};
    const chips = [
      ["CURSO + INADIMPLÊNCIA", d.curso_maior_inadimplencia?.curso, d.curso_maior_inadimplencia && BRL(d.curso_maior_inadimplencia.saldo)],
      ["UNIDADE + INADIMPLÊNCIA", d.unidade_maior_inadimplencia?.unidade, d.unidade_maior_inadimplencia && BRL(d.unidade_maior_inadimplencia.saldo)],
      ["MÊS + INADIMPLÊNCIA", d.mes_maior_inadimplencia?.mes_nome, d.mes_maior_inadimplencia && BRL(d.mes_maior_inadimplencia.saldo_sem_negociacao)],
      ["FAIXA + SALDO", d.faixa_maior_saldo?.faixa, d.faixa_maior_saldo && BRL(d.faixa_maior_saldo.saldo)],
    ];
    need(74);
    const cw2 = (CW - 3 * gap) / 4, ch2 = 62;
    chips.forEach((c, i) => {
      const x = M + i * (cw2 + gap);
      doc.setDrawColor(...LINE); doc.roundedRect(x, y, cw2, ch2, 7, 7, "S");
      doc.setFillColor(...BLUE); doc.rect(x, y + 7, 3, ch2 - 14, "F");
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(...MUT);
      doc.text(c[0], x + 10, y + 15);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...INK);
      doc.text(doc.splitTextToSize(c[1] || "-", cw2 - 18), x + 10, y + 30);
      if (c[2]) { doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...BLUE); doc.text(c[2], x + 10, y + 54); }
    });
    y += ch2 + 16;

    // Maior concentração de inadimplentes (unidade com mais alunos)
    const concU = [...(dados.por_unidade || [])].sort((a, b) => (Number(b.alunos) || 0) - (Number(a.alunos) || 0))[0];
    if (concU) {
      need(30);
      doc.setFillColor(...SOFTBLUE); doc.roundedRect(M, y, CW, 26, 6, 6, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...INK);
      doc.text("Maior concentração de inadimplentes: " + concU.unidade, M + 12, y + 16);
      doc.setFont("helvetica", "normal"); doc.setTextColor(...MUT);
      doc.text(`${NUM(concU.alunos)} alunos · ${NUM(concU.mensalidades)} mensalidades · ${BRL(concU.saldo)}`, PW - M - 12, y + 16, { align: "right" });
      y += 40;
    }

    // Tabelas
    const tabela = (titulo, cabec, linhas, aligns) => {
      need(46);
      doc.setFillColor(...BLUE); doc.rect(M, y - 9, 3, 13, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...INK);
      doc.text(titulo, M + 10, y);
      y += 10;
      const ncol = cabec.length, labelW = CW * 0.40, numW = (CW - labelW) / (ncol - 1);
      const colX = (i) => (i === 0 ? M + 6 : M + labelW + i * numW - 6);
      doc.setFillColor(...SOFT); doc.rect(M, y, CW, 18, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...MUT);
      cabec.forEach((c, i) => doc.text(c, colX(i), y + 12, { align: aligns[i] }));
      y += 18;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...INK);
      linhas.forEach((l, r) => {
        need(16);
        if (r % 2 === 1) { doc.setFillColor(...SOFT); doc.rect(M, y, CW, 15, "F"); }
        l.forEach((cel, i) => {
          const t = i === 0 ? doc.splitTextToSize(String(cel), labelW - 12)[0] : String(cel);
          doc.text(t, colX(i), y + 11, { align: aligns[i] });
        });
        y += 15;
      });
      y += 18;
    };

    const A6 = ["left", "right", "right", "right", "right", "right"];
    const A4 = ["left", "right", "right", "right"];
    tabela("Detalhamento por mês", ["Mês", "CPFs", "Alunos", "Mensalidades", "Saldo", "% saldo"],
      meses.map((m) => [m.mes_nome, NUM(m.cpfs), NUM(m.alunos_unicos), NUM(m.mensalidades_sem_negociacao), BRL(m.saldo_sem_negociacao), pct(m.saldo_sem_negociacao)]), A6);
    tabela("Por curso", ["Curso", "Alunos", "Mensalidades", "Saldo"],
      (dados.por_curso || []).map((c) => [c.curso, NUM(c.alunos), NUM(c.mensalidades), BRL(c.saldo)]), A4);
    tabela("Por unidade (campus)", ["Unidade", "Alunos", "Mensalidades", "Saldo"],
      (dados.por_unidade || []).map((u) => [u.unidade, NUM(u.alunos), NUM(u.mensalidades), BRL(u.saldo)]), A4);
    tabela("Por faixa de saldo", ["Faixa", "Alunos", "Mensalidades", "Saldo"],
      (dados.por_faixa || []).map((f) => [f.faixa, NUM(f.alunos), NUM(f.mensalidades), BRL(f.saldo)]), A4);

    // Rodapé em todas as páginas
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setDrawColor(...LINE); doc.line(M, PH - 34, PW - M, PH - 34);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...MUT);
      doc.text("Base Reativa · por data de vencimento (pode incluir antecipadas de 2026/2). Não contempla Prime.", M, PH - 22);
      doc.text("Gerado em " + new Date().toLocaleString("pt-BR"), M, PH - 13);
      doc.text(`Página ${p}/${pages}`, PW - M, PH - 13, { align: "right" });
    }

    doc.save(`relatorio-2026-1-sem-negociacao_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  if (carregando) return <div style={{ padding: 24 }}>Carregando…</div>;
  if (erro) return <div style={{ padding: 24, color: "#b91c1c" }}>{erro}</div>;
  if (!dados) return null;

  const meses = (dados.meses || []).map((m) => ({ ...m, label: m.mes_nome, qtd: Number(m.alunos_unicos) || 0 }));
  const evolucao = (dados.evolucao_diaria || []).map((e) => ({ ...e, label: DIA(e.dia), saldoNum: Number(e.saldo) || 0 }));
  const d = dados.destaques || {};
  const totSaldo = Number(dados.saldo_total) || 0;
  const pctSaldo = (v) => (totSaldo ? ((Number(v) || 0) / totSaldo * 100).toFixed(1) + "%" : "-");
  const concUnidade = [...(dados.por_unidade || [])].sort((a, b) => (Number(b.alunos) || 0) - (Number(a.alunos) || 0))[0];

  const TipMes = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const m = payload[0].payload;
    return (
      <div style={tipBox}>
        <strong>{m.mes_nome}</strong>
        <div>Alunos únicos: {NUM(m.alunos_unicos)}</div>
        <div>Mensalidades: {NUM(m.mensalidades_sem_negociacao)}</div>
        <div>Saldo do mês: {BRL(m.saldo_sem_negociacao)}</div>
        <div>% do saldo total: {pctSaldo(m.saldo_sem_negociacao)}</div>
      </div>
    );
  };
  const TipDia = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const e = payload[0].payload;
    return (
      <div style={tipBox}>
        <strong>{DIA(e.dia)}</strong>
        <div>Saldo: {BRL(e.saldo)}</div>
        <div>Mensalidades: {NUM(e.mensalidades)}</div>
        <div>Alunos: {NUM(e.alunos)}</div>
      </div>
    );
  };

  return (
    <div ref={areaRef} style={{ padding: 24, maxWidth: 1040, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            Alunos com mensalidades vencidas entre janeiro e junho de 2026 ainda sem negociação
          </h1>
          <p style={{ color: "#6b7280", marginTop: 0, marginBottom: 0, maxWidth: 760 }}>
            Visão baseada na data de vencimento registrada na Base Reativa. Pode incluir mensalidades
            ou matrículas antecipadas referentes a 2026/2. Não contempla o status de matrícula ou
            rematrícula registrado no Prime.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={atualizar} disabled={atualizando} style={btnPrimary}>
            {atualizando ? "Atualizando…" : "↻ Atualizar"}
          </button>
          <button onClick={exportarPDF} style={btnGhost}>⬇ Exportar PDF</button>
        </div>
      </div>

      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <Tot label="Alunos únicos sem negociação" val={NUM(dados.alunos_unicos_semestre)} accent />
        <Tot label="CPFs sem negociação" val={NUM(dados.cpfs_semestre)} />
        <Tot label="Mensalidades sem negociação" val={NUM(dados.mensalidades_total)} />
        <Tot label="Saldo total sem negociação" val={BRL(dados.saldo_total)} />
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        <Destaque titulo="Curso de maior inadimplência" valor={d.curso_maior_inadimplencia?.curso} sub={d.curso_maior_inadimplencia && BRL(d.curso_maior_inadimplencia.saldo)} />
        <Destaque titulo="Unidade de maior inadimplência" valor={d.unidade_maior_inadimplencia?.unidade} sub={d.unidade_maior_inadimplencia && BRL(d.unidade_maior_inadimplencia.saldo)} />
        <Destaque titulo="Mês de maior inadimplência" valor={d.mes_maior_inadimplencia?.mes_nome} sub={d.mes_maior_inadimplencia && BRL(d.mes_maior_inadimplencia.saldo_sem_negociacao)} />
        <Destaque titulo="Faixa de maior saldo" valor={d.faixa_maior_saldo?.faixa} sub={d.faixa_maior_saldo && BRL(d.faixa_maior_saldo.saldo)} />
        <Destaque titulo="Maior concentração de inadimplentes" valor={concUnidade?.unidade} sub={concUnidade && `${NUM(concUnidade.alunos)} alunos · ${BRL(concUnidade.saldo)}`} />
      </div>

      <Secao titulo="Alunos únicos por mês (vencimento jan–jun/2026)">
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={meses} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip content={<TipMes />} />
              <Bar dataKey="qtd" radius={[4, 4, 0, 0]}>
                {meses.map((_, i) => (<Cell key={i} fill="#2563eb" />))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Secao>

      <Secao titulo="Detalhamento por mês">
        <Tabela cabec={["Mês", "CPFs", "Alunos únicos", "Mensalidades", "Saldo", "% do saldo"]}
          linhas={(dados.meses || []).map((m) => [m.mes_nome, NUM(m.cpfs), NUM(m.alunos_unicos), NUM(m.mensalidades_sem_negociacao), BRL(m.saldo_sem_negociacao), pctSaldo(m.saldo_sem_negociacao)])} />
      </Secao>

      <Secao titulo="Evolução diária (conforme as baixas)">
        {evolucao.length <= 1 ? (
          <p style={{ color: "#6b7280", margin: 0 }}>
            A curva de evolução começa hoje e cresce a cada atualização diária. Clique em <b>Atualizar</b> uma vez por dia para registrar o ponto do dia.
          </p>
        ) : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <LineChart data={evolucao} margin={{ top: 10, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" />
                <YAxis tickFormatter={(v) => "R$ " + (v / 1000000).toFixed(1) + "M"} width={70} />
                <Tooltip content={<TipDia />} />
                <Line type="monotone" dataKey="saldoNum" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Secao>

      <Secao titulo="Por curso">
        <Tabela cabec={["Curso", "Alunos", "Mensalidades", "Saldo"]}
          linhas={(dados.por_curso || []).map((c) => [c.curso, NUM(c.alunos), NUM(c.mensalidades), BRL(c.saldo)])} />
      </Secao>

      <Secao titulo="Por unidade (campus)">
        <Tabela cabec={["Unidade", "Alunos", "Mensalidades", "Saldo"]}
          linhas={(dados.por_unidade || []).map((u) => [u.unidade, NUM(u.alunos), NUM(u.mensalidades), BRL(u.saldo)])} />
      </Secao>

      <Secao titulo="Por faixa de saldo da mensalidade">
        <Tabela cabec={["Faixa", "Alunos", "Mensalidades", "Saldo"]}
          linhas={(dados.por_faixa || []).map((f) => [f.faixa, NUM(f.alunos), NUM(f.mensalidades), BRL(f.saldo)])} />
      </Secao>

      <p style={{ marginTop: 16, color: "#6b7280", fontSize: 13 }}>
        O relatório considera a data de vencimento dos títulos. Por esse motivo, pode incluir
        mensalidades ou matrículas antecipadas referentes ao período acadêmico 2026/2. No total
        consolidado, cada aluno é contado uma única vez. Atualizado em{" "}
        {dados.atualizado_em ? new Date(dados.atualizado_em).toLocaleString("pt-BR") : "-"}.
      </p>
    </div>
  );
}

const tipBox = cartao;
const btnPrimary = { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "9px 14px", fontWeight: 600, cursor: "pointer" };
const btnGhost = { background: "#fff", color: "#2563eb", border: "1px solid #2563eb", borderRadius: 8, padding: "9px 14px", fontWeight: 600, cursor: "pointer" };

function Tot({ label, val, accent }) {
  return (
    <div style={{ border: accent ? "1px solid transparent" : "1px solid #e5e7eb", background: accent ? "#e8eef6" : "transparent", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
    </div>
  );
}
function Destaque({ titulo, valor, sub }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 11.5, letterSpacing: ".03em", textTransform: "uppercase", color: "#6b7280" }}>{titulo}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{valor || "-"}</div>
      {sub && <div style={{ fontSize: 13, color: "#374151" }}>{sub}</div>}
    </div>
  );
}
function Secao({ titulo, children }) {
  return (
    <div style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 10px" }}>{titulo}</h2>
      {children}
    </div>
  );
}
function Tabela({ cabec, linhas }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead>
          <tr>{cabec.map((c, i) => (
            <th key={i} style={{ textAlign: i === 0 ? "left" : "right", padding: "8px 10px", borderBottom: "2px solid #e5e7eb", color: "#6b7280", fontWeight: 600, whiteSpace: "nowrap" }}>{c}</th>
          ))}</tr>
        </thead>
        <tbody>
          {linhas.map((l, r) => (
            <tr key={r}>{l.map((cel, i) => (
              <td key={i} style={{ textAlign: i === 0 ? "left" : "right", padding: "7px 10px", borderBottom: "1px solid #f1f5f9", fontVariantNumeric: "tabular-nums" }}>{cel}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
