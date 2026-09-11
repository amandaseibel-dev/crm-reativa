import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { podeVerTudo } from "../utils/operadores";

/*
  PainelGeral (gestão)
  --------------------
  Dashboard 360 restrito à gestão (Amanda/Fernanda): abas Operacional,
  Carteira e Pagamentos. Fonte única: RPC public.painel_geral(p_mes,
  p_operador), que já é gestão-gated e agrega tudo no banco. A carteira conta
  por CPF (pessoa), não por título. Não substitui a Minha Carteira da operação.
*/

const OPERADORES = [
  { nome: "Fernanda", email: "cobranca04@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Mauricio", email: "cobranca06@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
];

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v) {
  return (Number(v) || 0).toLocaleString("pt-BR");
}
function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const ABAS = [
  ["operacional", "Visão Operacional"],
  ["carteira", "Visão da Carteira"],
  ["pagamentos", "Pagamentos"],
];

export default function PainelGeral() {
  const [email, setEmail] = useState(null);
  const [autorizado, setAutorizado] = useState(null); // null = carregando
  const [mes, setMes] = useState(mesAtual());
  const [operador, setOperador] = useState("");
  const [aba, setAba] = useState("operacional");
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const mail = data?.user?.email || null;
      setEmail(mail);
      setAutorizado(podeVerTudo(mail));
    });
  }, []);

  useEffect(() => {
    if (!autorizado) return;
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autorizado, mes, operador]);

  async function carregar() {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("painel_geral", {
      p_mes: mes,
      p_operador: operador || null,
    });
    if (error) {
      setErro("Erro ao carregar o painel: " + error.message);
    } else if (!data?.ok) {
      setErro(data?.erro === "SEM_PERMISSAO" ? "Sem permissão para este painel." : "Não foi possível carregar.");
    } else {
      setDados(data);
    }
    setCarregando(false);
  }

  const op = dados?.operacional;
  const ca = dados?.carteira;
  const pg = dados?.pagamentos;

  const faixas = useMemo(() => {
    const f = ca?.faixas || {};
    return [
      ["Até R$ 500", f.ate_500],
      ["R$ 500–1.000", f.de_500_1000],
      ["R$ 1.000–5.000", f.de_1000_5000],
      ["Acima de R$ 5.000", f.acima_5000],
    ];
  }, [ca]);

  if (autorizado === null) return <div style={S.pagina}><Carregando texto="Carregando…" /></div>;
  if (!autorizado) {
    return (
      <div style={S.pagina}>
        <h1 style={S.titulo}>Painel Geral</h1>
        <div style={S.alerta}>Este painel é restrito à gestão (Amanda/Fernanda).</div>
      </div>
    );
  }

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Painel Geral</h1>
          <p style={S.subtitulo}>Panorama 360 da operação — Operacional · Carteira · Pagamentos</p>
        </div>
        <div style={S.filtrosTopo}>
          <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} style={S.input} />
          <select value={operador} onChange={(e) => setOperador(e.target.value)} style={S.input}>
            <option value="">Todos os operadores</option>
            {OPERADORES.map((o) => (
              <option key={o.email} value={o.email}>{o.nome}</option>
            ))}
          </select>
          <button style={S.btn} onClick={carregar} disabled={carregando}>
            {carregando ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </div>

      {erro && <p style={S.erro}>{erro}</p>}

      <div style={S.abas}>
        {ABAS.map(([chave, rot]) => (
          <button key={chave} onClick={() => setAba(chave)} style={aba === chave ? S.abaAtiva : S.abaInativa}>
            {rot}
          </button>
        ))}
      </div>

      {!dados ? (
        <p style={S.subtitulo}>Carregando dados...</p>
      ) : aba === "operacional" ? (
        <>
          <div style={S.kpiGrid}>
            <Kpi cor="var(--rv-azul)" rot="Casos ativos" val={num(op.casos_ativos)} />
            <Kpi cor="var(--rv-texto-forte)" rot="Base total" val={num(op.base_total)} />
            <Kpi cor="var(--rv-texto-fraco)" rot="Sem responsável" val={num(op.sem_responsavel)} />
            <Kpi cor="var(--rv-ambar)" rot="Sem contato +10 dias" val={num(op.sem_contato_10)} />
            <Kpi cor="#db2777" rot="Em negociação 24h" val={num(op.negociacao_24h)} />
            <Kpi cor="var(--rv-azul)" rot="Retornos hoje" val={num(op.retornos_hoje)} />
          </div>
          <Tabela
            titulo="Casos ativos por operador"
            colunas={["Operador", "Casos ativos"]}
            linhas={(op.por_operador || []).map((r) => [r.nome || r.email, num(r.casos)])}
          />
        </>
      ) : aba === "carteira" ? (
        <>
          <div style={S.kpiGrid}>
            <Kpi cor="var(--rv-roxo)" rot="CPFs com dívida" val={num(ca.cpfs_com_divida)} />
            <Kpi cor="var(--rv-verde-ok)" rot="Valor em aberto" val={moeda(ca.valor_em_aberto)} />
            <Kpi cor="#0d9488" rot="Títulos em aberto" val={num(ca.titulos_em_aberto)} />
          </div>
          <Tabela
            titulo="Concentração por faixa de saldo (CPFs)"
            colunas={["Faixa", "CPFs"]}
            linhas={faixas.map(([rot, v]) => [rot, num(v)])}
          />
          <Tabela
            titulo="Distribuição por operador (por CPF)"
            colunas={["Operador", "CPFs", "Valor em aberto"]}
            linhas={(ca.por_operador || []).map((r) => [r.nome || r.email, num(r.cpfs), moeda(r.valor)])}
          />
        </>
      ) : (
        <>
          <div style={S.kpiGrid}>
            <Kpi cor="var(--rv-verde-ok)" rot={`Recebido no mês (${pg.mes})`} val={moeda(pg.recebido_valor)} />
            <Kpi cor="#0d9488" rot="Honorários no mês" val={moeda(pg.honorarios_valor)} />
            <Kpi cor="var(--rv-azul)" rot="Pagamentos recebidos" val={num(pg.recebidos_qtd)} />
            <Kpi cor="var(--rv-azul)" rot="Acordos ativos" val={num(pg.acordos_ativos)} />
            <Kpi cor="var(--rv-azul)" rot="Baixas pendentes" val={num(pg.baixas_pendentes)} />
            <Kpi cor="var(--rv-ambar)" rot="Links aguardando" val={num(pg.links_aguardando)} />
          </div>
          <Tabela
            titulo="Recebido por operador no mês"
            colunas={["Operador", "Qtd", "Recebido", "Honorários"]}
            linhas={(pg.por_operador || []).map((r) => [r.nome || r.email, num(r.qtd), moeda(r.valor), moeda(r.honorario)])}
          />
        </>
      )}
    </div>
  );
}

