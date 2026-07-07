import { useEffect, useState } from "react";
import Topbar from "../layout/Topbar";
import { supabase } from "../services/supabase";
import MuralAniversariantes from "../components/MuralAniversariantes";
import CadastroNovoAluno from "../components/CadastroNovoAluno";

function formatarMoeda(valor) {
  const numero = Number(valor) || 0;
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function hojeLocalBR() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

export default function Dashboard() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [indicadores, setIndicadores] = useState({
    baseTotal: 0,
    semResponsavel: 0,
    retornosHoje: 0,
    negociacao24h: 0,
    alunosPagos: 0,
    valorRecebido: 0,
    acordosAtivos: 0,
    linksAguardando: 0,
    baixasAguardando: 0,
    termosAguardandoAdm: 0,
  });

  useEffect(() => {
    carregarIndicadores();
  }, []);

  async function carregarIndicadores() {
    setCarregando(true);
    setErro("");

    try {
      const hoje = hojeLocalBR();

      const [
        baseTotal,
        semResponsavel,
        retornosHoje,
        negociacao24h,
        alunosPagos,
        acordosAtivos,
        linksAguardando,
        baixasAguardando,
        termosAguardandoAdm,
        parcelasPagas,
      ] = await Promise.all([
        supabase.from("alunos").select("id", { count: "exact", head: true }),
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .is("responsavel_atual_email", null),
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .eq("data_retorno", hoje),
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .eq("status_jornada", "ALUNO_EM_NEGOCIACAO_24H"),
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .eq("status_jornada", "BAIXA_REALIZADA"),
        supabase
          .from("acordos")
          .select("id", { count: "exact", head: true })
          .eq("status", "ATIVO"),
        supabase
          .from("links_pagamento")
          .select("id", { count: "exact", head: true })
          .in("status", ["SOLICITADO_LINK", "LINK_EM_ATENDIMENTO"]),
        supabase
          .from("solicitacoes_confirmacao_pagamento")
          .select("id", { count: "exact", head: true })
          .eq("status", "AGUARDANDO_CONFIRMACAO"),
        supabase
          .from("termos_acordo")
          .select("id", { count: "exact", head: true })
          .eq("status", "TERMO_ENVIADO_ADM"),
        supabase.from("parcelas").select("valor").eq("status", "PAGO"),
      ]);

      const valorParcelasPagas = (parcelasPagas.data || []).reduce(
        (soma, p) => soma + (Number(p.valor) || 0),
        0
      );

      const { data: acordosComEntradaPaga } = await supabase
        .from("acordos")
        .select("valor_entrada")
        .eq("entrada_paga", true);

      const valorEntradasPagas = (acordosComEntradaPaga || []).reduce(
        (soma, a) => soma + (Number(a.valor_entrada) || 0),
        0
      );

      setIndicadores({
        baseTotal: baseTotal.count || 0,
        semResponsavel: semResponsavel.count || 0,
        retornosHoje: retornosHoje.count || 0,
        negociacao24h: negociacao24h.count || 0,
        alunosPagos: alunosPagos.count || 0,
        valorRecebido: valorParcelasPagas + valorEntradasPagas,
        acordosAtivos: acordosAtivos.count || 0,
        linksAguardando: linksAguardando.count || 0,
        baixasAguardando: baixasAguardando.count || 0,
        termosAguardandoAdm: termosAguardandoAdm.count || 0,
      });
    } catch (e) {
      console.error("Erro ao carregar indicadores do dashboard:", e);
      setErro("Não foi possível carregar todos os indicadores.");
    } finally {
      setCarregando(false);
    }
  }

  const secoes = [
    {
      titulo: "Base de alunos",
      cartoes: [
        { rotulo: "Base total de alunos", valor: indicadores.baseTotal, icone: "👥", cor: "#334155" },
        { rotulo: "Sem responsável", valor: indicadores.semResponsavel, icone: "❔", cor: "#94a3b8" },
        { rotulo: "Retornos para hoje", valor: indicadores.retornosHoje, icone: "📅", cor: "#d97706" },
        { rotulo: "Em negociação 24h", valor: indicadores.negociacao24h, icone: "💬", cor: "#db2777" },
      ],
    },
    {
      titulo: "Financeiro",
      cartoes: [
        { rotulo: "Alunos com baixa realizada", valor: indicadores.alunosPagos, icone: "✅", cor: "#16a34a" },
        { rotulo: "Valor total recebido", valor: formatarMoeda(indicadores.valorRecebido), icone: "💰", cor: "#16a34a", destaque: true },
        { rotulo: "Acordos ativos", valor: indicadores.acordosAtivos, icone: "🤝", cor: "#334155" },
      ],
    },
    {
      titulo: "Filas pendentes",
      cartoes: [
        { rotulo: "Links aguardando resposta", valor: indicadores.linksAguardando, icone: "🔗", cor: "#0ea5e9" },
        { rotulo: "Pagamentos aguardando confirmação", valor: indicadores.baixasAguardando, icone: "🧾", cor: "#0ea5e9" },
        { rotulo: "Termos aguardando ADM", valor: indicadores.termosAguardandoAdm, icone: "📄", cor: "#0ea5e9" },
      ],
    },
  ];

  return (
    <main className="content">
      <Topbar />

      <div style={estilos.pagina}>
        <div style={estilos.cabecalho}>
          <div>
            <h1 style={estilos.titulo}>Resumo operacional</h1>
            <p style={estilos.subtitulo}>Visão geral da base e dos casos em andamento.</p>
          </div>

          <div style={estilos.acoesTopo}>
            <CadastroNovoAluno onSucesso={carregarIndicadores} />
            <button style={estilos.botaoAtualizar} onClick={carregarIndicadores} disabled={carregando}>
              {carregando ? "Atualizando..." : "↻ Atualizar"}
            </button>
          </div>
        </div>

        {erro && <p style={estilos.erro}>{erro}</p>}

        {secoes.map((secao) => (
          <section key={secao.titulo} style={estilos.secao}>
            <h2 style={estilos.tituloSecao}>{secao.titulo}</h2>
            <div style={estilos.grid}>
              {secao.cartoes.map((c) => (
                <div key={c.rotulo} style={estilos.cartao}>
                  <div style={{ ...estilos.faixaCor, background: c.cor }} />
                  <div style={estilos.corpoCartao}>
                    <div style={estilos.linhaTopoCartao}>
                      <span style={estilos.icone}>{c.icone}</span>
                      <p style={estilos.rotuloCartao}>{c.rotulo}</p>
                    </div>
                    <p
                      style={{
                        ...estilos.valorCartao,
                        fontSize: c.destaque ? 30 : 26,
                        color: c.destaque ? c.cor : "#111827",
                      }}
                    >
                      {carregando ? "…" : c.valor}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <MuralAniversariantes />
    </main>
  );
}

const estilos = {
  pagina: {
    padding: "24px 28px 40px",
    fontFamily: "'Inter', Arial, sans-serif",
    background: "#f8fafc",
    minHeight: "100%",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "22px",
    flexWrap: "wrap",
  },
  acoesTopo: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  titulo: {
    margin: 0,
    marginBottom: "4px",
    color: "#0f172a",
    fontSize: "24px",
    fontWeight: 800,
  },
  subtitulo: {
    margin: 0,
    color: "#64748b",
    fontSize: "14px",
  },
  botaoAtualizar: {
    background: "#0f172a",
    color: "#fff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "700",
    height: "fit-content",
    fontSize: "13.5px",
  },
  erro: {
    color: "#b91c1c",
    fontWeight: "bold",
    marginBottom: "12px",
  },
  secao: {
    marginBottom: "26px",
  },
  tituloSecao: {
    margin: "0 0 12px 0",
    color: "#334155",
    fontSize: "14px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
    gap: "14px",
  },
  cartao: {
    background: "#fff",
    borderRadius: "14px",
    boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
    border: "1px solid #eef2f7",
    overflow: "hidden",
    display: "flex",
  },
  faixaCor: {
    width: "4px",
    flexShrink: 0,
  },
  corpoCartao: {
    padding: "16px 18px",
    flex: 1,
  },
  linhaTopoCartao: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "10px",
  },
  icone: {
    fontSize: "15px",
    lineHeight: 1,
  },
  rotuloCartao: {
    margin: 0,
    fontSize: "12.5px",
    color: "#64748b",
    fontWeight: 600,
  },
  valorCartao: {
    margin: 0,
    fontWeight: 800,
    color: "#111827",
  },
};
