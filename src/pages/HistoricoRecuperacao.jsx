import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import FunilRecuperacao from "../components/FunilRecuperacao";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const GRUPOS_STATUS = {
  ativo: ["Em cobrança", "CONTATAR", "MENSAGEM_ENVIADA", "EM_ATENDIMENTO", "ALUNO_EM_NEGOCIACAO_24H", "AGUARDANDO_COMPROVANTE", "NAO_LOCALIZADO", "RETORNAR_DEPOIS", "SEM_RETORNO", "LINK_ENVIADO_AO_ALUNO", "LINK_PRONTO_PARA_ENVIO", "SOLICITADO_LINK", "Novo caso"],
  recuperado: ["QUITADO_MANUAL", "QUITADO", "BAIXA_REALIZADA", "ACORDO_FECHADO", "AGUARDANDO_BAIXA", "ELOGIO_ATENDIMENTO"],
  suspenso: ["CANCELAMENTO_COBRANCA", "JURIDICO", "SUSPENSAO_COBRANCA", "BAIXA_DEVOLVIDA"],
  termos: ["TERMO_LIBERADO_AUTOMATICO_GOV", "TERMO_ENVIADO_ALUNO", "Termo recebido - liberado", "TERMO_RECEBIDO_LIBERADO", "Termo rejeitado", "Enviado ao financeiro", "Aguardando envio financeiro"],
};

function grupoDoStatus(status) {
  for (const [grupo, lista] of Object.entries(GRUPOS_STATUS)) {
    if (lista.includes(status)) return grupo;
  }
  return "ativo";
}

export default function HistoricoRecuperacao() {
  const [carregando, setCarregando] = useState(true);
  const [porMes, setPorMes] = useState([]);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);

    const { data, error } = await supabase.rpc("recuperacao_por_mes");
    if (!error) setPorMes(data || []);

    setCarregando(false);
  }

  if (carregando) {
    return <div style={estilos.container}><Carregando texto="Carregando histórico…" /></div>;
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <h1 style={estilos.titulo}>📊 Histórico da Recuperação</h1>
        <p style={estilos.subtitulo}>Visão de funil — o que já passou pela base e o que já foi recuperado.</p>
      </div>

      <FunilRecuperacao />

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Recuperação por mês</h3>
        {porMes.length === 0 ? (
          <p style={{ color: "var(--rv-texto-fraco)" }}>Ainda não há histórico de mais de um mês.</p>
        ) : (
          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Mês</th>
                <th style={estilos.thNum}>Pagamentos</th>
                <th style={estilos.thNum}>Valor recuperado</th>
              </tr>
            </thead>
            <tbody>
              {porMes.map((m) => (
                <tr key={m.mes}>
                  <td style={estilos.td}>{m.mes}</td>
                  <td style={estilos.tdNum}>{m.qtd}</td>
                  <td style={estilos.tdNum}>{moeda(m.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const estilos = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--rv-fundo)", minHeight: "100%" },
  cabecalho: { marginBottom: 18 },
  titulo: { margin: 0, color: "var(--rv-tinta)", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5 },
  card: { background: "var(--rv-superficie)", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid var(--rv-borda-suave)", marginBottom: 18 },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "var(--rv-tinta)" },
  funil: { display: "flex", height: 26, borderRadius: 8, overflow: "hidden", marginBottom: 14 },
  barraFunil: { minWidth: 4 },
  gridFunil: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 14 },
  itemFunil: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--rv-texto-forte)" },
  pontoLegenda: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  destaque: { fontSize: 13.5, color: "var(--rv-texto)", margin: 0 },
  gridValores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 18 },
  cardValor: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  numeroValor: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "var(--rv-tinta)" },
  labelValor: { fontSize: 12.5, color: "var(--rv-texto-fraco)", fontWeight: 600 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "var(--rv-texto-fraco)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "var(--rv-fundo-cartao)", borderBottom: "1px solid var(--rv-borda)" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "var(--rv-texto-fraco)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "var(--rv-fundo-cartao)", borderBottom: "1px solid var(--rv-borda)" },
  td: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700 },
};
