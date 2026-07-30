import { useEffect, useState, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";
import jsPDF from "jspdf";
import { supabase } from "../supabaseClient";

const BRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const NUM = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const DIA = (d) => {
  if (!d) return "-";
  const [a, m, dd] = String(d).slice(0, 10).split("-");
  return `${dd}/${m}`;
};

// Relatório da diretoria (ao vivo): mensalidades originais de jan–jun/2026 ainda sem
// negociação, por data de vencimento. RPC read-only + captura de snapshot diário.
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
    // registra o ponto do dia (snapshot) e recarrega a leitura ao vivo
    const { error } = await supabase.rpc("relatorio_mensalidades_2026_1_capturar");
    if (error) setErro(error.message || "Erro ao atualizar.");
    await carregar();
    setAtualizando(false);
  }

  useEffect(() => { carregar(); }, []);

  function exportarPDF() {
    if (!dados) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const M = 40;
    let y = 48;
    doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text("Alunos com mensalidades vencidas entre jan e jun/2026 sem negociação", M, y);
    y += 18;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
    doc.text("Base Reativa · por data de vencimento (pode incluir antecipadas de 2026/2). Não contempla Prime.", M, y);
    doc.text("Gerado em " + new Date().toLocaleString("pt-BR"), M, y + 12);
    doc.setTextColor(20); y += 40;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("Consolidado do semestre", M, y); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text(`Alunos únicos: ${NUM(dados.alunos_unicos_semestre)}   |   CPFs: ${NUM(dados.cpfs_semestre)}   |   Mensalidades: ${NUM(dados.mensalidades_total)}   |   Saldo: ${BRL(dados.saldo_total)}`, M, y);
    y += 26;

    const linha = (cols, xs, bold) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(9);
      cols.forEach((c, i) => doc.text(String(c), xs[i], y));
      y += 14;
    };
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Por mês (vencimento)", M, y); y += 16;
    const xs = [M, M + 120, M + 240, M + 360];
    linha(["Mês", "Alunos únicos", "Mensalidades", "Saldo"], xs, true);
    (dados.meses || []).forEach((m) => linha([m.mes_nome, NUM(m.alunos_unicos), NUM(m.mensalidades_sem_negociacao), BRL(m.saldo_sem_negociacao)], xs));
    y += 12;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Por curso", M, y); y += 16;
    linha(["Curso", "Alunos", "Mensalidades", "Saldo"], xs, true);
    (dados.por_curso || []).forEach((c) => linha([c.curso, NUM(c.alunos), NUM(c.mensalidades), BRL(c.saldo)], xs));
    y += 12;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Top unidades (por saldo)", M, y); y += 16;
    linha(["Unidade", "Alunos", "Mensalidades", "Saldo"], xs, true);
    (dados.por_unidade || []).slice(0, 8).forEach((u) => linha([u.unidade, NUM(u.alunos), NUM(u.mensalidades), BRL(u.saldo)], xs));

    const d = dados.destaques || {};
    y += 12; doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Destaques", M, y); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    if (d.curso_maior_inadimplencia) { doc.text(`Curso de maior inadimplência: ${d.curso_maior_inadimplencia.curso} (${BRL(d.curso_maior_inadimplencia.saldo)})`, M, y); y += 13; }
    if (d.unidade_maior_inadimplencia) { doc.text(`Unidade de maior inadimplência: ${d.unidade_maior_inadimplencia.unidade} (${BRL(d.unidade_maior_inadimplencia.saldo)})`, M, y); y += 13; }
    if (d.mes_maior_inadimplencia) { doc.text(`Mês de maior inadimplência (saldo): ${d.mes_maior_inadimplencia.mes_nome} (${BRL(d.mes_maior_inadimplencia.saldo_sem_negociacao)})`, M, y); y += 13; }
    if (d.faixa_maior_saldo) { doc.text(`Faixa de maior saldo: ${d.faixa_maior_saldo.faixa} (${BRL(d.faixa_maior_saldo.saldo)})`, M, y); y += 13; }

    doc.save(`relatorio-2026-1-sem-negociacao_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  if (carregando) return <div style={{ padding: 24 }}>Carregando…</div>;
  if (erro) return <div style={{ padding: 24, color: "#b91c1c" }}>{erro}</div>;
  if (!dados) return null;

  const meses = (dados.meses || []).map((m) => ({ ...m, label: m.mes_nome, qtd: Number(m.alunos_unicos) || 0 }));
  const evolucao = (dados.evolucao_diaria || []).map((e) => ({ ...e, label: DIA(e.dia), saldoNum: Number(e.saldo) || 0 }));
  const d = dados.destaques || {};

  const TipMes = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const m = payload[0].payload;
    return (
      <div style={tipBox}>
        <strong>{m.mes_nome}</strong>
        <div>Alunos únicos: {NUM(m.alunos_unicos)}</div>
        <div>Mensalidades: {NUM(m.mensalidades_sem_negociacao)}</div>
        <div>Saldo do mês: {BRL(m.saldo_sem_negociacao)}</div>
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

      {/* Destaques */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        <Destaque titulo="Curso de maior inadimplência" valor={d.curso_maior_inadimplencia?.curso} sub={d.curso_maior_inadimplencia && BRL(d.curso_maior_inadimplencia.saldo)} />
        <Destaque titulo="Unidade de maior inadimplência" valor={d.unidade_maior_inadimplencia?.unidade} sub={d.unidade_maior_inadimplencia && BRL(d.unidade_maior_inadimplencia.saldo)} />
        <Destaque titulo="Mês de maior inadimplência" valor={d.mes_maior_inadimplencia?.mes_nome} sub={d.mes_maior_inadimplencia && BRL(d.mes_maior_inadimplencia.saldo_sem_negociacao)} />
        <Destaque titulo="Faixa de maior saldo" valor={d.faixa_maior_saldo?.faixa} sub={d.faixa_maior_saldo && BRL(d.faixa_maior_saldo.saldo)} />
      </div>

      {/* Gráfico por mês */}
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

      {/* Tabela por mês (CPFs / mensalidades / saldo) */}
      <Secao titulo="Detalhamento por mês">
        <Tabela cabec={["Mês", "CPFs", "Alunos únicos", "Mensalidades", "Saldo"]}
          linhas={(dados.meses || []).map((m) => [m.mes_nome, NUM(m.cpfs), NUM(m.alunos_unicos), NUM(m.mensalidades_sem_negociacao), BRL(m.saldo_sem_negociacao)])} />
      </Secao>

      {/* Evolução diária */}
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

      {/* Por curso */}
      <Secao titulo="Por curso">
        <Tabela cabec={["Curso", "Alunos", "Mensalidades", "Saldo"]}
          linhas={(dados.por_curso || []).map((c) => [c.curso, NUM(c.alunos), NUM(c.mensalidades), BRL(c.saldo)])} />
      </Secao>

      {/* Por unidade */}
      <Secao titulo="Por unidade (campus)">
        <Tabela cabec={["Unidade", "Alunos", "Mensalidades", "Saldo"]}
          linhas={(dados.por_unidade || []).map((u) => [u.unidade, NUM(u.alunos), NUM(u.mensalidades), BRL(u.saldo)])} />
      </Secao>

      {/* Por faixa */}
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

const tipBox = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, fontSize: 13, color: "#111827" };
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
