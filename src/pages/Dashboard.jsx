import { useEffect, useState } from "react";
import Topbar from "../layout/Topbar";
import { supabase } from "../services/supabase";
import MuralAniversariantes from "../components/MuralAniversariantes";
import PainelCarteira from "../components/PainelCarteira";
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

  return (
    <main className="content">
      <Topbar />

      <div style={estilos.pagina}>
        <div style={estilos.cabecalho}>
          <div>
            <h1 style={estilos.titulo}>Resumo operacional</h1>
            <p style={estilos.subtitulo}>Visão geral da base e dos casos em andamento.</p>
          </div>

          <button style={estilos.botaoAtualizar} onClick={carregarIndicadores} disabled={carregando}>
            {carregando ? "Atualizando..." : "Atualizar"}
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <CadastroNovoAluno onSucesso={carregarIndicadores} />
        </div>

        {erro && <p style={estilos.erro}>{erro}</p>}

        <h2 style={estilos.tituloSecao}>Base de alunos</h2>
        <div style={estilos.grid}>
          <div style={estilos.cartao}>
            <p style={estilos.rotuloCartao}>Base total de alunos</p>
            <p style={estilos.valorCartao}>{indicadores.baseTotal}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #94a3b8" }}>
            <p style={estilos.rotuloCartao}>Sem responsável</p>
            <p style={estilos.valorCartao}>{indicadores.semResponsavel}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #facc15" }}>
            <p style={estilos.rotuloCartao}>Retornos para hoje</p>
            <p style={{ ...estilos.valorCartao, color: "#b45309" }}>{indicadores.retornosHoje}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #f472b6" }}>
            <p style={estilos.rotuloCartao}>Em negociação 24h</p>
            <p style={estilos.valorCartao}>{indicadores.negociacao24h}</p>
          </div>
        </div>

        <h2 style={estilos.tituloSecao}>Financeiro</h2>
        <div style={estilos.grid}>
          <div style={{ ...estilos.cartao, borderLeft: "4px solid #16a34a" }}>
            <p style={estilos.rotuloCartao}>Alunos com baixa realizada</p>
            <p style={{ ...estilos.valorCartao, color: "#15803d" }}>{indicadores.alunosPagos}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #16a34a" }}>
            <p style={estilos.rotuloCartao}>Valor total recebido</p>
            <p style={{ ...estilos.valorCartao, color: "#15803d" }}>
              {formatarMoeda(indicadores.valorRecebido)}
            </p>
          </div>

          <div style={estilos.cartao}>
            <p style={estilos.rotuloCartao}>Acordos ativos</p>
            <p style={estilos.valorCartao}>{indicadores.acordosAtivos}</p>
          </div>
        </div>

        <h2 style={estilos.tituloSecao}>Filas pendentes</h2>
        <div style={estilos.grid}>
          <div style={{ ...estilos.cartao, borderLeft: "4px solid #0ea5e9" }}>
            <p style={estilos.rotuloCartao}>Links aguardando resposta</p>
            <p style={estilos.valorCartao}>{indicadores.linksAguardando}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #0ea5e9" }}>
            <p style={estilos.rotuloCartao}>Pagamentos aguardando confirmação</p>
            <p style={estilos.valorCartao}>{indicadores.baixasAguardando}</p>
          </div>

          <div style={{ ...estilos.cartao, borderLeft: "4px solid #0ea5e9" }}>
            <p style={estilos.rotuloCartao}>Termos aguardando ADM</p>
            <p style={estilos.valorCartao}>{indicadores.termosAguardandoAdm}</p>
          </div>
        </div>
        <PainelCarteira embedded />
      </div>

      <MuralAniversariantes />
    </main>
  );
}

const estilos = {
  pagina: {
    padding: "24px",
    fontFamily: "Arial, sans-serif",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "10px",
  },
  titulo: {
    margin: 0,
    marginBottom: "6px",
    color: "#111827",
  },
  subtitulo: {
    margin: 0,
    color: "#4b5563",
  },
  botaoAtualizar: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    height: "fit-content",
  },
  erro: {
    color: "#b91c1c",
    fontWeight: "bold",
  },
  tituloSecao: {
    marginTop: "26px",
    marginBottom: "12px",
    color: "#1f2937",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "14px",
  },
  cartao: {
    background: "#fff",
    borderRadius: "12px",
    padding: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    borderLeft: "4px solid #111827",
  },
  rotuloCartao: {
    margin: 0,
    marginBottom: "8px",
    fontSize: "13px",
    color: "#6b7280",
    fontWeight: "bold",
  },
  valorCartao: {
    margin: 0,
    fontSize: "26px",
    fontWeight: "bold",
    color: "#111827",
  },
};
