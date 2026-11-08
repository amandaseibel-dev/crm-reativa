import { useCallback, useMemo, useState } from "react";
import usePolling from "../utils/polling";
import { doResponsavel, naoLidas, amostraSimulada } from "../utils/ulbraRespostas";
import { lerVistoEm, gravarVistoEm, carregarReal } from "../utils/ulbraRespostasFonte";

// Aviso de "o aluno respondeu" na Mensageria Ulbra.
//
// ETAPA 1: roda com DADOS SIMULADOS, sem nenhuma chamada à Mensageria e sem
// enviar mensagem nenhuma — aliás o MCP não expõe envio. O selo "SIMULADO" na
// tela existe para ninguém confundir amostra com operação. A etapa 2 troca a
// fonte pelo `carregarReal` abaixo, que já está escrito, e liga a fila
// receptiva.
//
// POR QUE O POLLING NÃO É MAIS DE 60s. Esta tela nasceu desmontada de
// propósito: a 60s ela estouraria o limite de 500 chamadas/dia da Mensageria
// (720 só dela). Agora são 10 minutos, com `usePolling`, que pausa em aba
// oculta e atualiza ao voltar o foco. A conta está em
// `orcamentoSincronizacao` (src/utils/ulbraRespostas.js) e em
// docs/integracoes/mensageria-ulbra.md.
const INTERVALO_MS = 10 * 60_000;

export default function NotificacoesUlbra({
  onAssumirLead,
  email = "",
  gestao = false,
  simulado = true,
  carregar,
}) {
  const [itens, setItens] = useState([]);
  const [aberto, setAberto] = useState(false);
  const [vistoEm, setVistoEm] = useState(() => lerVistoEm(email));

  const fonte = useMemo(() => {
    if (carregar) return carregar;
    if (simulado) return async () => amostraSimulada(Date.now(), email || undefined);
    return carregarReal;
  }, [carregar, simulado, email]);

  const buscar = useCallback(async () => {
    try {
      setItens(await fonte());
    } catch {
      // silencioso: a Mensageria fora do ar não pode travar a barra lateral
    }
  }, [fonte]);

  usePolling(buscar, INTERVALO_MS, [fonte], true);

  const meus = useMemo(() => doResponsavel(itens, { email, gestao }), [itens, email, gestao]);
  const novas = useMemo(() => naoLidas(meus, { vistoEm }), [meus, vistoEm]);
  // A lista operacional mostra TODAS as que esperam a Reativa, lidas ou não:
  // um aluno esperando não some da operação só porque alguém já olhou.
  const esperando = useMemo(() => naoLidas(meus, {}), [meus]);

  function alternar() {
    const abrindo = !aberto;
    setAberto(abrindo);
    if (abrindo) {
      // Abrir é ler: o contador zera, a lista continua.
      const agora = new Date().toISOString();
      gravarVistoEm(email, agora);
      setVistoEm(agora);
    }
  }

  if (esperando.length === 0) return null;

  return (
    <div style={S.caixa}>
      <button style={S.btn} onClick={alternar} title="Alunos que responderam na Mensageria Ulbra">
        💬 Responderam
        {novas.length > 0 ? <span style={S.badge}>{novas.length}</span> : null}
      </button>

      {aberto && (
        <div style={S.painel}>
          <div style={S.cabecalho}>
            Esperando a Reativa
            {simulado ? <span style={S.selo}>SIMULADO</span> : null}
          </div>
          {esperando.map((item) => (
            <div key={item.atendimento_id} style={S.linha}>
              <span style={S.nome}>{item.aluno_nome || "Sem nome"}</span>
              <button
                style={S.assumir}
                onClick={() => {
                  onAssumirLead?.(item);
                  setAberto(false);
                }}
              >
                Assumir
              </button>
            </div>
          ))}
          <div style={S.rodape}>
            Sinal de estado, não leitura de conversa: a Mensageria não expõe
            mensagens. Para ler, abra o cadastro na Mensageria.
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  caixa: { position: "relative", marginTop: 10, padding: "0 10px" },
  btn: { position: "relative", width: "100%", background: "transparent", border: "1px solid rgba(148,163,184,0.3)", color: "#93c5fd", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  badge: { position: "absolute", top: -6, right: -6, background: "#dc2626", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" },
  painel: { position: "absolute", left: 10, right: 10, bottom: "calc(100% + 6px)", background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-forte)", borderRadius: 10, boxShadow: "0 10px 30px rgba(2,6,23,0.35)", zIndex: 50, overflow: "hidden" },
  cabecalho: { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", fontSize: 11, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)" },
  selo: { background: "var(--rv-ambar-texto)", color: "#fff", borderRadius: 999, padding: "1px 7px", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.06em" },
  linha: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 10px" },
  nome: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  assumir: { background: "var(--rv-superficie)", color: "var(--rv-azul-texto)", border: "1px solid var(--rv-azul-borda)", borderRadius: 8, padding: "4px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  rodape: { padding: "8px 10px", fontSize: 10.5, lineHeight: 1.4, color: "var(--rv-texto-fraco)", borderTop: "1px solid var(--rv-borda-suave)" },
};
