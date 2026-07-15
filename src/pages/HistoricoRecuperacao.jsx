import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

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
  const [funil, setFunil] = useState({ ativo: 0, recuperado: 0, suspenso: 0, termos: 0, total: 0 });
  const [valorAberto, setValorAberto] = useState(0);
  const [valorRecuperadoTotal, setValorRecuperadoTotal] = useState(0);
  const [porMes, setPorMes] = useState([]);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);

    // Funil por status_jornada.
    const { data: statusData } = await supabase
      .from("alunos")
      .select("status_jornada")
      .limit(20000);

    const contagem = { ativo: 0, recuperado: 0, suspenso: 0, termos: 0, total: 0 };
    for (const a of statusData || []) {
      contagem.total += 1;
      contagem[grupoDoStatus(a.status_jornada)] += 1;
    }
    setFunil(contagem);

    // Valor ainda em aberto (base ativa hoje).
    const { data: casosAbertos } = await supabase
      .from("casos")
      .select("total_em_aberto")
      .not("total_em_aberto", "is", null)
      .gt("total_em_aberto", 0)
      .limit(20000);
    setValorAberto((casosAbertos || []).reduce((s, c) => s + Number(c.total_em_aberto || 0), 0));

    // Valor total ja recuperado (historico completo de pagamentos).
    const { data: pagamentos } = await supabase
      .from("pagamentos")
      .select("valor_pago, data_pagamento")
      .eq("retroativo", false);

    const total = (pagamentos || []).reduce((s, p) => s + Number(p.valor_pago || 0), 0);
    setValorRecuperadoTotal(total);

    const porMesMap = {};
    for (const p of pagamentos || []) {
      const mes = String(p.data_pagamento || "").slice(0, 7);
      if (!mes) continue;
      if (!porMesMap[mes]) porMesMap[mes] = { mes, qtd: 0, valor: 0 };
      porMesMap[mes].qtd += 1;
      porMesMap[mes].valor += Number(p.valor_pago || 0);
    }
    setPorMes(Object.values(porMesMap).sort((a, b) => b.mes.localeCompare(a.mes)).slice(0, 12));

    setCarregando(false);
  }

  const percentualRecuperado = funil.total > 0 ? ((funil.recuperado / funil.total) * 100).toFixed(1) : 0;

  if (carregando) {
    return <div style={estilos.container}>Carregando histórico...</div>;
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <h1 style={estilos.titulo}>📊 Histórico da Recuperação</h1>
        <p style={estilos.subtitulo}>Visão de funil — o que já passou pela base e o que já foi recuperado.</p>
      </div>

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Funil da base ({funil.total.toLocaleString("pt-BR")} alunos)</h3>
        <div style={estilos.funil}>
          <div style={{ ...estilos.barraFunil, background: "#2563eb", flex: funil.ativo || 1 }} title={`Ativo/em tratativa: ${funil.ativo}`} />
          <div style={{ ...estilos.barraFunil, background: "#0f9d6b", flex: funil.recuperado || 1 }} title={`Recuperado: ${funil.recuperado}`} />
          <div style={{ ...estilos.barraFunil, background: "#94a3b8", flex: funil.suspenso || 1 }} title={`Cancelado/Jurídico: ${funil.suspenso}`} />
          <div style={{ ...estilos.barraFunil, background: "#d97706", flex: funil.termos || 1 }} title={`Termos: ${funil.termos}`} />
        </div>

        <div style={estilos.gridFunil}>
          <div style={estilos.itemFunil}>
            <span style={{ ...estilos.pontoLegenda, background: "#2563eb" }} />
            <span><strong>{funil.ativo.toLocaleString("pt-BR")}</strong> Ativo / em tratativa</span>
          </div>
          <div style={estilos.itemFunil}>
            <span style={{ ...estilos.pontoLegenda, background: "#0f9d6b" }} />
            <span><strong>{funil.recuperado.toLocaleString("pt-BR")}</strong> Recuperado / quitado / acordo</span>
          </div>
          <div style={estilos.itemFunil}>
            <span style={{ ...estilos.pontoLegenda, background: "#94a3b8" }} />
            <span><strong>{funil.suspenso.toLocaleString("pt-BR")}</strong> Cancelado / jurídico / suspenso</span>
          </div>
          <div style={estilos.itemFunil}>
            <span style={{ ...estilos.pontoLegenda, background: "#d97706" }} />
            <span><strong>{funil.termos.toLocaleString("pt-BR")}</strong> Fluxo de termos</span>
          </div>
        </div>

        <p style={estilos.destaque}>
          <strong>{percentualRecuperado}%</strong> da base já passou por recuperação/quitação/acordo em algum momento.
        </p>
      </div>

      <div style={estilos.gridValores}>
        <div style={estilos.cardValor}>
          <span style={estilos.numeroValor}>{moeda(valorAberto)}</span>
          <span style={estilos.labelValor}>Ainda em aberto (base ativa hoje)</span>
        </div>
        <div style={{ ...estilos.cardValor, background: "#ecfaf3", borderColor: "#bdeed4" }}>
          <span style={{ ...estilos.numeroValor, color: "#0f7a4f" }}>{moeda(valorRecuperadoTotal)}</span>
          <span style={estilos.labelValor}>Já recuperado (histórico completo)</span>
        </div>
      </div>

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Recuperação por mês</h3>
        {porMes.length === 0 ? (
          <p style={{ color: "#8a93a3" }}>Ainda não há histórico de mais de um mês.</p>
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
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  cabecalho: { marginBottom: 18 },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5 },
  card: { background: "#fff", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid #edf0f5", marginBottom: 18 },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "#0d1321" },
  funil: { display: "flex", height: 26, borderRadius: 8, overflow: "hidden", marginBottom: 14 },
  barraFunil: { minWidth: 4 },
  gridFunil: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 14 },
  itemFunil: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#344054" },
  pontoLegenda: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  destaque: { fontSize: 13.5, color: "#475569", margin: 0 },
  gridValores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 18 },
  cardValor: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  numeroValor: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "#0d1321" },
  labelValor: { fontSize: 12.5, color: "#8a93a3", fontWeight: 600 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700 },
};