function Kpi({ rot, val, cor }) {
  return (
    <div style={{ ...S.kpiCard, borderTop: `3px solid ${cor}` }}>
      <p style={S.kpiRot}>{rot}</p>
      <p style={{ ...S.kpiVal, color: cor }}>{val}</p>
    </div>
  );
}

function Tabela({ titulo, colunas, linhas }) {
  return (
    <div style={S.bloco}>
      <h2 style={S.tituloSecao}>{titulo}</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={S.tabela}>
          <thead>
            <tr>
              {colunas.map((c, i) => (
                <th key={i} style={i === 0 ? S.th : S.thNum}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.length === 0 && (
              <tr><td style={S.vazio} colSpan={colunas.length}>Sem dados.</td></tr>
            )}
            {linhas.map((l, i) => (
              <tr key={i} style={S.tr}>
                {l.map((c, j) => (
                  <td key={j} style={j === 0 ? S.td : S.tdNum}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const S = {
  pagina: { padding: 24, fontFamily: "Arial, sans-serif", background: "var(--rv-fundo-suave)", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 16 },
  titulo: { margin: 0, marginBottom: 4, color: "var(--rv-tinta)", fontSize: 26 },
  subtitulo: { margin: 0, color: "var(--rv-texto-suave)", fontSize: 14 },
  filtrosTopo: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  input: { padding: "9px 12px", borderRadius: 8, border: "1px solid var(--rv-borda-forte)", background: "var(--rv-superficie)", fontSize: 14 },
  btn: { background: "var(--rv-botao-escuro)", color: "#fff", border: "none", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: "bold" },
  erro: { color: "var(--rv-vermelho-texto)", fontWeight: "bold" },
  alerta: { background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", border: "1px solid var(--rv-ambar-borda)", borderRadius: 10, padding: 16, marginTop: 12 },
  abas: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 },
  abaAtiva: { border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", background: "#2563eb", color: "#fff" },
  abaInativa: { border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", background: "var(--rv-borda)", color: "var(--rv-texto)" },
  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 18 },
  kpiCard: { background: "var(--rv-superficie)", borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  kpiRot: { margin: "0 0 6px 0", fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  kpiVal: { margin: 0, fontSize: 24, fontWeight: 800 },
  bloco: { background: "var(--rv-superficie)", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginBottom: 16 },
  tituloSecao: { margin: "0 0 12px 0", color: "var(--rv-tinta)", fontSize: 16 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13.5 },
  th: { textAlign: "left", padding: "10px 8px", color: "var(--rv-texto-suave)", fontSize: 12, borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "10px 8px", color: "var(--rv-texto-suave)", fontSize: 12, borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  tr: { borderBottom: "1px solid var(--rv-borda-suave)" },
  td: { padding: "10px 8px", color: "var(--rv-tinta)", fontWeight: 600 },
  tdNum: { padding: "10px 8px", color: "var(--rv-texto-forte)", textAlign: "right", whiteSpace: "nowrap" },
  vazio: { padding: 20, textAlign: "center", color: "var(--rv-texto-fraco)" },
};
