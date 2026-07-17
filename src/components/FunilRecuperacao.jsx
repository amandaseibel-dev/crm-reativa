import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function FunilRecuperacao() {
  const [carregando, setCarregando] = useState(true);
  const [funil, setFunil] = useState(null);
  const [acordos, setAcordos] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    const [{ data: funilData, error: erroFunil }, { data: acordosData }] = await Promise.all([
      supabase.rpc("funil_historico_recuperacao"),
      supabase.rpc("metricas_acordos"),
    ]);
    if (!erroFunil) setFunil(funilData);
    setAcordos(acordosData);
    setCarregando(false);
  }

  if (carregando || !funil) {
    return null;
  }

  const percentualRecuperado = funil.total > 0 ? ((funil.recuperado / funil.total) * 100).toFixed(1) : 0;

  return (
    <div style={estilos.card}>
      <h3 style={estilos.tituloBloco}>📊 Funil da base — o que já passou e o que já foi recuperado</h3>

      <div style={estilos.funilBarra}>
        <div style={{ ...estilos.barraFunil, background: "#2563eb", flex: funil.ativo || 1 }} title={`Ativo/em tratativa: ${funil.ativo}`} />
        <div style={{ ...estilos.barraFunil, background: "#1e40af", flex: funil.recuperado || 1 }} title={`Recuperado: ${funil.recuperado}`} />
        <div style={{ ...estilos.barraFunil, background: "#94a3b8", flex: funil.suspenso || 1 }} title={`Cancelado/Jurídico: ${funil.suspenso}`} />
        <div style={{ ...estilos.barraFunil, background: "#d97706", flex: funil.termos || 1 }} title={`Termos: ${funil.termos}`} />
      </div>

      <div style={estilos.gridFunil}>
        <div style={estilos.itemFunil}>
          <span style={{ ...estilos.pontoLegenda, background: "#2563eb" }} />
          <span><strong>{(funil.ativo || 0).toLocaleString("pt-BR")}</strong> Ativo / em tratativa</span>
        </div>
        <div style={estilos.itemFunil}>
          <span style={{ ...estilos.pontoLegenda, background: "#1e40af" }} />
          <span><strong>{(funil.recuperado || 0).toLocaleString("pt-BR")}</strong> Recuperado / quitado / acordo</span>
        </div>
        <div style={estilos.itemFunil}>
          <span style={{ ...estilos.pontoLegenda, background: "#94a3b8" }} />
          <span><strong>{(funil.suspenso || 0).toLocaleString("pt-BR")}</strong> Cancelado / jurídico</span>
        </div>
        <div style={estilos.itemFunil}>
          <span style={{ ...estilos.pontoLegenda, background: "#d97706" }} />
          <span><strong>{(funil.termos || 0).toLocaleString("pt-BR")}</strong> Fluxo de termos</span>
        </div>
      </div>

      <div style={estilos.gridValores}>
        <div style={estilos.cardValor}>
          <span style={estilos.numeroValor}>{moeda(funil.valor_aberto)}</span>
          <span style={estilos.labelValor}>Ainda em aberto (base ativa hoje)</span>
        </div>
        <div style={{ ...estilos.cardValor, background: "#eff6ff", borderColor: "#c7d7fe" }}>
          <span style={{ ...estilos.numeroValor, color: "#0f7a4f" }}>{moeda(funil.valor_recuperado_total)}</span>
          <span style={estilos.labelValor}>Já recuperado (histórico completo)</span>
        </div>
      </div>

      <p style={estilos.destaque}>
        <strong>{percentualRecuperado}%</strong> da base já passou por recuperação/quitação/acordo em algum momento.{" "}
        <a href="/historico-recuperacao" style={estilos.link}>Ver detalhes mês a mês →</a>
      </p>

      {acordos && (
        <div style={estilos.gridValores}>
          <div style={estilos.cardValor}>
            <span style={estilos.numeroValor}>{acordos.novos_no_mes}</span>
            <span style={estilos.labelValor}>Novos acordos este mês ({moeda(acordos.valor_novos_no_mes)})</span>
          </div>
          <div style={{ ...estilos.cardValor, background: acordos.em_atraso > 0 ? "#fef7f0" : undefined, borderColor: acordos.em_atraso > 0 ? "#fde3cc" : undefined }}>
            <span style={{ ...estilos.numeroValor, color: acordos.em_atraso > 0 ? "#c2410c" : undefined }}>
              {acordos.em_atraso}
            </span>
            <span style={estilos.labelValor}>Acordos com parcela em atraso ({moeda(acordos.valor_em_atraso)})</span>
          </div>
          <div style={estilos.cardValor}>
            <span style={estilos.numeroValor}>{acordos.ativos_total}</span>
            <span style={estilos.labelValor}>Total de acordos ativos</span>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
    border: "1px solid #edf0f5",
    marginBottom: 18,
  },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "#0d1321" },
  funilBarra: { display: "flex", height: 24, borderRadius: 8, overflow: "hidden", marginBottom: 14 },
  barraFunil: { minWidth: 4 },
  gridFunil: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 14 },
  itemFunil: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#344054" },
  pontoLegenda: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  gridValores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 14 },
  cardValor: { background: "#f8fafc", border: "1px solid #edf0f5", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 },
  numeroValor: { fontFamily: FONTE_TITULO, fontSize: 20, fontWeight: 800, color: "#0d1321" },
  labelValor: { fontSize: 11.5, color: "#8a93a3", fontWeight: 600 },
  destaque: { fontSize: 13, color: "#475569", margin: 0 },
  link: { color: "#1e40af", fontWeight: 700, textDecoration: "none" },
};
