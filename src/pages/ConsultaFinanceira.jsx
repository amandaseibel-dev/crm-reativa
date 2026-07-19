import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { OPERADORES_POR_EMAIL } from "../utils/operadores";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const POR_PAGINA = 30;

const FILTROS = [
  { valor: "TODOS", label: "Todos" },
  { valor: "EM_ABERTO", label: "Em aberto" },
  { valor: "EM_ATRASO", label: "Em atraso" },
  { valor: "PAGO", label: "Pagos" },
  { valor: "PARCIAL", label: "Parciais" },
];

const CORES_FAIXA = {
  "A vencer": "#2563eb",
  "1-30 dias": "#60a5fa",
  "31-60 dias": "#93c5fd",
  "61-90 dias": "#f59e0b",
  "91-180 dias": "#f97316",
  "181-365 dias": "#dc2626",
  "1-2 anos": "#991b1b",
  "2+ anos": "#7f1d1d",
};

function formatarData(data) {
  if (!data) return "-";
  return new Date(data + "T00:00:00").toLocaleDateString("pt-BR");
}

function moeda(valor) {
  if (valor == null) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function moedaCompacta(valor) {
  const n = Number(valor || 0);
  if (n >= 1000000) return "R$ " + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "R$ " + Math.round(n / 1000) + "k";
  return moeda(n);
}

const SITUACAO_LABEL = {
  EM_ABERTO: "Em aberto",
  PARCIAL: "Parcial",
  PAGO: "Pago",
};

export default function ConsultaFinanceira() {
  const [resumo, setResumo] = useState(null);
  const [gerencial, setGerencial] = useState(null);
  const [filtro, setFiltro] = useState("TODOS");
  const [busca, setBusca] = useState("");
  const [valorMinimo, setValorMinimo] = useState("");
  const [operador, setOperador] = useState("");
  const [pagina, setPagina] = useState(0);
  const [linhas, setLinhas] = useState([]);
  const [totalLinhas, setTotalLinhas] = useState(0);
  const [carregando, setCarregando] = useState(true);

  function aplicarFiltros(query) {
    const buscaLimpa = busca.trim();
    const ehCpf = /^\d{3,}$/.test(buscaLimpa.replace(/\D/g, ""));

    if (filtro === "EM_ABERTO") query = query.in("situacao_geral", ["EM_ABERTO", "PARCIAL"]);
    if (filtro === "EM_ATRASO") query = query.eq("tem_atraso", true);
    if (filtro === "PAGO") query = query.eq("situacao_geral", "PAGO");
    if (filtro === "PARCIAL") query = query.eq("situacao_geral", "PARCIAL");

    if (buscaLimpa) {
      if (ehCpf) {
        query = query.ilike("cpf", `%${buscaLimpa.replace(/\D/g, "")}%`);
      } else {
        query = query.ilike("nome", `%${buscaLimpa}%`);
      }
    }

    if (valorMinimo) {
      query = query.gte("valor_em_aberto", Number(valorMinimo));
    }

    if (operador === "__SEM__") {
      query = query.is("responsavel_atual_email", null);
    } else if (operador) {
      query = query.eq("responsavel_atual_email", operador);
    }

    return query;
  }

  useEffect(() => {
    carregarLinhas(pagina);
    carregarResumoFiltrado();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro, pagina, operador]);

  useEffect(() => {
    carregarGerencial();
  }, []);

  async function carregarGerencial() {
    const { data } = await supabase.rpc("dashboard_gestao_geral", { p_dias: 30 });
    setGerencial(data || null);
  }

  async function buscar() {
    setPagina(0);
    await carregarLinhas(0);
    await carregarResumoFiltrado();
  }

  // Quando tem operador (ou qualquer filtro) selecionado, os cards passam a
  // mostrar o total daquele recorte, não o total geral da base. Usa RPC
  // (agregacao exata no banco) em vez de buscar todas as linhas no
  // navegador, que cortava em ~100-1000 linhas e distorcia os totais.
  async function carregarResumoFiltrado() {
    const buscaLimpa = busca.trim();
    const ehCpf = /^\d{3,}$/.test(buscaLimpa.replace(/\D/g, ""));

    const { data } = await supabase.rpc("resumo_financeiro_filtrado", {
      p_filtro: filtro === "TODOS" ? null : filtro,
      p_busca: buscaLimpa
        ? ehCpf
          ? buscaLimpa.replace(/\D/g, "")
          : buscaLimpa
        : null,
      p_eh_cpf: ehCpf,
      p_valor_minimo: valorMinimo ? Number(valorMinimo) : null,
      p_operador: operador || null,
    });

    setResumo({
      total_alunos: data?.total_alunos || 0,
      total_em_aberto: data?.total_em_aberto || 0,
      total_em_atraso: data?.total_em_atraso || 0,
      total_pagos: data?.total_pagos || 0,
      total_parcial: data?.total_parcial || 0,
      valor_em_aberto: data?.valor_em_aberto || 0,
      valor_em_atraso: data?.valor_em_atraso || 0,
    });
  }

  async function carregarLinhas(paginaAtual) {
    setCarregando(true);

    let query = supabase
      .from("consulta_financeira_por_aluno")
      .select("*", { count: "exact" });

    query = aplicarFiltros(query);

    query = query
      .order("valor_em_aberto", { ascending: false })
      .range(paginaAtual * POR_PAGINA, paginaAtual * POR_PAGINA + POR_PAGINA - 1);

    const { data, count } = await query;
    setLinhas(data || []);
    setTotalLinhas(count || 0);
    setCarregando(false);
  }

  return (
    <div style={S.container}>
      <h1 style={S.titulo}>Financeiro</h1>
      <p style={S.subtitulo}>
        Visão gerencial da carteira financeira + consulta detalhada por aluno.
      </p>

      {gerencial && (
        <>
          <div style={S.secaoTitulo}>
            <span>📊 Visão gerencial</span>
            <div style={S.linha} />
          </div>

          <div style={S.hero}>
            <div>
              <div style={S.heroLabel}>Total em aberto na base</div>
              <div style={S.heroNum}>{moeda(gerencial.base?.valor_total)}</div>
              <div style={S.heroSub}>{gerencial.base?.com_divida} alunos com dívida ativa</div>
            </div>
            <div style={S.barrasFaixa}>
              {(gerencial.faixa_atraso || []).map((f) => {
                const max = Math.max(1, ...(gerencial.faixa_atraso || []).map((x) => x.valor || 0));
                return (
                  <div key={f.faixa} style={S.faixaLinha}>
                    <span style={S.faixaNome}>{f.faixa}</span>
                    <div style={S.faixaBarraFundo}>
                      <div style={{ ...S.faixaBarra, width: `${Math.max(3, (f.valor / max) * 100)}%`, background: CORES_FAIXA[f.faixa] || "#94a3b8" }} />
                    </div>
                    <span style={S.faixaValor}>{moedaCompacta(f.valor)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {resumo && (
        <div style={S.grade}>
          <div style={S.cartao}>
            <div style={S.numero}>{resumo.total_alunos}</div>
            <div style={S.label}>Alunos com título</div>
          </div>
          <div style={S.cartao}>
            <div style={{ ...S.numero, color: "#b45309" }}>{moeda(resumo.valor_em_aberto)}</div>
            <div style={S.label}>Em aberto ({resumo.total_em_aberto} alunos)</div>
          </div>
          <div style={S.cartao}>
            <div style={{ ...S.numero, color: "#dc2626" }}>{moeda(resumo.valor_em_atraso)}</div>
            <div style={S.label}>Em atraso ({resumo.total_em_atraso} alunos)</div>
          </div>
          <div style={S.cartao}>
            <div style={{ ...S.numero, color: "#2563eb" }}>{resumo.total_parcial}</div>
            <div style={S.label}>Parciais</div>
          </div>
          <div style={S.cartao}>
            <div style={{ ...S.numero, color: "#16a34a" }}>{resumo.total_pagos}</div>
            <div style={S.label}>Pagos</div>
          </div>
        </div>
      )}

      {gerencial && (
        <>
          <div style={S.secaoTitulo}>
            <span>🤝 Acordos</span>
            <div style={S.linha} />
          </div>
          <div style={S.grade}>
            <div style={S.cartao}>
              <div style={{ ...S.numero, color: "#16a34a" }}>
                {(gerencial.situacao_carteira || []).find((c) => c.categoria === "Acordo em dia")?.qtd || 0}
              </div>
              <div style={S.label}>Acordos em dia</div>
            </div>
            <div style={S.cartao}>
              <div style={{ ...S.numero, color: "#f59e0b" }}>
                {(gerencial.situacao_carteira || []).find((c) => c.categoria === "Acordo em atraso até 30d")?.qtd || 0}
              </div>
              <div style={S.label}>Acordos atrasados (até 30d)</div>
            </div>
            <div style={S.cartao}>
              <div style={{ ...S.numero, color: "#dc2626" }}>
                {(gerencial.situacao_carteira || []).find((c) => c.categoria === "Acordo quebrado")?.qtd || 0}
              </div>
              <div style={S.label}>Acordos quebrados</div>
            </div>
            <div style={S.cartao}>
              <div style={S.numero}>{moeda(gerencial.acordos_ativos?.valor)}</div>
              <div style={S.label}>Valor total em acordos ativos</div>
            </div>
          </div>
        </>
      )}

      <div style={S.secaoTitulo}>
        <span>🔎 Consulta por aluno</span>
        <div style={S.linha} />
      </div>

      <div style={S.filtros}>
        {FILTROS.map((f) => (
          <button
            key={f.valor}
            type="button"
            onClick={() => {
              setFiltro(f.valor);
              setPagina(0);
            }}
            style={filtro === f.valor ? S.chipAtivo : S.chip}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={S.filtros}>
        <input
          type="text"
          placeholder="Nome ou CPF do aluno"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          style={{ ...S.input, minWidth: 220 }}
        />
        <input
          type="number"
          placeholder="Valor mínimo (R$)"
          value={valorMinimo}
          onChange={(e) => setValorMinimo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buscar()}
          style={{ ...S.input, width: 150 }}
        />
        <select
          value={operador}
          onChange={(e) => setOperador(e.target.value)}
          style={S.input}
        >
          <option value="">Todos os operadores</option>
          <option value="__SEM__">Sem responsável</option>
          {Object.entries(OPERADORES_POR_EMAIL).map(([email, nome]) => (
            <option key={email} value={email}>
              {nome}
            </option>
          ))}
        </select>
        <button type="button" onClick={buscar} style={S.botaoAzul}>
          Filtrar
        </button>
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : linhas.length === 0 ? (
        <p style={S.muted}>Nenhum aluno encontrado com esse filtro.</p>
      ) : (
        <div style={S.painel}>
          <div style={{ overflowX: "auto" }}>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Aluno</th>
                  <th style={S.th}>Operador</th>
                  <th style={S.th}>Títulos</th>
                  <th style={S.th}>Próx. vencimento</th>
                  <th style={S.thNum}>Valor em aberto</th>
                  <th style={S.th}>Situação</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha) => (
                  <tr
                    key={linha.aluno_id}
                    onClick={() => window.open(`/aluno?alunoId=${linha.aluno_id}`, "_blank")}
                    title="Clique para abrir a ficha do aluno"
                    style={S.tr}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={S.td}>
                      <div style={S.nome}>{linha.nome}</div>
                      {linha.cpf && <div style={S.subCel}>CPF {linha.cpf}</div>}
                    </td>
                    <td style={S.td}>{linha.responsavel_atual_nome || "Sem responsável"}</td>
                    <td style={S.td}>
                      {linha.qtd_em_aberto}
                      {linha.qtd_pagos > 0 ? ` (+${linha.qtd_pagos} pagos)` : ""}
                    </td>
                    <td style={S.td}>
                      {formatarData(linha.proximo_vencimento)}
                      {linha.tem_atraso && (
                        <span style={{ ...S.selo, ...S.seloAtraso, marginLeft: 6 }}>atrasado</span>
                      )}
                    </td>
                    <td style={S.tdNum}>{moeda(linha.valor_em_aberto)}</td>
                    <td style={S.td}>
                      <span style={{ ...S.selo, ...(linha.situacao_geral === "PAGO" ? S.seloPago : S.seloAberto) }}>
                        {SITUACAO_LABEL[linha.situacao_geral] || linha.situacao_geral}
                      </span>
                    </td>
                    <td style={S.td}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`/aluno?alunoId=${linha.aluno_id}`, "_blank");
                        }}
                        style={S.botaoFicha}
                      >
                        Abrir ficha
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={S.rodape}>
            <button
              type="button"
              disabled={pagina === 0}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}
              style={S.chip}
            >
              Anterior
            </button>
            <span>
              Página {pagina + 1} de {Math.max(1, Math.ceil(totalLinhas / POR_PAGINA))} ({totalLinhas} alunos)
            </span>
            <button
              type="button"
              disabled={(pagina + 1) * POR_PAGINA >= totalLinhas}
              onClick={() => setPagina((p) => p + 1)}
              style={S.chip}
            >
              Próxima
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  container: { minHeight: "100%", background: "#f4f6fa", padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif" },
  titulo: { margin: "0 0 4px", color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "0 0 22px", color: "#8a93a3", fontSize: 13.5 },
  secaoTitulo: { display: "flex", alignItems: "center", gap: 8, fontFamily: FONTE_TITULO, fontSize: 14, fontWeight: 800, color: "#0d1321", margin: "26px 0 12px" },
  linha: { flex: 1, height: 1, background: "#e6eaf0" },
  hero: {
    background: "#fff", border: "1px solid #e6eaf0", borderRadius: 18, padding: "22px 24px",
    display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 24, marginBottom: 16,
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
  },
  heroLabel: { fontSize: 12, color: "#8a93a3", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 },
  heroNum: { fontFamily: FONTE_TITULO, fontSize: 38, fontWeight: 800, color: "#0d1321", lineHeight: 1 },
  heroSub: { fontSize: 12.5, color: "#8a93a3", marginTop: 8, fontWeight: 600 },
  barrasFaixa: { display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" },
  faixaLinha: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 },
  faixaNome: { width: 90, color: "#8a93a3", fontWeight: 600 },
  faixaBarraFundo: { flex: 1, background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  faixaBarra: { height: "100%", borderRadius: 999 },
  faixaValor: { width: 90, textAlign: "right", fontWeight: 700, color: "#334155" },
  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14, marginBottom: 8 },
  cartao: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: "18px 20px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  numero: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "#0d1321", marginBottom: 4 },
  label: { fontSize: 12.5, color: "#8a93a3", fontWeight: 600 },
  filtros: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18, alignItems: "center" },
  chip: { padding: "8px 16px", borderRadius: 10, border: "1px solid #e6eaf0", background: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: "#334155" },
  chipAtivo: { padding: "8px 16px", borderRadius: 10, border: "1px solid #2563eb", background: "#2563eb", fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: "#fff" },
  input: { padding: "9px 12px", borderRadius: 10, border: "1px solid #e6eaf0", fontSize: 13, background: "#f8fafc" },
  botaoAzul: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  painel: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: 20, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  muted: { color: "#8a93a3" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e6eaf0" },
  thNum: { textAlign: "right", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e6eaf0" },
  tr: { borderBottom: "1px solid #f2f4f7", cursor: "pointer", transition: "background 0.12s ease" },
  td: { padding: "13px 12px" },
  tdNum: { padding: "13px 12px", fontWeight: 800, color: "#1e40af", textAlign: "right" },
  nome: { fontWeight: 700, color: "#0d1321" },
  subCel: { fontSize: 11.5, color: "#98a2b3", marginTop: 2 },
  selo: { display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 },
  seloAberto: { background: "#fffbeb", color: "#b45309" },
  seloAtraso: { background: "#fef2f2", color: "#dc2626" },
  seloPago: { background: "#ecfdf5", color: "#16a34a" },
  botaoFicha: { background: "#eff6ff", color: "#2563eb", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  rodape: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, fontSize: 12.5, color: "#8a93a3" },
};
