import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

// Espelha os status usados pela gestão em Sugestões Recebidas, com rótulos
// voltados para o operador que enviou a solicitação.
const STATUS = {
  NOVA: { rotulo: "Enviado", bg: "var(--rv-roxo-fundo)", cor: "var(--rv-roxo-texto)" },
  EM_ANALISE: { rotulo: "Em análise", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  EM_TRATATIVA: { rotulo: "Em tratativa", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  AGUARDANDO_VALIDACAO: { rotulo: "Aguardando sua validação", bg: "var(--rv-azul-fundo)", cor: "var(--rv-azul-texto)" },
  REABERTO: { rotulo: "Reaberto", bg: "var(--rv-vermelho-fundo)", cor: "var(--rv-vermelho)" },
  FEITA: { rotulo: "Corrigido", bg: "var(--rv-verde-ok-fundo)", cor: "var(--rv-verde-ok-texto)" },
  DESCARTADA: { rotulo: "Descartado", bg: "var(--rv-fundo-suave)", cor: "var(--rv-texto-suave)" },
};

function formatarData(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR");
}

export default function MinhasSolicitacoes() {
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(null);

  async function carregar() {
    setCarregando(true);
    const { data } = await supabase.rpc("listar_minhas_solicitacoes");
    setLista(data || []);
    setCarregando(false);
  }

  useEffect(() => {
    carregar();
  }, []);

  async function validar(id, ok) {
    let comentario = null;
    if (!ok) {
      comentario = window.prompt("Descreva por que o erro ainda persiste:");
      if (comentario === null) return; // cancelou
    }
    setOcupado(id);
    await supabase.rpc("validar_correcao", { p_id: id, p_ok: ok, p_comentario: comentario });
    setOcupado(null);
    carregar();
  }

  const aguardando = lista.filter((s) => s.status === "AGUARDANDO_VALIDACAO");

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>📌 Minhas Solicitações</h1>
          <p style={S.subtitulo}>Acompanhe o que você enviou pelo botão de Dúvidas e Sugestões. Quando a gestão devolve para validação, confirme se resolveu ou reporte que o erro persiste.</p>
        </div>
        <button style={S.botaoAtualizar} onClick={carregar}>Atualizar</button>
      </div>

      {aguardando.length > 0 && (
        <p style={S.avisoValidar}>
          ⏳ Você tem {aguardando.length} solicitação(ões) <strong>aguardando sua validação</strong>. Confirme se foi resolvido ou reporte que ainda persiste.
        </p>
      )}

      {carregando ? (
        <Carregando texto="Carregando…" />
      ) : lista.length === 0 ? (
        <p style={S.muted}>Você ainda não enviou solicitações.</p>
      ) : (
        lista.map((s) => {
          const st = STATUS[s.status] || STATUS.NOVA;
          const precisaValidar = s.status === "AGUARDANDO_VALIDACAO";
          return (
            <div key={s.id} style={precisaValidar ? { ...S.card, borderColor: "var(--rv-azul-borda)", background: "var(--rv-fundo-cartao)" } : S.card}>
              <div style={S.cardTopo}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ ...S.badge, background: st.bg, color: st.cor }}>{st.rotulo}</span>
                  <span style={S.badgeCinza}>{s.tipo}</span>
                  {s.area && <span style={S.badgeCinza}>{s.area}</span>}
                  {s.prioridade && <span style={S.badgeCinza}>Prioridade: {s.prioridade}</span>}
                  {s.tela && <span style={S.badgeCinza}>{s.tela}</span>}
                </div>
                <span style={S.data}>{formatarData(s.criado_em)}</span>
              </div>

              <p style={S.descricao}>{s.descricao}</p>

              {s.observacao_tratativa && (
                <p style={S.tratativa}>💬 Gestão: {s.observacao_tratativa}</p>
              )}
              {s.retorno_operador && (
                <p style={S.persiste}>❌ Você reportou que persiste: {s.retorno_operador}</p>
              )}

              {precisaValidar && (
                <div style={S.acoes}>
                  <button style={S.botaoConfirmar} disabled={ocupado === s.id} onClick={() => validar(s.id, true)}>
                    ✅ Confirmar que resolveu
                  </button>
                  <button style={S.botaoPersiste} disabled={ocupado === s.id} onClick={() => validar(s.id, false)}>
                    ❌ Ainda persiste
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--rv-fundo)", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  titulo: { margin: 0, color: "var(--rv-tinta)", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5, maxWidth: 620, lineHeight: 1.5 },
  botaoAtualizar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  avisoValidar: { background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)", color: "var(--rv-azul-texto)", borderRadius: 12, padding: "12px 14px", fontSize: 13.5, fontWeight: 600, marginBottom: 16 },
  muted: { color: "var(--rv-texto-fraco)" },
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  cardTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  badge: { fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 999 },
  badgeCinza: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)" },
  data: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  descricao: { fontSize: 13.5, color: "var(--rv-texto-forte)", lineHeight: 1.55, margin: "0 0 10px" },
  tratativa: { margin: "0 0 8px", fontSize: 13, color: "var(--rv-texto)", lineHeight: 1.5, background: "var(--rv-fundo-cartao)", borderRadius: 10, padding: "8px 12px" },
  persiste: { margin: "0 0 8px", fontSize: 13, color: "var(--rv-vermelho-texto)", lineHeight: 1.5, background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 10, padding: "8px 12px" },
  acoes: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 },
  botaoConfirmar: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  botaoPersiste: { background: "var(--rv-superficie)", color: "var(--rv-vermelho)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
};
